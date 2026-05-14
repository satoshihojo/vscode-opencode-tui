import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueueReviewEditCommand } from "../../src/commands/queue-review-edit";
import type { NormalizedProposal } from "../../src/types/proposal";

describe("createQueueReviewEditCommand", () => {
  it("queues the pre-apply snapshot for an existing file", async () => {
    let queuedOriginalText = "";
    let queuedProposal: NormalizedProposal | undefined;
    let revealed = false;

    const command = createQueueReviewEditCommand("auto", {
      getActiveDocument: async () => ({
        uri: "file:///workspace/src/example.ts",
        fileName: "example.ts",
        languageId: "typescript",
        text: "const value = 1;\n",
      }),
      createScratchDocument: async () => {
        throw new Error("scratch document should not be created");
      },
      applyProposal: async () => ({
        applied: true,
        saved: true,
        wasDirtyBeforeApply: false,
      }),
      queueProposal: async (proposal, originalText) => {
        queuedProposal = proposal;
        queuedOriginalText = originalText;
      },
      revealReviewPanel: () => {
        revealed = true;
      },
      showInformationMessage: () => {},
      showWarningMessage: () => {
        throw new Error("warning message should not be shown");
      },
      showErrorMessage: (message) => {
        throw new Error(message);
      },
    });

    await command();

    assert.equal(queuedProposal?.target.kind, "existing");
    assert.equal(queuedOriginalText, "const value = 1;\n");
    assert.equal(revealed, true);
  });
});
