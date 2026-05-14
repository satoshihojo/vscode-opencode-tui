import { parsePatch } from "./apply-patch";

export type ApplyPatchFailureCode =
  | "AMBIGUOUS_PATH"
  | "CONTEXT_LINE_NOT_FOUND"
  | "EMPTY_PATCH"
  | "EXPECTED_LINES_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "INVALID_PATCH_FORMAT"
  | "MOVE_TARGET_EXISTS"
  | "NO_CHANGES_TO_APPLY"
  | "NO_HUNKS"
  | "OUTSIDE_WORKSPACE"
  | "OVERLAPPING_HUNK"
  | "READ_DELETE_TARGET_FAILED"
  | "READ_UPDATE_TARGET_FAILED"
  | "VSCODE_APPLY_EDIT_FAILED"
  | "WORKSPACE_REQUIRED"
  | "UNKNOWN";

export type ApplyPatchFailureRecord = {
  tool: "apply_patch";
  errorCode: ApplyPatchFailureCode;
  message: string;
  sessionId?: string;
  cwd: string;
  worktree: string;
  hunkIndex?: number;
  filePath?: string;
  patchSummary: ApplyPatchPatchSummary;
  timestamp: number;
};

export type ApplyPatchPatchSummary = {
  hunkCount: number;
  targetPaths: string[];
};

type CreateApplyPatchFailureRecordInput = {
  message: string;
  directory: string;
  worktree: string;
  sessionID?: string;
  patchText: string;
  timestamp?: number;
};

type ApplyPatchFailureClassification = {
  errorCode: ApplyPatchFailureCode;
  message: string;
  hunkIndex?: number;
  filePath?: string;
};

const MAX_FAILURE_RECORDS = 100;

export function createApplyPatchFailureRecord(input: CreateApplyPatchFailureRecordInput): ApplyPatchFailureRecord {
  const classified = classifyApplyPatchFailure(input.message);
  return {
    tool: "apply_patch",
    errorCode: classified.errorCode,
    message: classified.message,
    sessionId: input.sessionID,
    cwd: input.directory,
    worktree: input.worktree,
    hunkIndex: classified.hunkIndex,
    filePath: classified.filePath,
    patchSummary: summarizeApplyPatchText(input.patchText),
    timestamp: input.timestamp ?? Date.now(),
  };
}

export function classifyApplyPatchFailure(message: string): ApplyPatchFailureClassification {
  const patchHunkFailure = parsePatchHunkFailure(message);
  if (patchHunkFailure) {
    return {
      errorCode: classifyPatchHunkReason(patchHunkFailure.reason),
      message,
      hunkIndex: patchHunkFailure.hunkIndex,
      filePath: patchHunkFailure.filePath,
    };
  }

  return {
    errorCode: classifyMessage(message),
    message,
  };
}

function parsePatchHunkFailure(message: string) {
  const prefixMatch = /^Patch hunk (\d+) failed in /.exec(message);
  if (!prefixMatch) {
    return undefined;
  }

  const suffix = ". No files were changed.";
  if (!message.endsWith(suffix)) {
    return undefined;
  }

  const body = message.slice(prefixMatch[0].length, -suffix.length);
  const reasonMarkers = [
    "context line was not found:",
    "expected lines were not found:",
    "replacement overlaps with another patch hunk",
  ];
  for (const marker of reasonMarkers) {
    const separator = `: ${marker}`;
    const separatorIndex = body.indexOf(separator);
    if (separatorIndex === -1) {
      continue;
    }

    return {
      hunkIndex: Number.parseInt(prefixMatch[1] ?? "", 10),
      filePath: body.slice(0, separatorIndex),
      reason: body.slice(separatorIndex + 2),
    };
  }

  return undefined;
}

export function summarizeApplyPatchText(patchText: string): ApplyPatchPatchSummary {
  try {
    const hunks = parsePatch(patchText);
    const targetPaths = [...new Set(hunks.flatMap((hunk) => {
      if (hunk.type === "update" && hunk.move_path) {
        return [hunk.path, hunk.move_path];
      }

      return [hunk.path];
    }))];
    return {
      hunkCount: hunks.length,
      targetPaths,
    };
  } catch {
    return {
      hunkCount: 0,
      targetPaths: [],
    };
  }
}

export function readApplyPatchFailureRecords(value: unknown): ApplyPatchFailureRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isApplyPatchFailureRecord(entry)) {
      return [];
    }

    return [entry];
  }).slice(-MAX_FAILURE_RECORDS);
}

function isApplyPatchFailureRecord(value: unknown): value is ApplyPatchFailureRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<ApplyPatchFailureRecord>;
  return record.tool === "apply_patch"
    && typeof record.errorCode === "string"
    && typeof record.message === "string"
    && typeof record.cwd === "string"
    && typeof record.worktree === "string"
    && typeof record.timestamp === "number"
    && !!record.patchSummary
    && typeof record.patchSummary.hunkCount === "number"
    && Array.isArray(record.patchSummary.targetPaths)
    && record.patchSummary.targetPaths.every((targetPath) => typeof targetPath === "string")
    && (record.sessionId === undefined || typeof record.sessionId === "string")
    && (record.hunkIndex === undefined || typeof record.hunkIndex === "number")
    && (record.filePath === undefined || typeof record.filePath === "string");
}

function classifyPatchHunkReason(reason: string): ApplyPatchFailureCode {
  const normalizedReason = reason.trim().replace(/\.$/, "");
  if (normalizedReason.startsWith("context line was not found:")) {
    return "CONTEXT_LINE_NOT_FOUND";
  }
  if (normalizedReason.startsWith("expected lines were not found:")) {
    return "EXPECTED_LINES_NOT_FOUND";
  }
  if (normalizedReason === "replacement overlaps with another patch hunk") {
    return "OVERLAPPING_HUNK";
  }

  return "UNKNOWN";
}

function classifyMessage(message: string): ApplyPatchFailureCode {
  if (message === "patch rejected: empty patch") {
    return "EMPTY_PATCH";
  }
  if (message === "apply_patch verification failed: no hunks found") {
    return "NO_HUNKS";
  }
  if (message.startsWith("apply_patch verification failed: file already exists:")) {
    return "FILE_ALREADY_EXISTS";
  }
  if (message.startsWith("apply_patch verification failed: Failed to read file to delete:")) {
    return "READ_DELETE_TARGET_FAILED";
  }
  if (message.startsWith("apply_patch verification failed: Failed to read file to update:")) {
    return "READ_UPDATE_TARGET_FAILED";
  }
  if (message.startsWith("apply_patch verification failed: move target already exists:")) {
    return "MOVE_TARGET_EXISTS";
  }
  if (message.startsWith("Invalid patch format:")) {
    return "INVALID_PATCH_FORMAT";
  }
  if (message.startsWith("No changes to apply:")) {
    return "NO_CHANGES_TO_APPLY";
  }
  if (message.startsWith("Bridge request has ambiguous relative path")) {
    return "AMBIGUOUS_PATH";
  }
  if (message.startsWith("Bridge request targets a path outside the active workspace")) {
    return "OUTSIDE_WORKSPACE";
  }
  if (message === "OpenCode bridge requires an open VS Code workspace folder.") {
    return "WORKSPACE_REQUIRED";
  }
  if (message === "VS Code failed to apply the requested edit.") {
    return "VSCODE_APPLY_EDIT_FAILED";
  }

  return "UNKNOWN";
}
