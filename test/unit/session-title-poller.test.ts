import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeSessionTitlePoller, type SessionTitlePollerScheduler } from "../../src/opencode/session-title-poller";
import type { OpenCodeSessionSummary } from "../../src/opencode/session-repository";

describe("OpenCodeSessionTitlePoller", () => {
  it("polls valid tracked sessions and emits top-level title changes", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ sessionId: string; cwd?: string }> = [];
    const updates: Array<{ restoreId: string; sessionId: string; title: string; previousTitle?: string; updated?: number | string }> = [];
    const poller = new OpenCodeSessionTitlePoller({
      intervalMs: 2500,
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId, cwd) => {
          calls.push({ sessionId, cwd });
          return { id: sessionId, title: calls.length === 1 ? "First" : "Renamed", directory: cwd, updated: 1712401200000 };
        },
      },
      onTitleChanged: (update) => updates.push(update),
    });

    poller.track({ restoreId: "restore-1", sessionId: "ses_1", cwd: "/workspace", title: "First", updated: 1712401200000 });

    assert.deepEqual(scheduler.intervals.map((interval) => interval.ms), [2500]);
    await scheduler.tick();
    await scheduler.tick();

    assert.deepEqual(calls, [
      { sessionId: "ses_1", cwd: "/workspace" },
      { sessionId: "ses_1", cwd: "/workspace" },
    ]);
    assert.deepEqual(updates, [{ restoreId: "restore-1", sessionId: "ses_1", title: "Renamed", previousTitle: "First", updated: 1712401200000 }]);
  });

  it("ignores invalid, missing, child, missing, and unchanged sessions", async () => {
    const scheduler = createFakeScheduler();
    const rows = new Map<string, OpenCodeSessionSummary | undefined>([
      ["ses_child", { id: "ses_child", title: "Child", parentId: "ses_parent" }],
      ["ses_missing", undefined],
      ["ses_same", { id: "ses_same", title: "Same" }],
    ]);
    const updates: Array<{ restoreId: string; title: string }> = [];
    const poller = new OpenCodeSessionTitlePoller({
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId) => rows.get(sessionId),
      },
      onTitleChanged: (update) => updates.push(update),
    });

    poller.track({ restoreId: "invalid", sessionId: "bad" });
    poller.track({ restoreId: "missing" });
    poller.track({ restoreId: "child", sessionId: "ses_child" });
    poller.track({ restoreId: "not-found", sessionId: "ses_missing" });
    poller.track({ restoreId: "same", sessionId: "ses_same", title: "Same" });

    await scheduler.tick();

    assert.deepEqual(updates, []);
  });

  it("keeps polling after repository errors and stops on dispose", async () => {
    const scheduler = createFakeScheduler();
    const errors: string[] = [];
    let calls = 0;
    const poller = new OpenCodeSessionTitlePoller({
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("locked");
          }
          return { id: sessionId, title: "Recovered" };
        },
      },
      onTitleChanged: () => {},
      onError: (error) => errors.push(error.message),
    });

    poller.track({ restoreId: "restore-1", sessionId: "ses_1" });
    await scheduler.tick();
    await scheduler.tick();
    poller.dispose();
    await scheduler.tick();

    assert.deepEqual(errors, ["locked"]);
    assert.equal(calls, 2);
    assert.equal(scheduler.cleared.length, 1);
  });

  it("uses updated tracked values and removes entries", async () => {
    const scheduler = createFakeScheduler();
    const calls: Array<{ sessionId: string; cwd?: string }> = [];
    const poller = new OpenCodeSessionTitlePoller({
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId, cwd) => {
          calls.push({ sessionId, cwd });
          return { id: sessionId, title: sessionId };
        },
      },
      onTitleChanged: () => {},
    });

    poller.track({ restoreId: "restore-1", sessionId: "ses_1", cwd: "/one" });
    await scheduler.tick();
    poller.track({ restoreId: "restore-1", sessionId: "ses_2" });
    await scheduler.tick();
    poller.track({ restoreId: "restore-1", sessionId: "ses_2", cwd: "/two" });
    await scheduler.tick();
    poller.remove("restore-1");
    await scheduler.tick();

    assert.deepEqual(calls, [
      { sessionId: "ses_1", cwd: "/one" },
      { sessionId: "ses_2", cwd: "/one" },
      { sessionId: "ses_2", cwd: "/two" },
    ]);
  });

  it("clears tracked updated timestamps when re-tracked with an explicit undefined updated value", async () => {
    const scheduler = createFakeScheduler();
    const updates: Array<{ restoreId: string; title: string; updated?: number | string }> = [];
    const poller = new OpenCodeSessionTitlePoller({
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId) => ({
          id: sessionId,
          title: "Stable",
        }),
      },
      onTitleChanged: (update) => updates.push(update),
    });

    poller.track({ restoreId: "restore-1", sessionId: "ses_1", title: "Stable", updated: 10 });
    poller.track({ restoreId: "restore-1", sessionId: "ses_1", title: "Stable", updated: undefined });
    await scheduler.tick();

    assert.deepEqual(updates, []);
  });

  it("emits when only the updated timestamp changes", async () => {
    const scheduler = createFakeScheduler();
    const updates: Array<{ restoreId: string; title: string; updated?: number | string; previousTitle?: string }> = [];
    let callCount = 0;
    const poller = new OpenCodeSessionTitlePoller({
      scheduler,
      repository: {
        findSessionByIdAsync: async (sessionId) => {
          callCount += 1;
          return {
            id: sessionId,
            title: "Stable",
            updated: callCount === 1 ? 20 : 20,
          };
        },
      },
      onTitleChanged: (update) => updates.push(update),
    });

    poller.track({ restoreId: "restore-1", sessionId: "ses_1", title: "Stable", updated: 10 });
    await scheduler.tick();

    assert.deepEqual(updates, [{ restoreId: "restore-1", sessionId: "ses_1", title: "Stable", updated: 20 }]);
  });
});

function createFakeScheduler() {
  let nextId = 1;
  const intervals: Array<{ id: number; ms: number; handler: () => void }> = [];
  const cleared: number[] = [];
  const scheduler: SessionTitlePollerScheduler & {
    intervals: typeof intervals;
    cleared: typeof cleared;
    tick(): Promise<void>;
  } = {
    intervals,
    cleared,
    setInterval: (handler, ms) => {
      const id = nextId++;
      intervals.push({ id, ms, handler });
      return id;
    },
    clearInterval: (handle) => {
      cleared.push(Number(handle));
      const index = intervals.findIndex((interval) => interval.id === handle);
      if (index >= 0) {
        intervals.splice(index, 1);
      }
    },
    tick: async () => {
      for (const interval of [...intervals]) {
        interval.handler();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return scheduler;
}
