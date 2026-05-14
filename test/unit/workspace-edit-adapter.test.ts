import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProposal } from "../../src/copilot/apply-discard-probe";
import { toWorkspaceEditSpec } from "../../src/edit/workspace-edit-adapter";

describe("toWorkspaceEditSpec", () => {
  it("marks proposal operations as needing confirmation", () => {
    const proposal = normalizeProposal({
      activeDocument: {
        uri: "file:///workspace/src/example.ts",
        fileName: "example.ts",
        languageId: "typescript",
        text: "const answer = 42;\n",
      },
    });

    const spec = toWorkspaceEditSpec(proposal);

    assert.equal(spec.operations[0]?.metadata.needsConfirmation, true);
    assert.equal(spec.operations[0]?.metadata.label, proposal.confirmation.label);
  });
});
