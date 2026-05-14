import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTerminalAttentionLabel,
  clearTerminalAttentionLabel,
  hasTerminalAttentionLabel,
  OPENCODE_TERMINAL_ATTENTION_PREFIX,
  OPENCODE_TERMINAL_STATE_PREFIXES,
} from "../../src/opencode/terminal-attention";

describe("terminal attention label", () => {
  it("keeps terminal titles free of state prefixes", () => {
    assert.equal(applyTerminalAttentionLabel("OpenCode: Session", "running"), "OpenCode: Session");
    assert.equal(applyTerminalAttentionLabel(`${OPENCODE_TERMINAL_STATE_PREFIXES.running}OpenCode: Session`, "running"), "OpenCode: Session");
    assert.equal(applyTerminalAttentionLabel(`${OPENCODE_TERMINAL_STATE_PREFIXES.permission}OpenCode: Session`, "error"), "OpenCode: Session");
    assert.equal(applyTerminalAttentionLabel("OpenCode: Session", "normal"), "OpenCode: Session");
    assert.equal(applyTerminalAttentionLabel("OpenCode: Session", "idle"), "OpenCode: Session");
  });

  it("clears legacy and state prefixes when present", () => {
    assert.equal(clearTerminalAttentionLabel(`${OPENCODE_TERMINAL_ATTENTION_PREFIX}OpenCode: Session`), "OpenCode: Session");
    assert.equal(clearTerminalAttentionLabel(`${OPENCODE_TERMINAL_STATE_PREFIXES.idle}OpenCode: Session`), "OpenCode: Session");
    assert.equal(clearTerminalAttentionLabel(`${OPENCODE_TERMINAL_STATE_PREFIXES.error}${OPENCODE_TERMINAL_STATE_PREFIXES.running}OpenCode: Session`), "OpenCode: Session");
    assert.equal(clearTerminalAttentionLabel("OpenCode: Session"), "OpenCode: Session");
  });

  it("detects prefixed labels", () => {
    assert.equal(hasTerminalAttentionLabel(`${OPENCODE_TERMINAL_ATTENTION_PREFIX}OpenCode: Session`), true);
    assert.equal(hasTerminalAttentionLabel(`${OPENCODE_TERMINAL_STATE_PREFIXES.permission}OpenCode: Session`), true);
    assert.equal(hasTerminalAttentionLabel("OpenCode: Session"), false);
  });
});
