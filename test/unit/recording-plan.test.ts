import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRecordingSteps, readRecordingCoordinates } from "../integration/recording/recording-plan";

describe("recording plan", () => {
  it("reads coordinate overrides from the environment", () => {
    const coordinates = readRecordingCoordinates({
      OPENCODE_EDIT_RECORD_OPEN_SESSION: "210,780",
      OPENCODE_EDIT_RECORD_QUICK_PICK_SESSION: "350,180",
      OPENCODE_EDIT_RECORD_TUI_CLICK: "939,536",
      OPENCODE_EDIT_RECORD_SESSION_REFACTOR: "220,844",
      OPENCODE_EDIT_RECORD_SESSION_REFACTOR_CLOSE: "190,844",
      OPENCODE_EDIT_RECORD_REVIEW_KEEP: "380,740",
    });

    assert.deepEqual(coordinates.openSession, { x: 210, y: 780 });
    assert.deepEqual(coordinates.quickPickSession, { x: 350, y: 180 });
    assert.deepEqual(coordinates.tuiClick, { x: 939, y: 536 });
    assert.deepEqual(coordinates.sessionRefactor, { x: 220, y: 844 });
    assert.deepEqual(coordinates.sessionRefactorClose, { x: 190, y: 844 });
    assert.deepEqual(coordinates.reviewKeep, { x: 380, y: 740 });
    assert.deepEqual(coordinates.reviewFirst, { x: 509, y: 758 });
  });

  it("falls back to defaults for invalid coordinate overrides", () => {
    const coordinates = readRecordingCoordinates({
      OPENCODE_EDIT_RECORD_OPEN_SESSION: "not-a-point",
    });

    assert.deepEqual(coordinates.openSession, { x: 927, y: 708 });
  });

  it("builds the expected interaction sequence", () => {
    const steps = buildRecordingSteps(readRecordingCoordinates({}));

    assert.deepEqual(steps.map((step) => step.label), [
      "Open Session row",
      "Filter Quick Pick",
      "Open Quick Pick session",
      "Open Session row again",
      "Open Quick Pick new session",
      "Switch to refactor session row",
      "Close refactor session row",
      "Switch to first review diff",
      "Keep first review item",
      "Keep second review item",
      "Keep third review item",
    ]);
    assert.equal(steps[0]?.type, "click");
    assert.equal(steps[1]?.type, "text");
    assert.equal(steps[2]?.type, "click");
    assert.equal(steps[2]?.afterMs, 10000);
    assert.equal(steps[3]?.afterMs, 900);
    assert.equal(steps[4]?.afterMs, 10000);
    assert.equal(steps[5]?.afterMs, 10000);
    assert.equal(steps[6]?.afterMs, 10000);
    assert.equal(steps[7]?.afterMs, 1000);
    assert.equal(steps[8]?.afterMs, 1000);
    assert.equal(steps[9]?.afterMs, 1000);
    assert.equal(steps[10]?.afterMs, 1000);
  });
});
