import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import path from "node:path";

type FakeResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

function platformPath(value: string) {
  if (path.sep === "/") {
    return value;
  }

  if (value === "/workspace") {
    return "C:\\workspace";
  }

  return value
    .replace(/^\/workspace/, "C:\\workspace")
    .replace(/^\/outside/, "D:\\outside")
    .replace(/^\/external/, "D:\\external")
    .replace(/^\/proc/, "C:\\proc")
    .replaceAll("/", "\\");
}

function contextPath(value: string) {
  return platformPath(value);
}

function permissionPattern(value: string) {
  return platformPath(value);
}

function stripTrailingSeparator(value: string) {
  return value.replace(/[\\/]+$/, "");
}

function externalAlwaysPattern(value: string) {
  return `${stripTrailingSeparator(permissionPattern(value))}${path.sep === "/" ? "/**" : "\\**"}`;
}

function externalSingleLevelPattern(value: string) {
  return `${stripTrailingSeparator(permissionPattern(value))}${path.sep === "/" ? "/*" : "\\*"}`;
}

const workspaceRoot = contextPath("/workspace");
const outsideAllowedFile = permissionPattern("/outside/allowed/file.ts");
const outsideAllowedDirectory = permissionPattern("/outside/allowed/");
const outsideEffectTarget = permissionPattern("/outside/effect-target.ts");
const outsideFile = permissionPattern("/outside/file.ts");
const traversalOutsideFile = path.resolve(workspaceRoot, "src/../../outside/file.ts");
const traversalOutsideDirectory = `${path.dirname(traversalOutsideFile)}${path.sep}`;
const workspaceSrcFile = permissionPattern("/workspace/src/file.ts");

function createToolContext(directory: string, worktree = directory) {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error("unexpected permission request");
    },
  };
}

function createToolContextWithAsk(
  directory: string,
  ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => void,
  worktree = directory,
) {
  return {
    ...createToolContext(directory, worktree),
    ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) {
      return Promise.resolve().then(() => ask(input));
    },
  };
}

