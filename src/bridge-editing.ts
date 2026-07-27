import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { createTwoFilesPatch, diffLines } from "diff";
import { deriveNewContentsFromChunks, parsePatch } from "./apply-patch";
import type { BridgePermissionRule, BridgeRequest } from "./bridge-protocol";
import { toDisplayPathForFile } from "./display-path";
import { isWithinRoot, matchesPermissionPattern, resolveRealPathForComparison } from "./path-permission";
import { parseWslUncPath } from "./opencode/command";
import { toWorkspaceUncPath } from "./bridge/wsl-uri";

/**
 * Resolve a Linux path that opencode sent (absolute like `/home/me/file` or
 * relative like `src/file`) into a `vscode.Uri` that points at the same file
 * inside a WSL distro when the extension host runs on Windows and any
 * workspace folder is a WSL UNC path (e.g. `\\wsl.localhost\Ubuntu\home\me`).
 *
 * Returns undefined when no WSL translation applies so callers can fall back
 * to the existing `vscode.Uri.file(...)` path.
 */
export function resolveWslWorkspaceContext(): { distro: string; linuxRoot: string } | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const parsed = parseWslUncPath(folder.uri.fsPath);
    if (parsed) {
      return { distro: parsed.distro, linuxRoot: parsed.path };
    }
  }
  return undefined;
}

type ChangeKind = "add" | "update" | "delete" | "move";

type PreparedFileChange = {
  kind: ChangeKind;
  uri: vscode.Uri;
  relativePath: string;
  previousRelativePath?: string;
  oldText: string;
  newText: string;
  patch: string;
  additions: number;
  deletions: number;
  moveUri?: vscode.Uri;
};

type ResolvedTarget = {
  uri: vscode.Uri;
};

type TrustedTargetScope = {
  root: string;
  authorizedUris: Set<string>;
};

export type PreparedOperation = {
  edit: vscode.WorkspaceEdit;
  changes: PreparedFileChange[];
  saveUris: vscode.Uri[];
  output: string;
  metadata: Record<string, unknown>;
  sourceSessionId?: string;
};

export type FileState = {
  exists: boolean;
  text: string;
};

export type PrepareOperationOptions = {
  readFileState?(uri: vscode.Uri): FileState | undefined | Promise<FileState | undefined>;
};

export async function prepareOperation(request: BridgeRequest, options: PrepareOperationOptions = {}): Promise<PreparedOperation> {
  const withSourceSessionId = (operation: PreparedOperation) => ({
    ...operation,
    sourceSessionId: request.sessionID,
  });

  switch (request.tool) {
    case "edit":
      return withSourceSessionId(await prepareEdit(request.directory, request.worktree, request.payload, request.permission ?? [], options));
    case "write":
      return withSourceSessionId(await prepareWrite(request.directory, request.worktree, request.payload, request.permission ?? [], options));
    case "apply_patch":
      return withSourceSessionId(await prepareApplyPatch(request.directory, request.worktree, request.payload, request.permission ?? [], options));
  }
}

function trustedWorktreeRoot(
  directory: string,
  requestedWorktree: string,
  targets: ResolvedTarget[],
  tool: BridgeRequest["tool"],
  permission: BridgePermissionRule[] = [],
): TrustedTargetScope {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (targets.length === 0) {
    throw new Error("OpenCode bridge requires at least one target file.");
  }

  const wsl = resolveWslWorkspaceContext();
  const normalizedRequested = wsl
    ? vscode.Uri.file(toWorkspaceUncPath(requestedWorktree, wsl) ?? requestedWorktree).fsPath
    : path.resolve(requestedWorktree);
  const requestedRealPath = resolveRealPathForComparison(normalizedRequested);
  const targetRealPaths = targets.map((target) => resolveRealPathForComparison(target.uri.fsPath));
  const containingWorkspace = folders.find((folder) => {
    const folderRealPath = resolveRealPathForComparison(folder.uri.fsPath);
    return targetRealPaths.every((targetPath) => isWithinRoot(targetPath, folderRealPath));
  });

  const normalizedDirectory = wsl
    ? vscode.Uri.file(toWorkspaceUncPath(directory, wsl) ?? directory).fsPath
    : path.resolve(directory);
  const directoryRealPath = resolveRealPathForComparison(normalizedDirectory);
  const workspaceRealPaths = folders.map((folder) => resolveRealPathForComparison(folder.uri.fsPath));
  const untrustedTargets = targets.filter((target, index) => {
    const targetPath = targetRealPaths[index];
    if (!targetPath) {
      return true;
    }

    return !isWithinRoot(targetPath, requestedRealPath)
      && !isWithinRoot(targetPath, directoryRealPath)
      && !workspaceRealPaths.some((folderPath) => isWithinRoot(targetPath, folderPath))
      && !isAllowedExternalTarget(targetPath, permission, tool);
  });
  if (untrustedTargets.length > 0) {
    throw new Error(`Bridge request targets a path outside the active worktree: ${requestedWorktree}`);
  }

  const root = containingWorkspace?.uri.fsPath
    ?? (targetRealPaths.every((targetPath) => isWithinRoot(targetPath, requestedRealPath)) ? normalizedRequested : undefined)
    ?? (targetRealPaths.every((targetPath) => isWithinRoot(targetPath, directoryRealPath)) ? normalizedDirectory : undefined)
    ?? normalizedRequested;

  return {
    root,
    authorizedUris: new Set(targets.map((target) => target.uri.toString())),
  };
}

