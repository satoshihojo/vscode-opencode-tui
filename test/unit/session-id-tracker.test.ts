import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmRestoreSessionId,
  createRestoreSessionTrackingState,
  discardRestoreSessionCandidate,
  queueRestoreSessionCandidate,
} from "../../src/opencode/session-id-tracker";

describe("restore session tracking", () => {
  it("queues a first seen session id for later validation", () => {
    const state = queueRestoreSessionCandidate(createRestoreSessionTrackingState(), "ses_main");

    assert.deepEqual(state, { pendingSessionIds: ["ses_main"] });
  });

  it("does not enqueue duplicates or the confirmed session id", () => {
    const confirmed = createRestoreSessionTrackingState("ses_main");

    assert.equal(queueRestoreSessionCandidate(confirmed, "ses_main"), confirmed);
    assert.deepEqual(
      queueRestoreSessionCandidate({ pendingSessionIds: ["ses_sub"] }, "ses_sub"),
      { pendingSessionIds: ["ses_sub"] },
    );
  });

  it("supports child first then parent later by keeping both candidates until validation", () => {
    const withChild = queueRestoreSessionCandidate(createRestoreSessionTrackingState(), "ses_child");
    const withParent = queueRestoreSessionCandidate(withChild, "ses_parent");

    assert.deepEqual(withParent, { pendingSessionIds: ["ses_child", "ses_parent"] });
  });

  it("confirms a validated parent session id and removes it from pending", () => {
    const state = confirmRestoreSessionId({ pendingSessionIds: ["ses_child", "ses_parent"] }, "ses_parent");

    assert.deepEqual(state, { confirmedSessionId: "ses_parent", pendingSessionIds: ["ses_child"] });
  });

  it("allows a pending replacement session to become the new confirmed session", () => {
    const queued = queueRestoreSessionCandidate(createRestoreSessionTrackingState("ses_parent"), "ses_replacement");

    assert.deepEqual(confirmRestoreSessionId(queued, "ses_replacement"), {
      confirmedSessionId: "ses_replacement",
      pendingSessionIds: [],
    });
  });

  it("does not replace the latest confirmed session with an older pending candidate", () => {
    const withFirstCandidate = queueRestoreSessionCandidate(createRestoreSessionTrackingState("ses_original"), "ses_first");
    const withSecondCandidate = queueRestoreSessionCandidate(withFirstCandidate, "ses_second");
    const confirmedSecond = confirmRestoreSessionId(withSecondCandidate, "ses_second");

    assert.deepEqual(confirmRestoreSessionId(confirmedSecond, "ses_first"), {
      confirmedSessionId: "ses_second",
      pendingSessionIds: [],
    });
  });

  it("discards invalid child candidates without touching the confirmed session", () => {
    const state = discardRestoreSessionCandidate(
      { confirmedSessionId: "ses_parent", pendingSessionIds: ["ses_child"] },
      "ses_child",
    );

    assert.deepEqual(state, { confirmedSessionId: "ses_parent", pendingSessionIds: [] });
  });
});
