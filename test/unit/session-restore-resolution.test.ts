import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenCodeSessionSummary } from "../../src/opencode/session-repository";
import { OPENCODE_TERMINAL_STATE_PREFIXES } from "../../src/opencode/terminal-attention";
import {
  createOpenCodeTerminalMatcher,
  dedupeSessionsByTitle,
  matchesOpenCodeTerminal,
  readLatestSessionForDirectory,
  resolveOpenCodeTerminalRestoreId,
  resolveRestoreSessionFallbackByLatestSession,
  resolveRestoreSessionOptions,
  resolveSessionTitle,
  shouldRetrySessionTitleResolution,
  toSessionLaunchOptions,
  updatePersistedRestoreStateSnapshot,
  waitForOpenCodeTerminalRestore,
} from "../../src/opencode/session-restore";

describe("session restore resolution", () => {
  it("dedupes sessions by trimmed title and keeps the newest session", () => {
    const sessions: OpenCodeSessionSummary[] = [
      { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 30 },
      { id: "ses_older", title: "Shared", directory: "/workspace", updated: 20 },
      { id: "ses_unique", title: "Unique", directory: "/workspace", updated: 10 },
      { id: "ses_child", title: "Shared", directory: "/workspace", updated: 40, parentId: "ses_latest" },
      { id: "ses_untitled_1", updated: 50 },
      { id: "ses_untitled_2", updated: 40 },
    ];

    assert.deepEqual(
      dedupeSessionsByTitle(sessions).map((session: OpenCodeSessionSummary) => session.id),
      ["ses_latest", "ses_unique", "ses_untitled_1", "ses_untitled_2"],
    );
  });

  it("resolves a restored session to the latest session with the same title", () => {
    const resolved = resolveRestoreSessionOptions(
      {
        restoreId: "restore-1",
        opened: true,
        sessionId: "ses_opened",
        sessionLabel: "Shared",
        terminalName: "Shared",
      },
      { latestSession: { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 40 } },
    );

    assert.deepEqual(resolved, {
      restoreId: "restore-1",
      sessionId: "ses_latest",
      sessionLabel: "Shared",
      terminalName: "Shared",
      updated: 40,
    });
  });

  it("leaves restore options unchanged when no newer matching session exists", () => {
    const resolved = resolveRestoreSessionOptions(
      {
        restoreId: "restore-1",
        opened: true,
        sessionId: "ses_opened",
        sessionLabel: "Shared",
        terminalName: "Shared",
      },
      {},
    );

    assert.deepEqual(resolved, {
      restoreId: "restore-1",
      sessionId: "ses_opened",
      sessionLabel: "Shared",
      terminalName: "Shared",
    });
  });

  it("keeps the exact saved session when it still exists", () => {
    const restoreInfo = {
      restoreId: "restore-1",
      opened: true,
      sessionId: "ses_opened",
      sessionLabel: "Shared",
      terminalName: "Shared",
    };

    assert.deepEqual(resolveRestoreSessionOptions(restoreInfo, {
      exactSession: { id: "ses_opened", title: "Shared", directory: "/workspace", updated: 20 },
      latestSession: { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 40 },
    }), {
      restoreId: "restore-1",
      sessionId: "ses_opened",
      sessionLabel: "Shared",
      terminalName: "Shared",
      updated: 20,
    });
  });

  it("uses the top-level latest session when the exact session is a child", () => {
    const resolved = resolveRestoreSessionOptions(
      {
        restoreId: "restore-1",
        opened: true,
        sessionId: "ses_child",
        sessionLabel: "Shared",
        terminalName: "Shared",
      },
      {
        exactSession: { id: "ses_child", title: "Shared", directory: "/workspace", updated: 50, parentId: "ses_parent" },
        latestSession: { id: "ses_parent", title: "Shared", directory: "/workspace", updated: 40 },
      },
    );

    assert.deepEqual(resolved, {
      restoreId: "restore-1",
      sessionId: "ses_parent",
      sessionLabel: "Shared",
      terminalName: "Shared",
      updated: 40,
    });
  });

  it("unlabeled exact child session with no latest fallback clears sessionId", () => {
    const resolved = resolveRestoreSessionOptions(
      {
        restoreId: "restore-1",
        opened: true,
        sessionId: "ses_child",
        sessionLabel: "Shared",
        terminalName: "Shared",
      },
      {
        exactSession: { id: "ses_child", title: "Shared", directory: "/workspace", updated: 50, parentId: "ses_parent" },
      },
    );

    assert.deepEqual(resolved, {
      restoreId: "restore-1",
      sessionLabel: "Shared",
      terminalName: "Shared",
    });
  });

  it("title fallback can target a different latest restorable session", () => {
    const resolved = resolveRestoreSessionOptions(
      {
        restoreId: "restore-1",
        opened: true,
        sessionId: "ses_missing",
        sessionLabel: "Shared",
        terminalName: "Shared",
      },
      { latestSession: { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 40 } },
    );

    assert.deepEqual(resolved, {
      restoreId: "restore-1",
      sessionId: "ses_latest",
      sessionLabel: "Shared",
      terminalName: "Shared",
      updated: 40,
    });
  });

  it("keeps launch options unchanged without a session label", () => {
    const restoreInfo = {
      restoreId: "restore-1",
      opened: true,
      sessionId: "ses_opened",
      terminalName: "Shared",
    };

    assert.deepEqual(toSessionLaunchOptions(restoreInfo), {
      restoreId: "restore-1",
      sessionId: "ses_opened",
      terminalName: "Shared",
    });
  });

  it("matches restored terminals by persisted process id even when the title changed", () => {
    const matcher = createOpenCodeTerminalMatcher(
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared", terminalProcessId: 4321 }],
      undefined,
      [],
    );

    assert.equal(matchesOpenCodeTerminal({ name: "node", processId: 4321 }, matcher), true);
  });

  it("matches restored shell terminals by their creation name when the visible title resets", () => {
    const matcher = createOpenCodeTerminalMatcher(
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
      [],
    );

    assert.equal(matchesOpenCodeTerminal({ name: "bash", creationName: "Shared" }, matcher), true);
    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: "bash", creationName: "Shared" },
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
    ), "restore-1");
  });

  it("uses the restored shell cwd to disambiguate duplicate creation names", () => {
    const restoreInfos = [
      { opened: true, restoreId: "restore-1", terminalName: "new session", cwd: "/workspace/a" },
      { opened: true, restoreId: "restore-2", terminalName: "new session", cwd: "/workspace/b" },
    ];

    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: "bash", creationName: "new session", cwd: "/workspace/b" },
      restoreInfos,
      undefined,
    ), "restore-2");
  });

  it("matches OpenCode terminals even when the title has an attention prefix", () => {
    const matcher = createOpenCodeTerminalMatcher(
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
      [],
    );

    assert.equal(matchesOpenCodeTerminal({ name: "$(bell) Shared" }, matcher), true);
    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: "$(bell) Shared" },
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
    ), "restore-1");
  });

  it("matches OpenCode terminals even when the title has a state prefix", () => {
    const matcher = createOpenCodeTerminalMatcher(
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
      [],
    );

    assert.equal(matchesOpenCodeTerminal({ name: `${OPENCODE_TERMINAL_STATE_PREFIXES.permission}Shared` }, matcher), true);
    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: `${OPENCODE_TERMINAL_STATE_PREFIXES.error}Shared` },
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared" }],
      undefined,
    ), "restore-1");
  });

  it("does not strip state-like prefixes from genuine session titles", () => {
    const matcher = createOpenCodeTerminalMatcher(
      [{ opened: true, restoreId: "restore-1", terminalName: `${OPENCODE_TERMINAL_STATE_PREFIXES.running}Investigate flaky tests` }],
      undefined,
      [],
    );

    assert.equal(matchesOpenCodeTerminal({ name: `${OPENCODE_TERMINAL_STATE_PREFIXES.running}Investigate flaky tests` }, matcher), true);
    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: `${OPENCODE_TERMINAL_STATE_PREFIXES.running}Investigate flaky tests` },
      [{ opened: true, restoreId: "restore-1", terminalName: `${OPENCODE_TERMINAL_STATE_PREFIXES.running}Investigate flaky tests` }],
      undefined,
    ), "restore-1");
    assert.equal(resolveOpenCodeTerminalRestoreId(
      { name: "Investigate flaky tests" },
      [{ opened: true, restoreId: "restore-1", terminalName: `${OPENCODE_TERMINAL_STATE_PREFIXES.running}Investigate flaky tests` }],
      undefined,
    ), undefined);
  });


  it("uses caller-provided restore ids for legacy matcher and resolver hydration", () => {
    const restoreInfos = [{ opened: true, terminalName: "legacy restored terminal" }];
    const matcher = createOpenCodeTerminalMatcher(restoreInfos, undefined, [], () => "restore-1");

    assert.equal(matchesOpenCodeTerminal({ name: "restore-1" }, matcher), true);
    assert.equal(
      resolveOpenCodeTerminalRestoreId({ name: "restore-1" }, restoreInfos, undefined, () => "restore-1"),
      "restore-1",
    );
  });

  it("recovers a restore id from persisted terminal process ids", () => {
    const restoreId = resolveOpenCodeTerminalRestoreId(
      { name: "node", processId: 4321 },
      [{ opened: true, restoreId: "restore-1", terminalName: "Shared", terminalProcessId: 4321 }],
      undefined,
    );

    assert.equal(restoreId, "restore-1");
  });

  it("waits briefly for VS Code terminal restoration before giving up", async () => {
    let checks = 0;

    const restored = await waitForOpenCodeTerminalRestore(
      () => {
        checks += 1;
        return checks >= 3;
      },
      {
        timeoutMs: 50,
        pollIntervalMs: 1,
        wait: async () => undefined,
      },
    );

    assert.equal(restored, true);
    assert.equal(checks, 3);
  });

  it("resolves terminal titles from the exact saved session first", () => {
    assert.deepEqual(
      resolveSessionTitle(
        {
          sessionId: "ses_exact",
          sessionLabel: "Shared",
          terminalName: "new session",
        },
        {
          exactSession: { id: "ses_exact", title: "Exact Title", directory: "/workspace", updated: 20 },
          latestSession: { id: "ses_latest", title: "Latest Title", directory: "/workspace", updated: 30 },
        },
      ),
      {
        terminalName: "Exact Title",
        sessionLabel: "Exact Title",
        sessionId: "ses_exact",
        updated: 20,
      },
    );
  });

  it("ignores child exact sessions when reconciling the restored terminal title", () => {
    assert.deepEqual(
      resolveSessionTitle(
        {
          sessionId: "ses_child",
          sessionLabel: "Shared",
          terminalName: "new session",
        },
        {
          exactSession: { id: "ses_child", title: "Child Title", directory: "/workspace", updated: 20, parentId: "ses_parent" },
          latestSession: { id: "ses_parent", title: "Parent Title", directory: "/workspace", updated: 30 },
        },
      ),
      {
        terminalName: "Parent Title",
        sessionLabel: "Parent Title",
        sessionId: "ses_parent",
        updated: 30,
      },
    );
  });

  it("falls back to the stored terminal title when no matching session metadata exists", () => {
    assert.deepEqual(
      resolveSessionTitle(
        {
          sessionId: "ses_missing",
          terminalName: "Recovered Title",
        },
        {},
      ),
      {
        terminalName: "Recovered Title",
        sessionId: "ses_missing",
      },
    );
  });

  it("strips legacy state prefixes from fallback titles", () => {
    assert.deepEqual(
      resolveSessionTitle(
        {
          sessionId: "ses_exact",
          terminalName: `${OPENCODE_TERMINAL_STATE_PREFIXES.idle}Shared`,
        },
        {},
      ),
      {
        terminalName: "Shared",
        sessionId: "ses_exact",
      },
    );
  });

  it("fallback title resolution omits child sessionId when exact session is a child and no latest fallback exists", () => {
    assert.deepEqual(
      resolveSessionTitle(
        {
          sessionId: "ses_child",
          terminalName: "Recovered Title",
        },
        {
          exactSession: { id: "ses_child", title: "Child Title", directory: "/workspace", updated: 20, parentId: "ses_parent" },
        },
      ),
      {
        terminalName: "Recovered Title",
      },
    );
  });

  it("ignores child sessions when recovering by startedAt and directory", () => {
    const latest = readLatestSessionForDirectory([
      { id: "ses_child", title: "Child", directory: "/workspace", created: 101, updated: 120, parentId: "ses_parent" },
      { id: "ses_parent", title: "Parent", directory: "/workspace", created: 102, updated: 121 },
    ], "/workspace", 100);

    assert.deepEqual(latest, {
      id: "ses_parent",
      title: "Parent",
      directory: "/workspace",
      created: 102,
      updated: 121,
    });
  });

  it("retries title resolution only for unlabeled sessions still using the fallback title", () => {
    assert.equal(
      shouldRetrySessionTitleResolution({ terminalName: "new session" }, "new session"),
      true,
    );
    assert.equal(
      shouldRetrySessionTitleResolution({ terminalName: "new session", sessionLabel: "Real Title" }, "Real Title"),
      false,
    );
    assert.equal(
      shouldRetrySessionTitleResolution({ terminalName: "new session", sessionId: "ses_1" }, "new session"),
      true,
    );
    assert.equal(
      shouldRetrySessionTitleResolution({ terminalName: "new session", sessionId: "ses_1" }, "Recovered Title", "Recovered Title"),
      false,
    );
  });

  it("detects unchanged restore state so callers can skip memento writes", () => {
    const state = {
      restoreStateEnabled: true,
      latestRestoreInfo: undefined,
      restoreInfos: [],
      trackedRestoreIds: ["restore-1"],
    };

    const result = updatePersistedRestoreStateSnapshot(state, (current) => current);

    assert.equal(result.shouldWriteRestoreStateEnabled, false);
    assert.equal(result.shouldWriteLatestRestoreInfo, false);
    assert.equal(result.shouldWriteRestoreInfos, false);
    assert.equal(result.shouldWriteTrackedRestoreIds, false);
  });

});
