import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SCRATCH_URI,
  getExistingDocumentProbeSupport,
  normalizeProposal,
  toEditLabel,
} from "../../src/copilot/apply-discard-probe";

describe("normalizeProposal", () => {
  it("normalizes an active document into a canonical insert proposal", () => {
    const proposal = normalizeProposal({
      activeDocument: {
        uri: "file:///workspace/src/example.ts",
        fileName: "example.ts",
        languageId: "typescript",
        text: "const answer = 42;\n",
      },
    });

    assert.deepEqual(proposal.target, {
      kind: "existing",
      uri: "file:///workspace/src/example.ts",
    });
    assert.equal(proposal.edits[0]?.kind, "insert");
    assert.deepEqual(
      proposal.edits[0] && proposal.edits[0].kind === "insert" ? proposal.edits[0].position : undefined,
      { line: 1, character: 0 },
    );
    assert.match(proposal.edits[0]?.newText ?? "", /opencode-tui-integration probe/i);
    assert.equal(proposal.confirmation.label, "OpenCode TUI Integration Probe: example.ts");
    assert.equal(proposal.confirmation.needsConfirmation, true);
  });

  it("creates a scratch proposal when no active document exists", () => {
    const proposal = normalizeProposal({});

    assert.deepEqual(proposal.target, {
      kind: "scratch",
      uri: DEFAULT_SCRATCH_URI,
      initialText: "",
    });
    assert.equal(proposal.edits[0]?.kind, "insert");
    assert.deepEqual(
      proposal.edits[0] && proposal.edits[0].kind === "insert" ? proposal.edits[0].position : undefined,
      { line: 0, character: 0 },
    );
    assert.match(proposal.edits[0]?.newText ?? "", /Native Apply\/Discard probe/i);
  });
});

describe("toEditLabel", () => {
  it("generates stable labels for scratch documents", () => {
    assert.equal(toEditLabel(DEFAULT_SCRATCH_URI), "OpenCode TUI Integration Probe: OpenCode TUI Integration Probe.md");
  });
});

describe("getExistingDocumentProbeSupport", () => {
  it("rejects languages without a safe inline or block comment syntax", () => {
    const support = getExistingDocumentProbeSupport({
      languageId: "json",
    });

    assert.equal(support.supported, false);
    assert.match(support.reason, /scratch document/i);
  });
});
