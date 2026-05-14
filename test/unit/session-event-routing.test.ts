import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOpenCodeEventSessionId, shouldReconcileTitleForEvent } from "../../src/opencode/session-event-routing";

describe("OpenCode session event routing", () => {
  it("reads valid session ids from events", () => {
    assert.equal(readOpenCodeEventSessionId({ type: "session.status", properties: { sessionID: "ses_1" } }), "ses_1");
    assert.equal(readOpenCodeEventSessionId({ type: "session.updated", properties: { info: { id: "ses_2" } } }), "ses_2");
    assert.equal(readOpenCodeEventSessionId({ type: "session.updated", properties: { info: { sessionID: "ses_3" } } }), "ses_3");
    assert.equal(readOpenCodeEventSessionId({ type: "session.status", properties: { sessionID: "invalid" } }), undefined);
  });

  it("does not reconcile terminal titles for unrelated events", () => {
    assert.equal(shouldReconcileTitleForEvent({ type: "review.updated" }), false);
    assert.equal(
      shouldReconcileTitleForEvent(
        { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
        "running",
        "running",
      ),
      false,
    );
    assert.equal(
      shouldReconcileTitleForEvent(
        { type: "session.status", properties: { sessionID: "ses_1", status: { type: "other" } } },
      ),
      false,
    );
  });

  it("reconciles terminal titles for session state changes", () => {
    assert.equal(shouldReconcileTitleForEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }), true);
    assert.equal(shouldReconcileTitleForEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } }), true);
    assert.equal(
      shouldReconcileTitleForEvent(
        { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
        "normal",
        "running",
      ),
      true,
    );
    assert.equal(shouldReconcileTitleForEvent({ type: "permission.updated", properties: { id: "per_1", sessionID: "ses_1" } }), true);
    assert.equal(shouldReconcileTitleForEvent({ type: "permission.replied", properties: { permissionID: "per_1", sessionID: "ses_1" } }), true);
    assert.equal(shouldReconcileTitleForEvent({ type: "session.updated", properties: { info: { id: "ses_1" } } }), true);
    assert.equal(shouldReconcileTitleForEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }), true);
    assert.equal(shouldReconcileTitleForEvent({ type: "session.error", properties: { sessionID: "ses_1" } }), true);
  });
});