function resolveApplyPatchTarget(directory: string, worktree: string, filePath: string): ResolvedTarget {
  return {
    uri: resolveApplyPatchTargetUri(directory, worktree, filePath),
  };
}

function resolveApplyPatchTargetUri(directory: string, worktree: string, filePath: string) {
  const wsl = resolveWslWorkspaceContext();
  if (path.posix.isAbsolute(filePath)) {
    return vscode.Uri.file(toWorkspaceUncPath(filePath, wsl) ?? filePath);
  }

  const directUri = vscode.Uri.file(toWorkspaceUncPath(path.posix.join(directory, filePath), wsl) ?? path.join(directory, filePath));
  const worktreeUri = vscode.Uri.file(toWorkspaceUncPath(path.posix.join(worktree, filePath), wsl) ?? path.join(worktree, filePath));
  if (!workspaceFolderForUri(directUri) && !workspaceFolderForUri(worktreeUri)) {
    return directUri;
  }

  if (fileExists(directUri) || workspaceFolderForUri(directUri)) {
    return directUri;
  }

  if (worktreeUri.toString() !== directUri.toString() && (fileExists(worktreeUri) || workspaceFolderForUri(worktreeUri))) {
    return worktreeUri;
  }

  const existingWorkspaceCandidates = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => {
      const folderContext = parseWslUncPath(folder.uri.fsPath);
      if (folderContext) {
        return vscode.Uri.file(toWorkspaceUncPath(path.posix.join(folderContext.path, filePath), wsl) ?? path.join(folder.uri.fsPath, filePath));
      }
      return vscode.Uri.file(path.join(folder.uri.fsPath, filePath));
    })
    .filter((uri) => fileExists(uri));
  if (existingWorkspaceCandidates.length === 1) {
    return existingWorkspaceCandidates[0];
  }

  if (existingWorkspaceCandidates.length > 1) {
    throw new Error(`Bridge request has ambiguous relative path across workspace folders: ${filePath}`);
  }

  return directUri;
}

function resolveTarget(directory: string, worktree: string, filePath: string): ResolvedTarget {
  return {
    uri: resolveTargetUri(directory, worktree, filePath),
  };
}

function resolveTargetUri(directory: string, worktree: string, filePath: string) {
  const wsl = resolveWslWorkspaceContext();
  if (path.posix.isAbsolute(filePath)) {
    return vscode.Uri.file(toWorkspaceUncPath(filePath, wsl) ?? filePath);
  }

  const directUri = vscode.Uri.file(toWorkspaceUncPath(path.posix.join(directory, filePath), wsl) ?? path.join(directory, filePath));
  if (workspaceFolderForUri(directUri)) {
    return directUri;
  }

  const worktreeUri = vscode.Uri.file(toWorkspaceUncPath(path.posix.join(worktree, filePath), wsl) ?? path.join(worktree, filePath));
  if (workspaceFolderForUri(worktreeUri)) {
    return worktreeUri;
  }

  const existingWorkspaceCandidates = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => {
      const folderContext = parseWslUncPath(folder.uri.fsPath);
      if (folderContext) {
        return vscode.Uri.file(toWorkspaceUncPath(path.posix.join(folderContext.path, filePath), wsl) ?? path.join(folder.uri.fsPath, filePath));
      }
      return vscode.Uri.file(path.join(folder.uri.fsPath, filePath));
    })
    .filter((uri) => fileExists(uri));
  if (existingWorkspaceCandidates.length === 1) {
    return existingWorkspaceCandidates[0];
  }

  if (existingWorkspaceCandidates.length > 1) {
    throw new Error(`Bridge request has ambiguous relative path across workspace folders: ${filePath}`);
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) {
    const folderContext = parseWslUncPath(folders[0].uri.fsPath);
    if (folderContext) {
      return vscode.Uri.file(toWorkspaceUncPath(path.posix.join(folderContext.path, filePath), wsl) ?? path.join(folders[0].uri.fsPath, filePath));
    }
    return vscode.Uri.file(path.join(folders[0].uri.fsPath, filePath));
  }

  if (folders.length > 1) {
    throw new Error(`Bridge request has ambiguous relative path across workspace folders: ${filePath}`);
  }

  return directUri;
}