describe("bridge plugin", () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.OPENCODE_VSCODE_BRIDGE_URL;
  const originalToken = process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
  const originalWorkspaceRoots = process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS;

  beforeEach(() => {
    process.env.OPENCODE_VSCODE_BRIDGE_URL = "http://127.0.0.1:9000/bridge";
    process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = "secret";
    delete process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.OPENCODE_VSCODE_BRIDGE_URL;
    } else {
      process.env.OPENCODE_VSCODE_BRIDGE_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
    } else {
      process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = originalToken;
    }
    if (originalWorkspaceRoots === undefined) {
      delete process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS;
    } else {
      process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }
  });

  it("surfaces raw non-json bridge failures", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      async text() {
        return "Bad Gateway";
      },
    } as FakeResponse as Response);

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await assert.rejects(
      plugin.tool.write.execute(
        { content: "x", filePath: "a.ts" },
        createToolContextWithAsk("/workspace", () => undefined) as never,
      ),
      /Bad Gateway/,
    );
  });

  it("sends the source OpenCode session id with bridge requests", async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.write.execute(
      { content: "x", filePath: "a.ts" },
      createToolContextWithAsk("/workspace", () => undefined) as never,
    );

    assert.deepEqual(requestBody, {
      tool: "write",
      payload: { content: "x", filePath: "a.ts" },
      directory: "/workspace",
      worktree: "/workspace",
      sessionID: "ses_test",
    });
  });

  it("asks native edit permission before forwarding absolute edit targets", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.edit.execute(
      { filePath: outsideAllowedFile, oldString: "old", newString: "new" },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [outsideAllowedFile],
        always: [outsideAllowedFile],
        metadata: {
          tool: "edit",
          paths: [outsideAllowedFile],
        },
      },
      {
        permission: "external_directory",
        patterns: [externalSingleLevelPattern(outsideAllowedDirectory)],
        always: [externalAlwaysPattern(outsideAllowedDirectory)],
        metadata: {
          tool: "external_directory",
          paths: [outsideAllowedFile],
        },
      },
    ]);
    assert.deepEqual(requestBody, {
      tool: "edit",
      payload: { filePath: outsideAllowedFile, oldString: "old", newString: "new" },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      sessionID: "ses_test",
      permission: [
        {
          permission: "edit",
          pattern: outsideAllowedFile,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(outsideAllowedDirectory),
          action: "allow",
        },
      ],
    });
  });

  it("runs native ask effects before forwarding external edit targets", async () => {
    const { Effect } = await import("effect");
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.edit.execute(
      { filePath: outsideEffectTarget, oldString: "hi", newString: "hello" },
      {
        ...createToolContext(workspaceRoot),
        ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) {
          return Effect.sync(() => askInputs.push(input));
        },
      } as never,
    );

    assert.equal(askInputs.length, 2);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, [
        {
          permission: "edit",
          pattern: outsideEffectTarget,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(permissionPattern("/outside/")),
          action: "allow",
        },
    ]);
  });

  it("asks native edit permission before forwarding traversal edit targets", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.edit.execute(
      { filePath: "src/../../outside/file.ts", oldString: "old", newString: "new" },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [traversalOutsideFile],
        always: [traversalOutsideFile],
        metadata: {
          tool: "edit",
          paths: [traversalOutsideFile],
        },
      },
      {
        permission: "external_directory",
        patterns: [externalSingleLevelPattern(traversalOutsideDirectory)],
        always: [externalAlwaysPattern(traversalOutsideDirectory)],
        metadata: {
          tool: "external_directory",
          paths: [traversalOutsideFile],
        },
      },
    ]);
    assert.deepEqual(requestBody, {
      tool: "edit",
      payload: { filePath: "src/../../outside/file.ts", oldString: "old", newString: "new" },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      sessionID: "ses_test",
      permission: [
        {
          permission: "edit",
          pattern: traversalOutsideFile,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(traversalOutsideDirectory),
          action: "allow",
        },
      ],
    });
  });

  it("asks native edit permission before forwarding absolute write targets", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.write.execute(
      { filePath: outsideAllowedFile, content: "new" },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [outsideAllowedFile],
        always: [outsideAllowedFile],
        metadata: {
          tool: "write",
          paths: [outsideAllowedFile],
        },
      },
      {
        permission: "external_directory",
        patterns: [externalSingleLevelPattern(outsideAllowedDirectory)],
        always: [externalAlwaysPattern(outsideAllowedDirectory)],
        metadata: {
          tool: "external_directory",
          paths: [outsideAllowedFile],
        },
      },
    ]);
    assert.deepEqual(requestBody, {
      tool: "write",
      payload: { filePath: outsideAllowedFile, content: "new" },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      sessionID: "ses_test",
      permission: [
        {
          permission: "edit",
          pattern: outsideAllowedFile,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(outsideAllowedDirectory),
          action: "allow",
        },
      ],
    });
  });

  it("asks native edit permission before forwarding workspace-relative edit targets", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
      },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.edit.execute(
      { filePath: "src/file.ts", oldString: "old", newString: "new" },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [workspaceSrcFile],
        always: [workspaceSrcFile],
        metadata: {
          tool: "edit",
          paths: [workspaceSrcFile],
        },
      },
    ]);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, undefined);
  });

  it("asks native edit permission when relative edit resolves through the worktree", async () => {
    const askInputs: unknown[] = [];
    process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS = JSON.stringify([workspaceRoot]);
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
      },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.edit.execute(
      { filePath: "src/file.ts", oldString: "old", newString: "new" },
      createToolContextWithAsk(contextPath("/proc"), (input) => askInputs.push(input), workspaceRoot) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [workspaceSrcFile],
        always: [workspaceSrcFile],
        metadata: {
          tool: "edit",
          paths: [workspaceSrcFile],
        },
      },
    ]);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, undefined);
  });

  it("asks native edit permission before forwarding apply_patch", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.apply_patch.execute(
      {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${outsideAllowedFile}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [outsideAllowedFile],
        always: [outsideAllowedFile],
        metadata: {
          tool: "apply_patch",
          paths: [outsideAllowedFile],
        },
      },
      {
        permission: "external_directory",
        patterns: [externalSingleLevelPattern(outsideAllowedDirectory)],
        always: [externalAlwaysPattern(outsideAllowedDirectory)],
        metadata: {
          tool: "external_directory",
          paths: [outsideAllowedFile],
        },
      },
    ]);
    assert.deepEqual(requestBody, {
      tool: "apply_patch",
      payload: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${outsideAllowedFile}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      sessionID: "ses_test",
      permission: [
        {
          permission: "apply_patch",
          pattern: outsideAllowedFile,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(outsideAllowedDirectory),
          action: "allow",
        },
      ],
    });
  });

  it("does not treat session read permission as apply_patch approval", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.apply_patch.execute(
      {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${outsideAllowedFile}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      createToolContextWithAsk(workspaceRoot, (input) => askInputs.push(input)) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [outsideAllowedFile],
        always: [outsideAllowedFile],
        metadata: {
          tool: "apply_patch",
          paths: [outsideAllowedFile],
        },
      },
      {
        permission: "external_directory",
        patterns: [externalSingleLevelPattern(outsideAllowedDirectory)],
        always: [externalAlwaysPattern(outsideAllowedDirectory)],
        metadata: {
          tool: "external_directory",
          paths: [outsideAllowedFile],
        },
      },
    ]);
    assert.deepEqual(requestBody, {
      tool: "apply_patch",
      payload: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${outsideAllowedFile}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      sessionID: "ses_test",
      permission: [
        {
          permission: "apply_patch",
          pattern: outsideAllowedFile,
          action: "allow",
        },
        {
          permission: "external_directory",
          pattern: externalSingleLevelPattern(outsideAllowedDirectory),
          action: "allow",
        },
      ],
    });
  });

  it("does not forward apply_patch when native permission is denied", async () => {
    let didBridgeFetch = false;
    globalThis.fetch = async () => {
      didBridgeFetch = true;
      throw new Error("unexpected bridge request");
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await assert.rejects(
      plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: /outside/allowed/file.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContextWithAsk("/workspace", () => {
          throw new Error("permission denied");
        }) as never,
      ),
      /permission denied/,
    );

    assert.equal(didBridgeFetch, false);
  });

  it("asks permission for the worktree target when relative apply_patch resolves inside the worktree", async () => {
    const askInputs: unknown[] = [];
    process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS = JSON.stringify([workspaceRoot]);
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
      },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.apply_patch.execute(
      {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/file.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      createToolContextWithAsk(contextPath("/tmp"), (input) => askInputs.push(input), workspaceRoot) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [workspaceSrcFile],
        always: [workspaceSrcFile],
        metadata: {
          tool: "apply_patch",
          paths: [workspaceSrcFile],
        },
      },
    ]);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, undefined);
  });

  it("asks permission for direct relative add patches inside an outside session root", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
      },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.apply_patch.execute(
      {
        patchText: [
          "*** Begin Patch",
          "*** Add File: new-file.ts",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      createToolContextWithAsk(contextPath("/external/session"), (input) => askInputs.push(input), contextPath("/external/worktree")) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [permissionPattern("/external/session/new-file.ts")],
        always: [permissionPattern("/external/session/new-file.ts")],
        metadata: {
          tool: "apply_patch",
          paths: [permissionPattern("/external/session/new-file.ts")],
        },
      },
    ]);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, undefined);
  });

  it("asks permission for direct relative update patches inside an outside session root", async () => {
    const askInputs: unknown[] = [];
    let requestBody: unknown;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, result: { output: "queued", metadata: {} } });
      },
      } as FakeResponse as Response;
    };

    const { default: bridgePlugin } = await import("../../src/bridge-plugin.mjs");
    const plugin = await bridgePlugin({} as never);
    assert.ok(plugin.tool);

    await plugin.tool.apply_patch.execute(
      {
        patchText: [
          "*** Begin Patch",
          "*** Update File: package.json",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      createToolContextWithAsk(contextPath("/proc"), (input) => askInputs.push(input), path.resolve("/home/vuht26j/node/projects/opencode-tui-integration")) as never,
    );

    assert.deepEqual(askInputs, [
      {
        permission: "edit",
        patterns: [permissionPattern("/proc/package.json")],
        always: [permissionPattern("/proc/package.json")],
        metadata: {
          tool: "apply_patch",
          paths: [permissionPattern("/proc/package.json")],
        },
      },
    ]);
    assert.deepEqual((requestBody as { permission?: unknown }).permission, undefined);
  });
});
