import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRecordingTrimFilter, buildRecordingTrimSegments } from "../integration/recording/recording-trim";

describe("recording trim", () => {
  it("cuts the middle out of marked long waits using recorded timings", () => {
    const segments = buildRecordingTrimSegments([
      {
        startedAtMs: 100,
        actionCompletedAtMs: 900,
        waitStartedAtMs: 1_100,
        waitCompletedAtMs: 10_980,
        afterMs: 10_000,
        trimTrailingPause: true,
      },
      {
        startedAtMs: 11_040,
        actionCompletedAtMs: 11_400,
        waitStartedAtMs: 11_400,
        waitCompletedAtMs: 12_400,
        afterMs: 1_000,
        trimTrailingPause: false,
      },
      {
        startedAtMs: 12_500,
        actionCompletedAtMs: 12_900,
        waitStartedAtMs: 13_400,
        waitCompletedAtMs: 22_940,
        afterMs: 10_000,
        trimTrailingPause: true,
      },
    ], 24_000);

    assert.deepEqual(segments, [
      { startMs: 0, endMs: 1_350 },
      { startMs: 10_730, endMs: 13_650 },
      { startMs: 22_690, endMs: 24_000 },
    ]);
  });

  it("keeps the full recording when no waits are marked for trimming", () => {
    const segments = buildRecordingTrimSegments([
      {
        startedAtMs: 0,
        actionCompletedAtMs: 500,
        waitStartedAtMs: 500,
        waitCompletedAtMs: 1_500,
        afterMs: 1_000,
        trimTrailingPause: false,
      },
    ], 2_000);

    assert.deepEqual(segments, [{ startMs: 0, endMs: 2_000 }]);
  });

  it("builds a concat filter for multiple segments", () => {
    const filter = buildRecordingTrimFilter([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]);

    assert.match(filter, /trim=start=0\.000:end=1\.000/);
    assert.match(filter, /trim=start=2\.000:end=3\.000/);
    assert.match(filter, /concat=n=2:v=1:a=0\[vout\]/);
  });
});
