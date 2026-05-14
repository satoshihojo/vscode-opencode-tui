import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveActiveSessionPanelSelection } from "../../src/opencode/active-terminal-selection";

describe("resolveActiveSessionPanelSelection", () => {
  it("selects the tracked session when the terminal is still active", () => {
    const terminal = { name: "Queue diff fixes" };

    assert.deepEqual(resolveActiveSessionPanelSelection({
      terminalAtRequest: terminal,
      activeTerminal: terminal,
      restoreId: "restore-1",
    }), {
      type: "select",
      restoreId: "restore-1",
    });
  });

  it("clears the selection when the active terminal is unchanged but untracked", () => {
    const terminal = { name: "bash" };

    assert.deepEqual(resolveActiveSessionPanelSelection({
      terminalAtRequest: terminal,
      activeTerminal: terminal,
      restoreId: undefined,
    }), {
      type: "clear",
    });
  });

  it("ignores stale async completions after the active terminal changes", () => {
    const terminalAtRequest = { name: "Queue diff fixes" };
    const activeTerminal = { name: "Summarize pending edits" };

    assert.deepEqual(resolveActiveSessionPanelSelection({
      terminalAtRequest,
      activeTerminal,
      restoreId: "restore-1",
    }), {
      type: "ignore",
    });
  });
});