async function prepareEdit(
  directory: string,
  worktree: string,
  payload: Extract<BridgeRequest, { tool: "edit" }>["payload"],
  permission: BridgePermissionRule[],
  options: PrepareOperationOptions,
): Promise<PreparedOperation> {
  if (payload.oldString === payload.newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }

  const target = resolveTarget(directory, worktree, payload.filePath);
  const scope = trustedWorktreeRoot(directory, worktree, [target], "edit", permission);
  await assertWithinRoot(target.uri, scope);
  const uri = target.uri;
  const source = await readOperationFileState(uri, options);
  const nextText = buildEditedText(source.text, payload);
  const change = buildChange({
    kind: source.exists ? "update" : "add",
    uri,
    worktree: scope.root,
    oldText: source.text,
    newText: nextText,
  });

  return {
    edit: await buildWorkspaceEdit([change]),
    changes: [change],
    saveUris: [uri],
    output: "Edit applied successfully.",
    metadata: buildMetadata([change]),
  };
}

async function prepareWrite(
  directory: string,
  worktree: string,
  payload: Extract<BridgeRequest, { tool: "write" }>["payload"],
  permission: BridgePermissionRule[],
  options: PrepareOperationOptions,
): Promise<PreparedOperation> {
  const target = resolveTarget(directory, worktree, payload.filePath);
  const scope = trustedWorktreeRoot(directory, worktree, [target], "write", permission);
  await assertWithinRoot(target.uri, scope);
  const uri = target.uri;
  const source = await readOperationFileState(uri, options);
  const change = buildChange({
    kind: source.exists ? "update" : "add",
    uri,
    worktree: scope.root,
    oldText: source.text,
    newText: payload.content,
  });

  return {
    edit: await buildWorkspaceEdit([change]),
    changes: [change],
    saveUris: [uri],
    output: "Wrote file successfully.",
    metadata: buildMetadata([change]),
  };
}

