import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSessionUpdatedLabel, readSessionDirectoryLabel } from "../../src/opencode/session-display";

describe("session display", () => {
  it("formats directory labels and updated timestamps for session metadata", () => {
    const today = new Date(2026, 4, 5, 14, 30, 0);
    const earlierToday = new Date(2026, 4, 5, 9, 30, 0);
    const earlierThisYear = new Date(2026, 4, 4, 14, 30, 0);
    const previousYear = new Date(2025, 4, 20, 14, 30, 0);

    assert.equal(readSessionDirectoryLabel("/workspace/project"), "project");
    assert.equal(readSessionDirectoryLabel("C:\\workspace\\project"), "project");

    assert.equal(formatSessionUpdatedLabel(earlierToday.getTime(), { now: today }), "09:30");
    assert.equal(formatSessionUpdatedLabel(earlierThisYear.getTime(), { now: today }), "14:30 05-04");
    assert.equal(formatSessionUpdatedLabel(previousYear.getTime(), { now: today }), "14:30 2025-05-20");
    assert.equal(formatSessionUpdatedLabel(String(Math.trunc(earlierToday.getTime() / 1000)), { now: today }), "09:30");
  });

  it("returns undefined for missing or invalid updated values", () => {
    assert.equal(readSessionDirectoryLabel(undefined), undefined);
    assert.equal(formatSessionUpdatedLabel(undefined), undefined);
    assert.equal(formatSessionUpdatedLabel("not-a-time"), undefined);
    assert.equal(formatSessionUpdatedLabel(10), undefined);
  });
});
