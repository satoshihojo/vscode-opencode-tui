import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionRestoreId,
  dedupeSessionsByTitle,
} from "../../src/opencode/session-restore";
import type { OpenCodeSessionSummary } from "../../src/opencode/session-repository";

describe("session restore", () => {
  it("createSessionRestoreId returns a unique id each call", () => {
    const a = createSessionRestoreId();
    const b = createSessionRestoreId();
    assert.ok(typeof a === "string");
    assert.ok(typeof b === "string");
    assert.notEqual(a, b);
  });

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
      dedupeSessionsByTitle(sessions).map((session) => session.id),
      ["ses_latest", "ses_unique", "ses_untitled_1", "ses_untitled_2"],
    );
  });
});
