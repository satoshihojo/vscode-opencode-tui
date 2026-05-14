import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import tuiSessionPlugin from "../../src/tui-session-plugin.js";

type CurrentRoute = {
  name: string;
  params?: Record<string, unknown>;
};

type FakeResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

describe("TUI session plugin", () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalUrl = process.env.OPENCODE_VSCODE_BRIDGE_URL;
  const originalToken = process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
  const originalOpenCodePort = process.env._EXTENSION_OPENCODE_PORT;
  let intervalHandlers: Array<() => void> = [];
  let clearedIntervals: unknown[] = [];

  beforeEach(() => {
    intervalHandlers = [];
    clearedIntervals = [];
    process.env.OPENCODE_VSCODE_BRIDGE_URL = "http://127.0.0.1:9000/bridge";
    process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = "secret";
    process.env._EXTENSION_OPENCODE_PORT = "9001";
    globalThis.setInterval = ((handler: () => void) => {
      intervalHandlers.push(handler);
      return intervalHandlers.length as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((handle: unknown) => {
      clearedIntervals.push(handle);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    restoreEnv("OPENCODE_VSCODE_BRIDGE_URL", originalUrl);
    restoreEnv("OPENCODE_VSCODE_BRIDGE_TOKEN", originalToken);
    restoreEnv("_EXTENSION_OPENCODE_PORT", originalOpenCodePort);
  });

  it("posts deduped active session route changes to the VS Code bridge", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "home" };
    const disposers: Array<() => void> = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      state: {
        session: {
          messages(sessionId: string) {
            return [
              { title: sessionId === "ses_first" ? "First Session" : "Second Session" },
              { timeUpdated: sessionId === "ses_first" ? 10 : 20 },
            ];
          },
        },
      },
      lifecycle: {
        onDispose(dispose: () => void) {
          disposers.push(dispose);
        },
      },
    });

    assert.equal(intervalHandlers.length, 1);
    assert.equal(requests.length, 0);

    currentRoute = { name: "session", params: { sessionID: "ses_first" } };
    intervalHandlers[0]?.();
    intervalHandlers[0]?.();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "http://127.0.0.1:9000/bridge");
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      type: "tui.session.active",
      sessionID: "ses_first",
      openCodePort: 9001,
      title: "First Session",
      updated: 10,
      activationTimestamp: JSON.parse(String(requests[0]?.init.body)).activationTimestamp,
    });
    assert.equal(typeof JSON.parse(String(requests[0]?.init.body)).activationTimestamp, "number");
    assert.deepEqual(requests[0]?.init.headers, {
      "content-type": "application/json",
      "x-opencode-vscode-bridge-token": "secret",
    });

    currentRoute = { name: "settings" };
    intervalHandlers[0]?.();
    currentRoute = { name: "session", params: { sessionID: "ses_second" } };
    intervalHandlers[0]?.();

    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
      type: "tui.session.active",
      sessionID: "ses_second",
      openCodePort: 9001,
      title: "Second Session",
      updated: 20,
      activationTimestamp: JSON.parse(String(requests[1]?.init.body)).activationTimestamp,
    });

    disposers[0]?.();
    assert.deepEqual(clearedIntervals, [1]);
  });

  it("uses the rendered sidebar title when session messages do not expose metadata", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "home" };
    let sidebarTitle: ((input: { session_id: string; title?: string }) => unknown) | undefined;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      state: {
        session: {
          messages() {
            return [];
          },
        },
      },
      slots: {
        register(plugin) {
          sidebarTitle = plugin.sidebar_title;
        },
      },
    });

    sidebarTitle?.({ session_id: "ses_sidebar", title: "Sidebar Rendered Title" });
    currentRoute = { name: "session", params: { sessionID: "ses_sidebar" } };
    intervalHandlers[0]?.();

    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      type: "tui.session.active",
      sessionID: "ses_sidebar",
      openCodePort: 9001,
      title: "Sidebar Rendered Title",
      activationTimestamp: JSON.parse(String(requests[0]?.init.body)).activationTimestamp,
    });
  });

  it("posts active sessions from rendered TUI slots when the route is not updated yet", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let sidebarContent: ((input: { session_id: string }) => unknown) | undefined;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        current: { name: "home" },
      },
      state: {
        session: {
          messages() {
            return [{ title: "Rendered Session" }];
          },
        },
      },
      slots: {
        register(plugin) {
          sidebarContent = plugin.sidebar_content;
        },
      },
    });

    sidebarContent?.({ session_id: "ses_rendered" });

    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      type: "tui.session.active",
      sessionID: "ses_rendered",
      openCodePort: 9001,
      title: "Rendered Session",
      activationTimestamp: JSON.parse(String(requests[0]?.init.body)).activationTimestamp,
    });
  });

  it("detects session ids from /sessions route parameter variants", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "sessions", params: { sessionId: "ses_lowercase" } };
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();

    assert.equal(JSON.parse(String(requests[0]?.init.body)).sessionID, "ses_lowercase");

    currentRoute = { name: "sessions", params: { id: "ses_short_id" } };
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(JSON.parse(String(requests[1]?.init.body)).sessionID, "ses_short_id");

    currentRoute = { name: "sessions", params: { session: { id: "ses_nested" } } };
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(JSON.parse(String(requests[2]?.init.body)).sessionID, "ses_nested");
  });

  it("reposts the same session after leaving and re-entering the route", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_repeat" } };
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();

    currentRoute = { name: "home" };
    intervalHandlers[0]?.();
    currentRoute = { name: "session", params: { sessionID: "ses_repeat" } };
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(requests.length, 2);
  });

  it("does not post when bridge environment is incomplete", async () => {
    const requests: unknown[] = [];
    delete process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_first" } };
    globalThis.fetch = async (...args) => {
      requests.push(args);
      throw new Error("fetch should not be called");
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });

    assert.equal(intervalHandlers.length, 1);
    assert.deepEqual(requests, []);
  });

  it("retries the same active session route after a failed bridge post", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_retry" } };
    let throwNetworkError = true;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (throwNetworkError) {
        throw new Error("bridge unavailable");
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ ok: true, result: { output: "", metadata: {} } });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();
    assert.equal(requests.length, 1);

    intervalHandlers[0]?.();
    await Promise.resolve();
    assert.equal(requests.length, 2);

    throwNetworkError = false;
    intervalHandlers[0]?.();
    await Promise.resolve();
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(requests.length, 3);
  });

  it("retries explicit bridge retry acknowledgements for the same route", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_wait" } };
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: false,
        status: 409,
        async text() {
          return JSON.stringify({ ok: false, error: "retry" });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(requests.length, 2);
  });

  it("does not retry non-retryable bridge failures for the same route", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_bad" } };
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ ok: false, error: "invalid" });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(requests.length, 1);
  });

  it("retries transient bridge server failures for the same route", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let currentRoute: CurrentRoute = { name: "session", params: { sessionID: "ses_server_error" } };
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return {
        ok: false,
        status: 503,
        async text() {
          return JSON.stringify({ ok: false, error: "unavailable" });
        },
      } as FakeResponse as Response;
    };

    await tuiSessionPlugin.tui({
      route: {
        get current() {
          return currentRoute;
        },
      },
      lifecycle: {
        onDispose() {},
      },
    });
    await Promise.resolve();
    intervalHandlers[0]?.();
    await Promise.resolve();

    assert.equal(requests.length, 2);
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
