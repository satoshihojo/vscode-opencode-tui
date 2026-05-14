import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleTuiActiveSession } from "../../src/opencode/tui-session-activation";
import type { OpenCodeSessionSummary } from "../../src/opencode/session-repository";

describe("handleTuiActiveSession", () => {
  it("validates the reported session before confirming the tracked restore", async () => {
    const lookups: Array<{ sessionId: string; cwd?: string }> = [];
    const confirmed: OpenCodeSessionSummary[] = [];

    await handleTuiActiveSession(
      {
        type: "tui.session.active",
        sessionID: "ses_active",
        openCodePort: 9001,
        title: "TUI snapshot title",
        updated: 20,
        activationTimestamp: 1,
      },
      {
        restoreInfoForPort: (openCodePort) => openCodePort === 9001 ? { restoreId: "restore-1", cwd: "/workspace" } : undefined,
        findSessionById: async (sessionId, cwd) => {
          lookups.push({ sessionId, cwd });
          return { id: sessionId, directory: cwd };
        },
        confirmSession: async (_restoreInfo, session) => {
          confirmed.push(session);
        },
      },
    );

    assert.deepEqual(lookups, [{ sessionId: "ses_active", cwd: "/workspace" }]);
    assert.deepEqual(confirmed, [{ id: "ses_active", directory: "/workspace", title: "TUI snapshot title", updated: 20 }]);
  });

  it("prefers validated TUI metadata over stale repository metadata", async () => {
    const confirmed: OpenCodeSessionSummary[] = [];

    await handleTuiActiveSession(
      {
        type: "tui.session.active",
        sessionID: "ses_active",
        openCodePort: 9001,
        title: "Fresh TUI title",
        updated: 30,
        activationTimestamp: 1,
      },
      {
        restoreInfoForPort: () => ({ restoreId: "restore-1" }),
        findSessionById: async (sessionId) => ({ id: sessionId, title: "Stale DB title", updated: 10 }),
        confirmSession: async (_restoreInfo, session) => {
          confirmed.push(session);
        },
      },
    );

    assert.deepEqual(confirmed, [{ id: "ses_active", title: "Fresh TUI title", updated: 30 }]);
  });

  it("rejects an older activation that resolves after a newer route", async () => {
    const latestActivationByRestoreId = new Map<string, number>();
    const confirmed: OpenCodeSessionSummary[] = [];
    let resolveOlderLookup: ((session: OpenCodeSessionSummary) => void) | undefined;

    const deps = {
      restoreInfoForPort: () => ({ restoreId: "restore-1" }),
      shouldProcessActivation: (restoreInfo: { restoreId: string }, message: { activationTimestamp?: number }) => {
        const latestActivation = latestActivationByRestoreId.get(restoreInfo.restoreId);
        if (latestActivation !== undefined && (message.activationTimestamp ?? 0) < latestActivation) {
          return false;
        }

        latestActivationByRestoreId.set(restoreInfo.restoreId, message.activationTimestamp ?? 0);
        return true;
      },
      findSessionById: async (sessionId: string) => {
        if (sessionId === "ses_older") {
          return new Promise<OpenCodeSessionSummary>((resolve) => {
            resolveOlderLookup = resolve;
          });
        }

        return { id: sessionId, title: "Newer route" };
      },
      confirmSession: async (_restoreInfo: { restoreId: string }, session: OpenCodeSessionSummary) => {
        confirmed.push(session);
      },
    };

    const older = handleTuiActiveSession(
      { type: "tui.session.active", sessionID: "ses_older", openCodePort: 9001, activationTimestamp: 100 },
      deps,
    );
    await handleTuiActiveSession(
      { type: "tui.session.active", sessionID: "ses_newer", openCodePort: 9001, activationTimestamp: 200 },
      deps,
    );

    resolveOlderLookup?.({ id: "ses_older", title: "Older route" });
    await older;

    assert.deepEqual(confirmed, [{ id: "ses_newer", title: "Newer route" }]);
  });

  it("does not confirm missing, child, mismatched, or untracked sessions", async () => {
    const confirmed: OpenCodeSessionSummary[] = [];
    const sessions = new Map<string, OpenCodeSessionSummary | undefined>([
      ["ses_missing", undefined],
      ["ses_child", { id: "ses_child", parentId: "ses_parent" }],
      ["ses_mismatch", { id: "ses_other" }],
    ]);

    for (const sessionID of ["ses_missing", "ses_child", "ses_mismatch", "bad"] as const) {
      await handleTuiActiveSession(
        { type: "tui.session.active", sessionID, openCodePort: 9001, activationTimestamp: 1 },
        {
          restoreInfoForPort: (openCodePort) => openCodePort === 9001 ? { restoreId: "restore-1" } : undefined,
          findSessionById: async (sessionId) => sessions.get(sessionId),
          confirmSession: async (_restoreInfo, session) => {
            confirmed.push(session);
          },
        },
      );
    }

    await handleTuiActiveSession(
      { type: "tui.session.active", sessionID: "ses_active", openCodePort: 9002, activationTimestamp: 1 },
      {
        restoreInfoForPort: () => undefined,
        findSessionById: async (sessionId) => ({ id: sessionId }),
        confirmSession: async (_restoreInfo, session) => {
          confirmed.push(session);
        },
      },
    );

    assert.deepEqual(confirmed, []);
  });
});
