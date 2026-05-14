export type RecordedStepTiming = {
  startedAtMs: number;
  actionCompletedAtMs: number;
  waitStartedAtMs: number;
  waitCompletedAtMs: number;
  afterMs: number;
  trimTrailingPause: boolean;
};

export type RecordingSegment = {
  startMs: number;
  endMs: number;
};

const TRIMMED_WAIT_START_BUFFER_MS = 250;
const TRIMMED_WAIT_END_BUFFER_MS = 250;

export function buildRecordingTrimSegments(stepTimings: RecordedStepTiming[], totalDurationMs: number): RecordingSegment[] {
  if (totalDurationMs <= 0) {
    return [];
  }

  const trimSegments = mergeRecordingSegments(stepTimings.flatMap((stepTiming) => {
    if (!stepTiming.trimTrailingPause) {
      return [];
    }

    const startMs = Math.max(0, Math.floor(stepTiming.waitStartedAtMs + TRIMMED_WAIT_START_BUFFER_MS));
    const endMs = Math.min(totalDurationMs, Math.ceil(stepTiming.waitCompletedAtMs - TRIMMED_WAIT_END_BUFFER_MS));
    if (endMs <= startMs) {
      return [];
    }

    return [{ startMs, endMs }];
  }));

  if (trimSegments.length === 0) {
    return [{ startMs: 0, endMs: totalDurationMs }];
  }

  return invertRecordingSegments(trimSegments, totalDurationMs);
}

export function buildRecordingTrimFilter(segments: RecordingSegment[]): string {
  if (segments.length === 0) {
    throw new Error("Expected at least one recording trim segment.");
  }

  if (segments.length === 1) {
    const [segment] = segments;
    return `[0:v]trim=start=${formatSeconds(segment.startMs)}:end=${formatSeconds(segment.endMs)},setpts=PTS-STARTPTS[vout]`;
  }

  const trims = segments.map((segment, index) => {
    return `[0:v]trim=start=${formatSeconds(segment.startMs)}:end=${formatSeconds(segment.endMs)},setpts=PTS-STARTPTS[v${index}]`;
  });
  const concatInputs = segments.map((_, index) => `[v${index}]`).join("");
  return `${trims.join(";")};${concatInputs}concat=n=${segments.length}:v=1:a=0[vout]`;
}

function mergeRecordingSegments(segments: RecordingSegment[]): RecordingSegment[] {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: RecordingSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (!previous || segment.startMs > previous.endMs) {
      merged.push({ ...segment });
      continue;
    }

    previous.endMs = Math.max(previous.endMs, segment.endMs);
  }
  return merged;
}

function invertRecordingSegments(trimSegments: RecordingSegment[], totalDurationMs: number): RecordingSegment[] {
  const keepSegments: RecordingSegment[] = [];
  let cursorMs = 0;

  for (const segment of trimSegments) {
    if (segment.startMs > cursorMs) {
      keepSegments.push({ startMs: cursorMs, endMs: segment.startMs });
    }
    cursorMs = Math.max(cursorMs, segment.endMs);
  }

  if (cursorMs < totalDurationMs) {
    keepSegments.push({ startMs: cursorMs, endMs: totalDurationMs });
  }

  return keepSegments.filter((segment) => segment.endMs > segment.startMs);
}

function formatSeconds(valueMs: number) {
  return (valueMs / 1000).toFixed(3);
}
