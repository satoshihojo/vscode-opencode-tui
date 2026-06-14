import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleOpenCodeSessionPanelMessage } from "../../src/opencode/session-panel-message";
import type { OpenCodeSessionTabState } from "../../src/opencode/session-tab-status-registry";

describe("OpenCode session panel messages", () => {
  it("opens the session picker from the open-session row", () => {
    let openSessionPickerCallCount = 0;
    const state: OpenCodeSessionTabState = { tabsByRestoreId: {}, order: [] };

    const nextState = handleOpenCodeSessionPanelMessage(state, { type: "open-session" }, {
      openSessionPicker: () => {
        openSessionPickerCallCount += 1;
      },
    });

    assert.equal(nextState, state);
    assert.equal(openSessionPickerCallCount, 1);
  });

  it("selects and reveals session rows", () => {
    let revealedRestoreId: string | undefined;
    let markedRestoreId: string | undefined;
    const state: OpenCodeSessionTabState = {
      selectedRestoreId: "restore-1",
      order: ["restore-1", "restore-2"],
      tabsByRestoreId: {
        "restore-1": {
          restoreId: "restore-1",
          title: "One",
          status: "idle",
          hidden: false,
          unread: false,
        },
        "restore-2": {
          restoreId: "restore-2",
          title: "Two",
          status: "running",
          hidden: true,
          unread: true,
        },
      },
    };

    const nextState = handleOpenCodeSessionPanelMessage(state, { type: "select", restoreId: "restore-2" }, {
      markSelected: (restoreId) => {
        markedRestoreId = restoreId;
      },
      revealSession: (restoreId) => {
        revealedRestoreId = restoreId;
      },
    });

    assert.equal(nextState.selectedRestoreId, "restore-2");
    assert.equal(nextState.tabsByRestoreId["restore-2"]?.unread, false);
    assert.equal(markedRestoreId, "restore-2");
    assert.equal(revealedRestoreId, "restore-2");
  });

  it("closes session rows and invokes the close action", () => {
    let closedRestoreId: string | undefined;
    const state: OpenCodeSessionTabState = {
      selectedRestoreId: "restore-1",
      order: ["restore-1", "restore-2"],
      tabsByRestoreId: {
        "restore-1": {
          restoreId: "restore-1",
          title: "One",
          status: "idle",
          hidden: false,
          unread: false,
        },
        "restore-2": {
          restoreId: "restore-2",
          title: "Two",
          status: "running",
          hidden: false,
          unread: false,
        },
      },
    };

    const nextState = handleOpenCodeSessionPanelMessage(state, { type: "close", restoreId: "restore-1" }, {
      closeSession: (restoreId) => {
        closedRestoreId = restoreId;
      },
    });

    assert.equal(closedRestoreId, "restore-1");
    assert.equal(nextState.order.includes("restore-1"), false);
    assert.equal(nextState.tabsByRestoreId["restore-1"], undefined);
    assert.equal(nextState.selectedRestoreId, "restore-2");
  });
});
