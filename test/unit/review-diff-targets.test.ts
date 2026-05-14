import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReviewDiffTargets } from "../../src/review/review-diff-targets";

describe("createReviewDiffTargets", () => {
  it("uses virtual before and current review documents for existing file changes", () => {
    const targets = createReviewDiffTargets(
      {
        createBeforeUri: (itemId) => `before:${itemId}`,
        createCurrentUri: (itemId) => `current:${itemId}`,
      },
      { id: "file:///workspace/src/example.ts" },
    );

    assert.deepEqual(targets, {
      beforeUri: "before:file:///workspace/src/example.ts",
      currentUri: "current:file:///workspace/src/example.ts",
    });
  });
});