async function prepareApplyPatch(
  directory: string,
  worktree: string,
  payload: Extract<BridgeRequest, { tool: "apply_patch" }>["payload"],
  permission: BridgePermissionRule[],
  options: PrepareOperationOptions,
): Promise<PreparedOperation> {
  if (!payload.patchText.trim()) {
    throw new Error("patch rejected: empty patch");
  }

  const hunks = parsePatch(payload.patchText);
  if (hunks.length === 0) {
    throw new Error("apply_patch verification failed: no hunks found");
  }

  const targets = hunks.flatMap((hunk): ResolvedTarget[] => {
    const target = resolveApplyPatchTarget(directory, worktree, hunk.path);
    if (hunk.type === "update" && hunk.move_path) {
      return [target, resolveApplyPatchTarget(directory, worktree, hunk.move_path)];
    }

    return [target];
  });
  const scope = trustedWorktreeRoot(directory, worktree, targets, "apply_patch", permission);
  const changes: PreparedFileChange[] = [];
  const pendingUpdatedTextByUri = new Map<string, string>();
  const pendingChangeIndexByUri = new Map<string, number>();
  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const uri = resolveApplyPatchTarget(directory, worktree, hunk.path).uri;
      await assertWithinRoot(uri, scope);
      const state = await readOperationFileState(uri, options);
      if (state.exists) {
        throw new Error(`apply_patch verification failed: file already exists: ${uri.fsPath}`);
      }
      const newText = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
      changes.push(
        buildChange({
          kind: "add",
          uri,
          worktree: scope.root,
          oldText: "",
          newText,
        }),
      );
      continue;
    }

    if (hunk.type === "delete") {
      const uri = resolveApplyPatchTarget(directory, worktree, hunk.path).uri;
      await assertWithinRoot(uri, scope);
      const state = await readOperationFileState(uri, options);
      if (!state.exists) {
        throw new Error(`apply_patch verification failed: Failed to read file to delete: ${uri.fsPath}`);
      }
      changes.push(
        buildChange({
          kind: "delete",
          uri,
          worktree: scope.root,
          oldText: state.text,
          newText: "",
        }),
      );
      continue;
    }

    const uri = resolveApplyPatchTarget(directory, worktree, hunk.path).uri;
    await assertWithinRoot(uri, scope);
    const pendingText = pendingUpdatedTextByUri.get(uri.toString());
    const state = pendingText === undefined
      ? await readOperationFileState(uri, options)
      : { exists: true, text: pendingText };
    if (!state.exists) {
      throw new Error(`apply_patch verification failed: Failed to read file to update: ${uri.fsPath}`);
    }

    const newText = deriveNewContentsFromChunks(state.text, uri.fsPath, hunk.chunks);
    const moveUri = hunk.move_path ? resolveApplyPatchTarget(directory, worktree, hunk.move_path).uri : undefined;
    if (moveUri) {
      await assertWithinRoot(moveUri, scope);
      const moveTargetState = await readOperationFileState(moveUri, options);
      if (moveTargetState.exists) {
        throw new Error(`apply_patch verification failed: move target already exists: ${moveUri.fsPath}`);
      }
    }
    if (!moveUri) {
      const existingIndex = pendingChangeIndexByUri.get(uri.toString());
      if (existingIndex !== undefined) {
        const existingChange = changes[existingIndex];
        if (existingChange?.kind === "update" && existingChange.moveUri === undefined) {
          changes[existingIndex] = buildChange({
            kind: "update",
            uri,
            worktree: scope.root,
            oldText: existingChange.oldText,
            newText,
          });
          pendingUpdatedTextByUri.set(uri.toString(), newText);
          continue;
        }
      }
    }
    changes.push(
      buildChange({
        kind: moveUri ? "move" : "update",
        uri,
        moveUri,
        worktree: scope.root,
        oldText: state.text,
        newText,
      }),
    );
    if (!moveUri) {
      pendingChangeIndexByUri.set(uri.toString(), changes.length - 1);
      pendingUpdatedTextByUri.set(uri.toString(), newText);
    }
  }

  const saveUris = changes.filter((change) => change.kind !== "delete").map((change) => change.moveUri ?? change.uri);
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

  const output = [
    "Success. Updated the following files:",
    ...changes.map((change) => {
      const filePath = change.moveUri ?? change.uri;
      const relativePath = toDisplayPathForFile(filePath.fsPath, workspaceRoots);
      if (change.kind === "add") {
        return `A ${relativePath}`;
      }
      if (change.kind === "delete") {
        return `D ${relativePath}`;
      }
      return `M ${relativePath}`;
    }),
  ].join("\n");

  return {
    edit: await buildWorkspaceEdit(changes),
    changes,
    saveUris,
    output,
    metadata: buildMetadata(changes),
  };
}

async function buildWorkspaceEdit(changes: PreparedFileChange[]): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();

  for (const change of changes) {
    if (change.kind === "add") {
      edit.createFile(change.uri, { ignoreIfExists: false });
      if (change.newText.length > 0) {
        edit.insert(change.uri, new vscode.Position(0, 0), change.newText);
      }
      continue;
    }

    if (change.kind === "delete") {
      edit.deleteFile(change.uri, { ignoreIfNotExists: false });
      continue;
    }

    const target = change.moveUri ?? change.uri;
    if (change.kind === "move") {
      edit.createFile(target, { ignoreIfExists: false });
      if (change.newText.length > 0) {
        edit.insert(target, new vscode.Position(0, 0), change.newText);
      }
      edit.deleteFile(change.uri, { ignoreIfNotExists: false });
      continue;
    }

    const range = await fullDocumentRange(change.uri);
    edit.replace(change.uri, range, change.newText);
  }

  return edit;
}

function buildMetadata(changes: PreparedFileChange[]): Record<string, unknown> {
  return {
    diff: changes.map((change) => change.patch).join("\n"),
    files: changes.map((change) => ({
      filePath: change.uri.fsPath,
      relativePath: change.relativePath,
      previousRelativePath: change.previousRelativePath,
      type: change.kind,
      patch: change.patch,
      additions: change.additions,
      deletions: change.deletions,
      movePath: change.moveUri?.fsPath,
    })),
  };
}

