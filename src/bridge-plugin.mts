import type { Plugin } from "@opencode-ai/plugin";
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool";
import type { PermissionRule } from "@opencode-ai/sdk/v2/client";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isWithinRoot, resolveRealPathForComparison } from "./path-permission.js";

const BRIDGE_URL_ENV = "OPENCODE_VSCODE_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "OPENCODE_VSCODE_BRIDGE_TOKEN";
const BRIDGE_TOKEN_HEADER = "x-opencode-vscode-bridge-token";
const WORKSPACE_ROOTS_ENV = "OPENCODE_VSCODE_WORKSPACE_ROOTS";
const bridgePlugin: Plugin = async () => {
  return {
    tool: {
      edit: tool({
        description: "Bridge OpenCode edit calls into the VS Code extension review queue.",
        args: {
          filePath: tool.schema.string(),
          oldString: tool.schema.string(),
          newString: tool.schema.string(),
          replaceAll: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          return bridgeRequest("edit", args, context);
        },
      }),
      write: tool({
        description: "Bridge OpenCode write calls into the VS Code extension review queue.",
        args: {
          content: tool.schema.string(),
          filePath: tool.schema.string(),
        },
        async execute(args, context) {
          return bridgeRequest("write", args, context);
        },
      }),
      apply_patch: tool({
        description: "Bridge OpenCode apply_patch calls into the VS Code extension review queue.",
        args: {
          patchText: tool.schema.string(),
        },
        async execute(args, context) {
          return bridgeRequest("apply_patch", args, context);
        },
      }),
    },
  };
};

export default bridgePlugin;

