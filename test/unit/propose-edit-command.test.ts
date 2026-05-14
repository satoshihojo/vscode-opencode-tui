import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProposeEditCommand } from "../../src/commands/propose-edit";
import type { NormalizedProposal } from "../../src/types/proposal";

describe("createProposeEditCommand", () => {
  it("uses the active document when available", async () => {
    let appliedProposal: NormalizedProposal | undefined;
    let infoMessage = "";

    const command = createProposeEditCommand("auto", {
      getActiveDocument: async () => ({
        uri: "file:///workspace/src/example.ts",
        fileName: "example.ts",
        languageId: "typescript",
        text: "const answer = 42;\n",
      }),
      createScratchDocument: async () => {
        throw new Error("scratch document should not be created");
      },
      applyProposal: async (proposal) => {
        appliedProposal = proposal;
        return {
          applied: true,
          saved: true,
          wasDirtyBeforeApply: false,
        };
      },
      showInformationMessage: (value) => {
        infoMessage = value;
      },
      showWarningMessage: () => {
        throw new Error("warning message should not be shown");
      },
      showErrorMessage: (value) => {
        throw new Error(value);
      },
    });

    await command();

    assert.equal(appliedProposal?.target.kind, "existing");
    assert.match(infoMessage, /submitted and saved/i);
  });

  it("falls back to a scratch document when no active document exists", async () => {
    let appliedProposal: NormalizedProposal | undefined;

    const command = createProposeEditCommand("auto", {
      getActiveDocument: async () => undefined,
      createScratchDocument: async () => ({
        uri: "untitled:OpenCode TUI Integration Probe.md",
        fileName: "OpenCode TUI Integration Probe.md",
        languageId: "markdown",
        text: "",
      }),
      applyProposal: async (proposal) => {
        appliedProposal = proposal;
        return {
          applied: true,
          saved: false,
          wasDirtyBeforeApply: false,
        };
      },
      showInformationMessage: () => {},
      showWarningMessage: () => {
        throw new Error("warning message should not be shown");
      },
      showErrorMessage: (value) => {
        throw new Error(value);
      },
    });

    await command();

    assert.equal(appliedProposal?.target.kind, "scratch");
  });
});
