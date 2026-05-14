import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearOpenCodeSessionTabSelection,
  closeOpenCodeSessionTab,
  registerOpenCodeSessionTab,
  selectOpenCodeSessionTab,
  updateOpenCodeSessionTabStatus,
  updateOpenCodeSessionTabTitle,
  type OpenCodeSessionTabState,
} from "../../src/opencode/session-tab-status-registry";

describe("OpenCode session tab status registry", () => {
  it("registers tabs with defaults and immutable updates", () => {
    const empty = createEmptyState();
    const first = registerOpenCodeSessionTab(empty, {
      restoreId: "restore-1",
      sessionId: "ses_1",
      cwd: "/workspace",
      updated: 1712401200000,
      title: "Session One",
    });

    assert.notEqual(first, empty);
    assert.deepEqual(first.order, ["restore-1"]);
    assert.equal(first.selectedRestoreId, "restore-1");
    assert.deepEqual(first.tabsByRestoreId["restore-1"], {
      restoreId: "restore-1",
      sessionId: "ses_1",
      cwd: "/workspace",
      updated: 1712401200000,
      title: "Session One",
      status: "normal",
      hidden: false,
      unread: false,
    });

    const unchanged = registerOpenCodeSessionTab(first, {
      restoreId: "restore-1",
      sessionId: "ses_1",
      cwd: "/workspace",
      updated: 1712401200000,
      title: "Session One",
    });
    assert.equal(unchanged, first);

    const updated = registerOpenCodeSessionTab(first, { restoreId: "restore-1", title: "Renamed" });
    assert.notEqual(updated, first);
    assert.notEqual(updated.tabsByRestoreId["restore-1"], first.tabsByRestoreId["restore-1"]);
    assert.equal(updated.tabsByRestoreId["restore-1"].title, "Renamed");
    assert.equal(updated.tabsByRestoreId["restore-1"].updated, 1712401200000);

    const cleared = registerOpenCodeSessionTab(first, {
      restoreId: "restore-1",
      title: "Renamed",
      updated: undefined,
    });
    assert.notEqual(cleared, first);
    assert.equal(cleared.tabsByRestoreId["restore-1"].title, "Renamed");
    assert.equal(Object.prototype.hasOwnProperty.call(cleared.tabsByRestoreId["restore-1"], "updated"), false);
  });

  it("selects tabs, clears unread, and ignores unknown selections", () => {
    const withTabs = registerOpenCodeSessionTab(
      registerOpenCodeSessionTab(createEmptyState(), { restoreId: "restore-1", title: "One" }),
      { restoreId: "restore-2", title: "Two", hidden: true },
    );
    const unread = updateOpenCodeSessionTabStatus(withTabs, "restore-2", "permission");

    assert.equal(unread.tabsByRestoreId["restore-2"].unread, true);
    const selected = selectOpenCodeSessionTab(unread, "restore-2");

    assert.equal(selected.selectedRestoreId, "restore-2");
    assert.equal(selected.tabsByRestoreId["restore-2"].hidden, false);
    assert.equal(selected.tabsByRestoreId["restore-2"].unread, false);
    assert.equal(selectOpenCodeSessionTab(selected, "unknown"), selected);
  });

  it("marks hidden tabs unread on status or title changes only", () => {
    const visible = registerOpenCodeSessionTab(createEmptyState(), { restoreId: "restore-1", title: "One" });
    const hidden = registerOpenCodeSessionTab(visible, { restoreId: "restore-2", title: "Two", hidden: true });

    const running = updateOpenCodeSessionTabStatus(hidden, "restore-2", "running");
    assert.equal(running.tabsByRestoreId["restore-2"].unread, true);
    assert.equal(running.tabsByRestoreId["restore-2"].status, "running");
    assert.equal(updateOpenCodeSessionTabStatus(running, "restore-2", "running"), running);

    const renamed = updateOpenCodeSessionTabTitle(running, "restore-2", "Two renamed");
    assert.equal(renamed.tabsByRestoreId["restore-2"].unread, true);
    assert.equal(renamed.tabsByRestoreId["restore-2"].title, "Two renamed");
    assert.equal(updateOpenCodeSessionTabTitle(renamed, "restore-2", "Two renamed"), renamed);

    const selected = selectOpenCodeSessionTab(renamed, "restore-2");
    const selectedStatus = updateOpenCodeSessionTabStatus(selected, "restore-2", "idle");
    assert.equal(selectedStatus.tabsByRestoreId["restore-2"].unread, false);
  });

  it("preserves unmodified tab identity across updates", () => {
    const withTabs = registerOpenCodeSessionTab(
      registerOpenCodeSessionTab(createEmptyState(), { restoreId: "restore-1", title: "One" }),
      { restoreId: "restore-2", title: "Two" },
    );
    const firstTab = withTabs.tabsByRestoreId["restore-1"];
    const secondTab = withTabs.tabsByRestoreId["restore-2"];

    const updated = updateOpenCodeSessionTabStatus(withTabs, "restore-2", "error");

    assert.equal(updated.tabsByRestoreId["restore-1"], firstTab);
    assert.notEqual(updated.tabsByRestoreId["restore-2"], secondTab);
  });

  it("does not restore selection after it was explicitly cleared", () => {
    const withTabs = registerOpenCodeSessionTab(
      registerOpenCodeSessionTab(createEmptyState(), { restoreId: "restore-1", title: "One" }),
      { restoreId: "restore-2", title: "Two" },
    );

    const cleared = clearOpenCodeSessionTabSelection(withTabs);
    const refreshed = registerOpenCodeSessionTab(cleared, { restoreId: "restore-1", title: "One renamed" });

    assert.equal(cleared.selectedRestoreId, undefined);
    assert.equal(refreshed.selectedRestoreId, undefined);
    assert.equal(refreshed.tabsByRestoreId["restore-1"].title, "One renamed");
  });

  it("closes tabs and selects the next remaining tab deterministically", () => {
    const withTabs = registerOpenCodeSessionTab(
      registerOpenCodeSessionTab(
        registerOpenCodeSessionTab(createEmptyState(), { restoreId: "restore-1", title: "One" }),
        { restoreId: "restore-2", title: "Two" },
      ),
      { restoreId: "restore-3", title: "Three" },
    );
    const selectedMiddle = selectOpenCodeSessionTab(withTabs, "restore-2");

    const closedMiddle = closeOpenCodeSessionTab(selectedMiddle, "restore-2");
    assert.deepEqual(closedMiddle.order, ["restore-1", "restore-3"]);
    assert.equal(closedMiddle.selectedRestoreId, "restore-3");
    assert.equal(closedMiddle.tabsByRestoreId["restore-2"], undefined);

    const closedNonSelected = closeOpenCodeSessionTab(closedMiddle, "restore-1");
    assert.equal(closedNonSelected.selectedRestoreId, "restore-3");

    const closedLast = closeOpenCodeSessionTab(closedNonSelected, "restore-3");
    assert.deepEqual(closedLast.order, []);
    assert.equal(closedLast.selectedRestoreId, undefined);
    assert.equal(closeOpenCodeSessionTab(closedLast, "missing"), closedLast);
  });
});

function createEmptyState(): OpenCodeSessionTabState {
  return {
    tabsByRestoreId: {},
    order: [],
  };
}
