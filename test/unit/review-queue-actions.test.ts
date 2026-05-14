import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKeepAllReviewItemsCommand,
  createUndoAllReviewItemsCommand,
} from "../../src/commands/review-queue-actions";

describe("review queue bulk action commands", () => {
  it("keeps all queued items without asking for confirmation", async () => {
    let keepAllCount = 0;
    let renderCount = 0;

    const command = createKeepAllReviewItemsCommand(
      {
        keepAll() {
          keepAllCount += 1;
          return "kept-all" as const;
        },
      },
      {
        render() {
          renderCount += 1;
        },
      },
    );

    await command();

    assert.equal(keepAllCount, 1);
    assert.equal(renderCount, 1);
  });

  it("undoes all queued items without asking for confirmation", async () => {
    let undoAllCount = 0;
    let renderCount = 0;

    const command = createUndoAllReviewItemsCommand(
      {
        async undoAll() {
          undoAllCount += 1;
          return undoAllCount;
        },
      },
      {
        render() {
          renderCount += 1;
        },
      },
    );

    await command();

    assert.equal(undoAllCount, 1);
    assert.equal(renderCount, 1);
  });
});