function buildChange(input: {
  kind: ChangeKind;
  uri: vscode.Uri;
  worktree: string;
  oldText: string;
  newText: string;
  moveUri?: vscode.Uri;
}): PreparedFileChange {
  const target = input.moveUri ?? input.uri;
  const patch = trimDiff(createTwoFilesPatch(input.uri.fsPath, target.fsPath, input.oldText, input.newText));
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(input.oldText, input.newText)) {
    if (change.added) {
      additions += change.count || 0;
    }
    if (change.removed) {
      deletions += change.count || 0;
    }
  }

  return {
    kind: input.kind,
    uri: input.uri,
    moveUri: input.moveUri,
    previousRelativePath: input.moveUri ? toDisplayPathForFile(input.uri.fsPath, workspaceRoots) : undefined,
    relativePath: toDisplayPathForFile(target.fsPath, workspaceRoots),
    oldText: input.oldText,
    newText: input.newText,
    patch,
    additions,
    deletions,
  };
}

function buildEditedText(
  source: string,
  payload: Extract<BridgeRequest, { tool: "edit" }>["payload"],
): string {
  if (payload.oldString === "") {
    return payload.newString;
  }

  const ending = detectLineEnding(source);
  const oldText = convertToLineEnding(normalizeLineEndings(payload.oldString), ending);
  const newText = convertToLineEnding(normalizeLineEndings(payload.newString), ending);
  return replace(source, oldText, newText, payload.replaceAll);
}

function normalizeLineEndings(text: string) {
  return text.replaceAll("\r\n", "\n");
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n") {
  if (ending === "\n") {
    return text;
  }
  return text.replaceAll("\n", "\r\n");
}

async function readFileState(uri: vscode.Uri): Promise<FileState> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (open) {
    return { exists: true, text: open.getText() };
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      exists: true,
      text: Buffer.from(bytes).toString("utf8"),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { exists: false, text: "" };
    }
    throw error;
  }
}

async function readOperationFileState(uri: vscode.Uri, options: PrepareOperationOptions): Promise<FileState> {
  const pendingState = await options.readFileState?.(uri);
  if (pendingState) {
    return pendingState;
  }

  return readFileState(uri);
}

async function fullDocumentRange(uri: vscode.Uri): Promise<vscode.Range> {
  const document = await vscode.workspace.openTextDocument(uri);
  const lastLine = document.lineCount === 0 ? 0 : document.lineCount - 1;
  const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter));
}

function workspaceFolderForUri(uri: vscode.Uri) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const targetRealPath = resolveRealPathForComparison(uri.fsPath);
  return folders.find((folder) => {
    const folderRealPath = resolveRealPathForComparison(folder.uri.fsPath);
    return isWithinRoot(targetRealPath, folderRealPath);
  });
}

function fileExists(uri: vscode.Uri) {
  try {
    realpathSync.native(uri.fsPath);
    return true;
  } catch (error) {
    if (isMissingNodePathError(error)) {
      return false;
    }

    throw error;
  }
}

function isAllowedExternalTarget(realFilePath: string, permission: BridgePermissionRule[], toolName: BridgeRequest["tool"]) {
  const hasExternalDirectoryPermission = permission.some((rule) => {
    return rule.action === "allow"
      && rule.permission === "external_directory"
      && matchesPermissionPattern(realFilePath, rule.pattern);
  });
  if (!hasExternalDirectoryPermission) {
    return false;
  }

  return permission.some((rule) => {
    if (rule.action !== "allow") {
      return false;
    }
    if (toolName === "apply_patch" && rule.permission === "apply_patch") {
      return isAllowedApplyPatchTarget(realFilePath, rule.pattern);
    }
    if ((toolName === "edit" || toolName === "write") && rule.permission === "edit") {
      return isAllowedApplyPatchTarget(realFilePath, rule.pattern);
    }

    return false;
  });
}

function isAllowedApplyPatchTarget(realFilePath: string, pattern: string) {
  const normalizedPattern = path.resolve(pattern.replaceAll("\\", "/"));
  const portablePattern = normalizedPattern.replaceAll("\\", "/");
  if (portablePattern.endsWith("/**") || portablePattern.endsWith("/*")) {
    return matchesPermissionPattern(realFilePath, normalizedPattern);
  }

  return resolveRealPathForComparison(path.dirname(normalizedPattern)) === path.dirname(realFilePath)
    && path.basename(normalizedPattern) === path.basename(realFilePath);
}