async function bridgeRequest(toolName: "edit" | "write" | "apply_patch", payload: unknown, context: ToolContext): Promise<ToolResult> {
  const bridgeUrl = process.env[BRIDGE_URL_ENV];
  const bridgeToken = process.env[BRIDGE_TOKEN_ENV];
  if (!bridgeUrl || !bridgeToken) {
    throw new Error("VS Code bridge is not configured. Launch OpenCode from the OpenCode TUI Integration extension.");
  }

  const permission = toolName === "apply_patch"
    ? await readApplyPatchPermissions(payload, context)
    : await readDirectEditPermissions(toolName, payload, context);

  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [BRIDGE_TOKEN_HEADER]: bridgeToken,
    },
    body: JSON.stringify({
      tool: toolName,
      payload,
      directory: context.directory,
      worktree: context.worktree,
      sessionID: typeof context.sessionID === "string" ? context.sessionID : undefined,
      permission,
    }),
    signal: context.abort,
  });

  const rawBody = await response.text();
  let body:
    | { ok: true; result: { output: string; metadata?: Record<string, unknown> } }
    | { ok: false; error?: string }
    | undefined;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody) as
        | { ok: true; result: { output: string; metadata?: Record<string, unknown> } }
        | { ok: false; error?: string };
    } catch {
      body = undefined;
    }
  }

  if (!response.ok || !body?.ok) {
    const errorMessage = body && "error" in body && body.error
      ? body.error
      : rawBody || `VS Code bridge ${toolName} request failed with HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return {
    output: body.result.output,
    metadata: body.result.metadata,
  };
}

async function readDirectEditPermissions(toolName: "edit" | "write", payload: unknown, context: ToolContext) {
  const targetPath = directEditTargetPath(payload, context.directory, context.worktree);
  if (!targetPath) {
    return undefined;
  }

  const patterns = [targetPath];
  await askPermission(context, {
    permission: "edit",
    patterns,
    always: patterns,
    metadata: {
      tool: toolName,
      paths: patterns,
    },
  });

  if (!isExternalRealPath(targetPath, context.directory, context.worktree)) {
    return undefined;
  }

  await askExternalDirectoryPermission(context, [targetPath]);

  return patterns.map((pattern): PermissionRule => ({
    permission: "edit",
    pattern,
    action: "allow",
  })).concat(externalDirectoryRules([targetPath]));
}

function directEditTargetPath(payload: unknown, directory: string, worktree: string) {
  if (!payload || typeof payload !== "object" || !("filePath" in payload) || typeof payload.filePath !== "string") {
    return undefined;
  }

  const resolvedPath = resolveDirectEditPermissionPath(directory, worktree, payload.filePath);
  return resolveRealPathForComparison(resolvedPath);
}

function resolveDirectEditPermissionPath(directory: string, worktree: string, filePath: string) {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }

  const directPath = path.resolve(directory, filePath);
  if (workspaceRootForPath(directPath)) {
    return directPath;
  }

  const worktreePath = path.resolve(worktree, filePath);
  if (workspaceRootForPath(worktreePath)) {
    return worktreePath;
  }

  const existingWorkspaceCandidates = workspaceRoots()
    .map((root) => path.resolve(root, filePath))
    .filter((candidate) => existsSync(candidate));
  if (existingWorkspaceCandidates.length === 1) {
    return existingWorkspaceCandidates[0];
  }

  if (existingWorkspaceCandidates.length > 1) {
    throw new Error(`Bridge request has ambiguous relative path across workspace folders: ${filePath}`);
  }

  const roots = workspaceRoots();
  if (roots.length === 1) {
    return path.resolve(roots[0], filePath);
  }

  if (roots.length > 1) {
    throw new Error(`Bridge request has ambiguous relative path across workspace folders: ${filePath}`);
  }

  return directPath;
}

async function readApplyPatchPermissions(payload: unknown, context: ToolContext) {
  const patterns = applyPatchTargetPaths(payload, context.directory, context.worktree);
  if (patterns.length === 0) {
    return undefined;
  }

  await askPermission(context, {
    permission: "edit",
    patterns,
    always: patterns,
    metadata: {
      tool: "apply_patch",
      paths: patterns,
    },
  });

  const externalPatterns = patterns.filter((pattern) => isExternalRealPath(pattern, context.directory, context.worktree));
  if (externalPatterns.length === 0) {
    return undefined;
  }

  await askExternalDirectoryPermission(context, externalPatterns);

  return externalPatterns.map((pattern): PermissionRule => ({
    permission: "apply_patch",
    pattern,
    action: "allow",
  })).concat(externalDirectoryRules(externalPatterns));
}

async function askPermission(context: ToolContext, input: Parameters<ToolContext["ask"]>[0]) {
  const request = context.ask(input) as unknown;
  if (request && typeof (request as PromiseLike<void>).then === "function") {
    await request;
    return;
  }

  const { Effect } = await import("effect");
  await Effect.runPromise(request as Parameters<typeof Effect.runPromise>[0]);
}

async function askExternalDirectoryPermission(context: ToolContext, filePaths: string[]) {
  const patterns = externalDirectoryPatterns(filePaths);
  if (patterns.length === 0) {
    return;
  }

  await askPermission(context, {
    permission: "external_directory",
    patterns,
    always: patterns.map((pattern) => `${pattern.slice(0, -1)}**`),
    metadata: {
      tool: "external_directory",
      paths: filePaths,
    },
  });
}

function externalDirectoryPatterns(filePaths: string[]) {
  const patterns: string[] = [];
  for (const filePath of filePaths) {
    const pattern = `${path.dirname(filePath)}${path.sep}*`;
    if (!patterns.includes(pattern)) {
      patterns.push(pattern);
    }
  }

  return patterns;
}

function externalDirectoryRules(filePaths: string[]): PermissionRule[] {
  return externalDirectoryPatterns(filePaths).map((pattern) => ({
    permission: "external_directory",
    pattern,
    action: "allow",
  }));
}

function applyPatchTargetPaths(payload: unknown, directory: string, worktree: string) {
  if (!payload || typeof payload !== "object" || !("patchText" in payload) || typeof payload.patchText !== "string") {
    return [];
  }

  const paths: string[] = [];
  for (const line of payload.patchText.split(/\r?\n/)) {
    const path = applyPatchPathFromLine(line, "*** Add File: ")
      ?? applyPatchPathFromLine(line, "*** Update File: ")
      ?? applyPatchPathFromLine(line, "*** Delete File: ")
      ?? applyPatchPathFromLine(line, "*** Move to: ");
    const resolvedPath = path ? resolveApplyPatchPermissionPath(directory, worktree, path) : undefined;
    if (resolvedPath && !paths.includes(resolvedPath)) {
      paths.push(resolvedPath);
    }
  }

  return paths;
}

function resolveApplyPatchPermissionPath(directory: string, worktree: string, filePath: string) {
  if (path.isAbsolute(filePath)) {
    return resolveRealPathForComparison(filePath);
  }

  const directPath = path.resolve(directory, filePath);
  const worktreePath = path.resolve(worktree, filePath);
  const directWorkspaceRoot = workspaceRootForPath(directPath);
  const worktreeWorkspaceRoot = workspaceRootForPath(worktreePath);
  if (!directWorkspaceRoot && !worktreeWorkspaceRoot) {
    return resolveRealPathForComparison(directPath);
  }
  if (directPath === worktreePath || existsSync(directPath)) {
    return resolveRealPathForComparison(directPath);
  }
  if (directWorkspaceRoot) {
    return resolveRealPathForComparison(directPath);
  }
  if (worktreeWorkspaceRoot) {
    return resolveRealPathForComparison(worktreePath);
  }
  if (existsSync(worktreePath)) {
    return resolveRealPathForComparison(worktreePath);
  }

  return resolveRealPathForComparison(directPath);
}

function applyPatchPathFromLine(line: string, prefix: string) {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined;
}

function workspaceRootForPath(filePath: string) {
  const realPath = resolveRealPathForComparison(filePath);
  return workspaceRoots().find((root) => isWithinRoot(realPath, resolveRealPathForComparison(root)));
}

function isExternalRealPath(realPath: string, directory: string, worktree: string) {
  const trustedRoots = [directory, worktree, ...workspaceRoots()].map((root) => resolveRealPathForComparison(root));
  return !trustedRoots.some((root) => isWithinRoot(realPath, root));
}

function workspaceRoots() {
  const rawRoots = process.env[WORKSPACE_ROOTS_ENV];
  if (!rawRoots) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawRoots) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((root): root is string => typeof root === "string").map((root) => path.resolve(root))
      : [];
  } catch {
    return [];
  }
}
