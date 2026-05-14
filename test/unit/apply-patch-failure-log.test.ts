import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PatchApplicationError } from "../../src/apply-patch";
import {
  classifyApplyPatchFailure,
  createApplyPatchFailureRecord,
  summarizeApplyPatchText,
} from "../../src/apply-patch-failure-log";

describe("apply-patch-failure-log", () => {
  it("classifies hunk-indexed expected-lines failures without changing the user-facing message", () => {
    const message = new PatchApplicationError(
      "/workspace/bridge-patch-target.ts",
      1,
      "expected lines were not found:\nexport const missingValue = 1;",
    ).message;

    const classified = classifyApplyPatchFailure(message);

    assert.equal(classified.errorCode, "EXPECTED_LINES_NOT_FOUND");
    assert.equal(classified.hunkIndex, 1);
    assert.equal(classified.filePath, "/workspace/bridge-patch-target.ts");
    assert.equal(classified.message, message);
  });

  it("builds a structured failure record with patch summary metadata", () => {
    const message = new PatchApplicationError(
      "/workspace/bridge-patch-target.ts",
      1,
      "expected lines were not found:\nexport const missingValue = 1;",
    ).message;

    const record = createApplyPatchFailureRecord({
      message,
      directory: "/workspace",
      worktree: "/workspace",
      sessionID: "ses_test",
      patchText: [
        "*** Begin Patch",
        "*** Update File: bridge-patch-target.ts",
        "@@",
        "-export const missingValue = 1;",
        "+export const missingValue = 2;",
        "*** End Patch",
      ].join("\n"),
      timestamp: 123,
    });

    assert.equal(record.tool, "apply_patch");
    assert.equal(record.errorCode, "EXPECTED_LINES_NOT_FOUND");
    assert.equal(record.message, message);
    assert.equal(record.sessionId, "ses_test");
    assert.equal(record.cwd, "/workspace");
    assert.equal(record.worktree, "/workspace");
    assert.equal(record.hunkIndex, 1);
    assert.equal(record.filePath, "/workspace/bridge-patch-target.ts");
    assert.equal(record.timestamp, 123);
    assert.deepEqual(record.patchSummary, {
      hunkCount: 1,
      targetPaths: ["bridge-patch-target.ts"],
    });
  });

  it("summarizes malformed patches without throwing", () => {
    assert.deepEqual(summarizeApplyPatchText("not a patch"), {
      hunkCount: 0,
      targetPaths: [],
    });
  });

  it("classifies Windows path hunk failures", () => {
    const message = new PatchApplicationError(
      "C:\\workspace\\bridge-patch-target.ts",
      2,
      "context line was not found: export const value = 1;",
    ).message;

    const classified = classifyApplyPatchFailure(message);

    assert.equal(classified.errorCode, "CONTEXT_LINE_NOT_FOUND");
    assert.equal(classified.hunkIndex, 2);
    assert.equal(classified.filePath, "C:\\workspace\\bridge-patch-target.ts");
  });

  it("classifies outside-workspace bridge rejections with request context", () => {
    const classified = classifyApplyPatchFailure(
      "Bridge request targets a path outside the active workspace: /workspace",
    );

    assert.equal(classified.errorCode, "OUTSIDE_WORKSPACE");
  });
});
