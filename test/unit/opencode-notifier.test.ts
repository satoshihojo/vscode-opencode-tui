import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeBackgroundNotifier, type ExternalNotifier, type NotificationUi } from "../../src/notifications/opencode-notifier";

describe("OpenCodeBackgroundNotifier", () => {
  it("routes idle notifications to the external channel after a busy session becomes idle", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );

    assert.deepEqual(external.notifications, [{
      kind: "idle",
      title: "OpenCode",
      message: "OpenCode session finished.",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    }]);
    assert.deepEqual(ui.statuses.at(-1), { kind: "idle", count: 1, label: "OpenCode session finished." });
  });

  it("does not notify idle until the session was observed busy", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    notifier.handleEvent({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } });

    assert.equal(external.notifications.length, 0);
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });
  });

  it("deduplicates pending permission notifications and clears them on reply", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });
    const permission = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"] };

    notifier.handleEvent({ type: "permission.updated", properties: permission });
    notifier.handleEvent({ type: "permission.updated", properties: permission });

    assert.deepEqual(external.notifications, [{
      kind: "permission",
      title: "OpenCode",
      message: "OpenCode is waiting for permission: bash (1 pattern)",
      source: { sessionId: "ses_1" },
    }]);
    assert.deepEqual(ui.statuses.at(-1), { kind: "permission", count: 1, label: "OpenCode needs permission." });

    notifier.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_1", permissionID: "per_1", response: "once" } });

    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("suppresses external notifications while VS Code is focused", () => {
    const ui = createFakeUi(true);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } });

    assert.equal(external.notifications.length, 0);
    assert.deepEqual(ui.statuses.at(-1), { kind: "permission", count: 1, label: "OpenCode needs permission." });
  });

  it("preserves busy status across focus changes", () => {
    const ui = createFakeUi(true);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    notifier.setFocused(true);

    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });
  });

  it("clears source state when a session closes", () => {
    const ui = createFakeUi(true);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.clearSource({ restoreId: "restore-1" });

    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("clears a restore running state when the tracked TUI session id changes", () => {
    const ui = createFakeUi(true);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_previous", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");

    notifier.clearSourceExceptSession({ restoreId: "restore-1" }, "ses_next");

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "normal");
    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("keeps the restore running state when the active TUI session id is still busy", () => {
    const ui = createFakeUi(true);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_current", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );

    notifier.clearSourceExceptSession({ restoreId: "restore-1" }, "ses_current");

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");
  });

  it("clears stale finished state when the tracked TUI session id changes", () => {
    const ui = createFakeUi(true);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_previous", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_previous", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_previous" } },
      { restoreId: "restore-1" },
    );
    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "idle");

    notifier.clearSourceExceptSession({ restoreId: "restore-1" }, "ses_next");

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "normal");
    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("clears finished state when a completed session closes", () => {
    const ui = createFakeUi(false);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.clearSource({ restoreId: "restore-1" });

    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("sanitizes structured permission names before sending desktop notifications", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });
    const permission = `Run\ncommand\u202ewith ${"x".repeat(300)}`;

    notifier.handleEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", permission } });

    assert.equal(external.notifications.length, 1);
    assert.match(external.notifications[0].message, /^OpenCode is waiting for permission: Run command with/);
    assert.equal(external.notifications[0].message.includes("\n"), false);
    assert.ok(external.notifications[0].message.length <= "OpenCode is waiting for permission: ".length + 240);
  });

  it("keeps error status across recomputes until the source recovers", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.error", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );
    notifier.setFocused(true);

    assert.deepEqual(ui.statuses.at(-1), { kind: "error", count: 1, label: "OpenCode session error." });
    assert.deepEqual(external.notifications, [{
      kind: "error",
      title: "OpenCode",
      message: "OpenCode session reported an error.",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    }]);

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );

    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });
  });

  it("ignores oversized identifiers before storing notification state", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });
    const oversizedId = "s".repeat(129);

    notifier.handleEvent({ type: "session.status", properties: { sessionID: oversizedId, status: { type: "busy" } } });
    notifier.handleEvent({ type: "permission.updated", properties: { id: oversizedId, sessionID: "ses_1", title: "Run command" } });

    assert.deepEqual(external.notifications, []);
    assert.deepEqual(ui.statuses, []);
  });

  it("clears status when notifications are disabled", () => {
    const ui = createFakeUi(true);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    notifier.updateSettings({ enabled: false, backgroundOnly: true, onIdle: true, onPermission: true, onError: true });
    notifier.handleEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } });

    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode notifications disabled." });
    assert.deepEqual(external.notifications, []);
  });

  it("honors per-channel settings for external notifications", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(
      ui,
      { enabled: true, backgroundOnly: true, onIdle: false, onPermission: true, onError: true },
      external,
      { idleSettleDelayMs: 0 },
    );

    notifier.handleEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } });
    notifier.handleEvent({ type: "session.error", properties: { sessionID: "ses_1" } });
    notifier.handleEvent({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } });
    notifier.handleEvent({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "idle" } } });

    assert.deepEqual(external.notifications.map((item) => item.kind), ["permission", "error"]);
  });

  it("swallows external notifier failures while preserving status updates", () => {
    const ui = createFakeUi(false);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, {
      notify: () => {
        throw new Error("notify failed");
      },
    }, { idleSettleDelayMs: 0 });

    assert.doesNotThrow(() => {
      notifier.handleEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } });
    });
    assert.deepEqual(ui.statuses.at(-1), { kind: "permission", count: 1, label: "OpenCode needs permission." });
  });

  it("does not mark a restore finished when a child session goes idle before its parent", async () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 10 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_parent", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );

    await wait(25);

    assert.deepEqual(external.notifications, []);
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_parent", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_parent" } },
      { restoreId: "restore-1" },
    );

    await wait(25);

    assert.deepEqual(external.notifications.map((item: Parameters<ExternalNotifier["notify"]>[0]) => item.kind), ["idle"]);
    assert.deepEqual(ui.statuses.at(-1), { kind: "idle", count: 1, label: "OpenCode session finished." });
  });

  it("debounces restore completion so a subagent handoff does not fire a finished notification", async () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 10 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_parent", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_parent", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );

    await wait(25);

    assert.equal(external.notifications.length, 0);
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_child" } },
      { restoreId: "restore-1" },
    );

    await wait(25);

    assert.deepEqual(external.notifications.map((item: Parameters<ExternalNotifier["notify"]>[0]) => item.kind), ["idle"]);
  });

  it("clears restore busy status when a session reports idle before completion", () => {
    const ui = createFakeUi(false);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );

    assert.deepEqual(ui.statuses.at(-1), { kind: "clear", count: 0, label: "OpenCode is idle." });
  });

  it("treats permission.asked as waiting for user permission", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "permission.asked",
        properties: {
          id: "req_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["npm test"],
        },
      },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "permission");
    assert.deepEqual(ui.statuses.at(-1), { kind: "permission", count: 1, label: "OpenCode needs permission." });
    assert.deepEqual(external.notifications.at(-1), {
      kind: "permission",
      title: "OpenCode",
      message: "OpenCode is waiting for permission: bash (1 pattern)",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    });

    notifier.handleEvent(
      { type: "permission.replied", properties: { sessionID: "ses_1", requestID: "req_1", response: "once" } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });
  });

  it("redacts raw permission patterns from desktop notifications", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({
      type: "permission.asked",
      properties: {
        id: "req_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["printf $SECRET_TOKEN"],
      },
    });

    assert.equal(external.notifications.at(-1)?.message, "OpenCode is waiting for permission: bash (1 pattern)");
    assert.equal(external.notifications.at(-1)?.message.includes("SECRET_TOKEN"), false);
  });

  it("prefers structured permission metadata over sensitive titles", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({
      type: "permission.asked",
      properties: {
        id: "req_1",
        sessionID: "ses_1",
        permission: "bash",
        title: "printf $SECRET_TOKEN",
        patterns: ["printf $SECRET_TOKEN"],
      },
    });

    assert.equal(external.notifications.at(-1)?.message, "OpenCode is waiting for permission: bash (1 pattern)");
    assert.equal(external.notifications.at(-1)?.message.includes("SECRET_TOKEN"), false);
  });

  it("uses a generic permission label when structured metadata is missing", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent({
      type: "permission.asked",
      properties: {
        id: "req_1",
        sessionID: "ses_1",
        title: "printf $SECRET_TOKEN",
      },
    });

    assert.equal(external.notifications.at(-1)?.message, "OpenCode is waiting for permission: permission required");
    assert.equal(external.notifications.at(-1)?.message.includes("SECRET_TOKEN"), false);
  });

  it("keeps a compacting session running without finished notification or unread attention", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", providerOptions: { anthropic: { type: "compaction" } } },
        },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");
    assert.deepEqual(external.notifications, []);
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");
    assert.deepEqual(ui.statuses.at(-1), { kind: "busy", count: 1, label: "OpenCode is running." });
  });

  it("allows a compacting session to finish after later non-compaction activity", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", providerOptions: { anthropic: { type: "compaction" } } },
        },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "message.part.updated", properties: { sessionID: "ses_1", part: { type: "text", text: "done" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "idle");
    assert.deepEqual(external.notifications.at(-1), {
      kind: "idle",
      title: "OpenCode",
      message: "OpenCode session finished.",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    });
  });

  it("allows a compacting session to finish when non-compaction activity arrives after idle", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", providerOptions: { anthropic: { type: "compaction" } } },
        },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "message.part.updated", properties: { sessionID: "ses_1", part: { type: "text", text: "done" } } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "idle");
    assert.deepEqual(external.notifications.at(-1), {
      kind: "idle",
      title: "OpenCode",
      message: "OpenCode session finished.",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    });
  });

  it("does not let busy heartbeats end compaction suppression early", () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 0 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", providerOptions: { anthropic: { type: "compaction" } } },
        },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "running");
    assert.deepEqual(external.notifications, []);
  });

  it("eventually finishes when compaction is the last observed activity", async () => {
    const ui = createFakeUi(false);
    const external = createFakeExternalNotifier();
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, external, { idleSettleDelayMs: 10 });

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", providerOptions: { anthropic: { type: "compaction" } } },
        },
      },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      { restoreId: "restore-1" },
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { restoreId: "restore-1" },
    );

    await wait(25);

    assert.equal(notifier.readSourceState({ restoreId: "restore-1" }), "idle");
    assert.deepEqual(external.notifications.at(-1), {
      kind: "idle",
      title: "OpenCode",
      message: "OpenCode session finished.",
      source: { restoreId: "restore-1", sessionId: "ses_1" },
    });
  });

  it("reports per-source terminal states in priority order", () => {
    const ui = createFakeUi(false);
    const notifier = new OpenCodeBackgroundNotifier(ui, undefined, undefined, { idleSettleDelayMs: 0 });
    const source = { restoreId: "restore-1" };

    assert.equal(notifier.readSourceState(source), "normal");

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      source,
    );
    assert.equal(notifier.readSourceState(source), "running");

    notifier.handleEvent(
      { type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1", title: "Run command" } },
      source,
    );
    assert.equal(notifier.readSourceState(source), "permission");

    notifier.handleEvent(
      { type: "session.error", properties: { sessionID: "ses_1" } },
      source,
    );
    assert.equal(notifier.readSourceState(source), "error");

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      source,
    );
    assert.equal(notifier.readSourceState(source), "permission");

    notifier.handleEvent({ type: "permission.replied", properties: { permissionID: "per_1" } }, source);
    assert.equal(notifier.readSourceState(source), "running");

    notifier.handleEvent(
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      source,
    );
    notifier.handleEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      source,
    );
    assert.equal(notifier.readSourceState(source), "idle");

    notifier.clearSource(source);
    assert.equal(notifier.readSourceState(source), "normal");
  });

});

function createFakeExternalNotifier(): ExternalNotifier & { notifications: Parameters<ExternalNotifier["notify"]>[0][] } {
  const notifications: Parameters<ExternalNotifier["notify"]>[0][] = [];
  return {
    notifications,
    notify: (notification) => {
      notifications.push(notification);
    },
  };
}

function createFakeUi(focused: boolean) {
  const statuses: Parameters<NotificationUi["setStatus"]>[0][] = [];
  const statusSources: Parameters<NotificationUi["setStatus"]>[1][] = [];
  return {
    statuses,
    statusSources,
    isFocused: () => focused,
    setStatus: (status: Parameters<NotificationUi["setStatus"]>[0], source: Parameters<NotificationUi["setStatus"]>[1]) => {
      statuses.push(status);
      statusSources.push(source);
    },
  };
}

function wait(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
