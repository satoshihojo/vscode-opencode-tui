import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readSessionRestoreInfos,
  removeSessionRestoreInfo,
  shouldClearRestoreStateAfterMissingTerminal,
  toSessionLaunchOptions,
  toSessionRestoreInfo,
  updateRestoreInfoFromSession,
  upsertSessionRestoreInfo,
} from "../../src/opencode/session-restore";

describe("session restore bookkeeping", () => {
  it("keeps duplicate terminal labels as distinct restore entries", () => {
    const first = toSessionRestoreInfo({ cwd: "/workspace/a", terminalName: "opencode: new session" }, () => "restore-1");
    const second = toSessionRestoreInfo({ cwd: "/workspace/b", terminalName: "opencode: new session" }, () => "restore-2");

    const entries = upsertSessionRestoreInfo(upsertSessionRestoreInfo([], first), second);

    assert.deepEqual(entries.map((entry) => entry.restoreId), ["restore-1", "restore-2"]);
    assert.deepEqual(entries.map((entry) => entry.cwd), ["/workspace/a", "/workspace/b"]);
  });

  it("updates an existing restore entry by restore id without colliding on session title", () => {
    const first = toSessionRestoreInfo({ sessionId: "ses_1", sessionLabel: "same title" }, () => "restore-1");
    const second = toSessionRestoreInfo({ sessionId: "ses_2", sessionLabel: "same title" }, () => "restore-2");
    const updatedFirst = toSessionRestoreInfo({ restoreId: "restore-1", sessionId: "ses_1", sessionLabel: "updated title" });

    const entries = upsertSessionRestoreInfo(upsertSessionRestoreInfo(upsertSessionRestoreInfo([], first), second), updatedFirst);

    assert.deepEqual(entries.map((entry) => entry.restoreId), ["restore-2", "restore-1"]);
    assert.deepEqual(entries.map((entry) => entry.sessionLabel), ["same title", "updated title"]);
  });

  it("removes only the closed terminal restore entry", () => {
    const first = toSessionRestoreInfo({ cwd: "/workspace/a" }, () => "restore-1");
    const second = toSessionRestoreInfo({ cwd: "/workspace/b" }, () => "restore-2");

    const entries = removeSessionRestoreInfo([first, second], "restore-1");

    assert.deepEqual(entries, [second]);
  });

  it("preserves restore ids when converting back to launch options", () => {
    const launchOptions = toSessionLaunchOptions({
      opened: true,
      restoreId: "restore-1",
      cwd: "/workspace/a",
      terminalName: "opencode: new session",
      startedAt: 1234,
    });

    assert.deepEqual(launchOptions, {
      restoreId: "restore-1",
      cwd: "/workspace/a",
      terminalName: "opencode: new session",
      startedAt: 1234,
    });
  });

  it("updates the tracked restore snapshot when the TUI switches active sessions", () => {
    const existing = toSessionRestoreInfo({
      restoreId: "restore-1",
      sessionId: "ses_previous",
      sessionLabel: "Previous session",
      terminalName: "Previous session",
      updated: 10,
    });

    const updated = updateRestoreInfoFromSession(existing, {
      id: "ses_next",
      title: "Next session from TUI",
      updated: 20,
    });

    assert.deepEqual(updated, {
      opened: true,
      restoreId: "restore-1",
      sessionId: "ses_next",
      sessionLabel: "Next session from TUI",
      terminalName: "Next session from TUI",
      updated: 20,
    });
  });

  it("hydrates legacy restore entries with generated ids", () => {
    const ids = ["restore-1", "restore-2"];

    const entries = readSessionRestoreInfos([
      { opened: true, cwd: "/workspace/a" },
      { opened: true, cwd: "/workspace/b" },
    ], undefined, () => ids.shift() ?? "fallback");

    assert.deepEqual(entries.map((entry) => entry.restoreId), ["restore-1", "restore-2"]);
  });

  it("keeps restore state when saved sessions exist but VS Code did not restore terminals", () => {
    assert.equal(
      shouldClearRestoreStateAfterMissingTerminal(false, [{ opened: true, restoreId: "restore-1" }], undefined),
      false,
    );
    assert.equal(
      shouldClearRestoreStateAfterMissingTerminal(false, [], { opened: true, restoreId: "restore-legacy" }),
      false,
    );
    assert.equal(shouldClearRestoreStateAfterMissingTerminal(false, [], undefined), true);
    assert.equal(shouldClearRestoreStateAfterMissingTerminal(true, [], undefined), false);
  });
});