async function assertWithinRoot(uri: vscode.Uri, scope: TrustedTargetScope) {
  if (scope.authorizedUris.has(uri.toString())) {
    return;
  }

  throw new Error(`Refusing to edit a path outside the active worktree: ${uri.fsPath}`);
}

function isMissingFileError(error: unknown) {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }

  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  return error.code === "FileNotFound" || error.code === "ENOENT";
}

function isMissingNodePathError(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n");
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  );

  if (contentLines.length === 0) {
    return diff;
  }

  let min = Number.POSITIVE_INFINITY;
  for (const line of contentLines) {
    const content = line.slice(1);
    if (content.trim().length === 0) {
      continue;
    }
    const match = content.match(/^(\s*)/);
    if (match) {
      min = Math.min(min, match[1].length);
    }
  }

  if (!Number.isFinite(min) || min === 0) {
    return diff;
  }

  return lines
    .map((line) => {
      if ((line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) && !line.startsWith("---") && !line.startsWith("+++")) {
        return line[0] + line.slice(1 + min);
      }
      return line;
    })
    .join("\n");
}

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length);
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[a.length][b.length];
}

const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }

    let start = 0;
    for (let k = 0; k < i; k++) {
      start += originalLines[k].length + 1;
    }
    let end = start;
    for (let k = 0; k < searchLines.length; k++) {
      end += originalLines[i + k].length;
      if (k < searchLines.length - 1) {
        end += 1;
      }
    }
    yield content.substring(start, end);
  }
};

const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length < 3) {
    return;
  }
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const candidates: Array<{ startLine: number; endLine: number }> = [];

  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue;
    }
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | undefined;
  let bestScore = -1;

  for (const candidate of candidates) {
    const actualSize = candidate.endLine - candidate.startLine + 1;
    const linesToCheck = Math.min(searchLines.length - 2, actualSize - 2);
    let score = 0;
    if (linesToCheck <= 0) {
      score = 1;
    } else {
      for (let j = 1; j < searchLines.length - 1 && j < actualSize - 1; j++) {
        const originalLine = originalLines[candidate.startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) {
          continue;
        }
        const distance = levenshtein(originalLine, searchLine);
        score += 1 - distance / maxLen;
      }
      score /= linesToCheck;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (!bestMatch || bestScore < 0.3) {
    return;
  }

  let start = 0;
  for (let k = 0; k < bestMatch.startLine; k++) {
    start += originalLines[k].length + 1;
  }
  let end = start;
  for (let k = bestMatch.startLine; k <= bestMatch.endLine; k++) {
    end += originalLines[k].length;
    if (k < bestMatch.endLine) {
      end += 1;
    }
  }
  yield content.substring(start, end);
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length <= 1) {
    return;
  }
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (normalizeWhitespace(block) === normalizedFind) {
      yield block;
    }
  }
};

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n");
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) {
      return text;
    }
    const minIndent = Math.min(
      ...nonEmpty.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      }),
    );
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (value: string) =>
    value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
      switch (captured) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });

  const unescapedFind = unescapeString(find);
  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) {
      break;
    }
    yield find;
    startIndex = index + find.length;
  }
};

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) {
    return;
  }
  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) {
    return;
  }
  if (findLines[findLines.length - 1] === "") {
    findLines.pop();
  }

  const contentLines = content.split("\n");
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) {
      continue;
    }
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) {
        continue;
      }
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length !== findLines.length) {
        break;
      }

      let matchingLines = 0;
      let totalNonEmptyLines = 0;
      for (let k = 1; k < blockLines.length - 1; k++) {
        const blockLine = blockLines[k].trim();
        const findLine = findLines[k].trim();
        if (blockLine.length === 0 && findLine.length === 0) {
          continue;
        }
        totalNonEmptyLines++;
        if (blockLine === findLine) {
          matchingLines++;
        }
      }

      if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
        yield blockLines.join("\n");
        break;
      }
      break;
    }
  }
};

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }

  let notFound = true;
  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) {
        continue;
      }
      notFound = false;
      if (replaceAll) {
        return content.replaceAll(search, newString);
      }
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) {
        continue;
      }
      return content.slice(0, index) + newString + content.slice(index + search.length);
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    );
  }

  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}
