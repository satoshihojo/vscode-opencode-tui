import { QUICK_PICK_RECORDING_FILTER } from "./recording-sandbox";

export const RECORDING_VIEWPORT = {
  width: 1280,
  height: 1024,
} as const;

export type RecordingPoint = {
  x: number;
  y: number;
};

export type RecordingCoordinates = {
  openSession: RecordingPoint;
  quickPickSession: RecordingPoint;
  tuiClick: RecordingPoint;
  sessionRefactor: RecordingPoint;
  sessionRefactorClose: RecordingPoint;
  reviewFirst: RecordingPoint;
  reviewKeep: RecordingPoint;
  reviewSecond: RecordingPoint;
  reviewThird: RecordingPoint;
};

export type RecordingStep =
  | {
    type: "click";
    label: string;
    point: RecordingPoint;
    afterMs: number;
  }
  | {
    type: "key";
    label: string;
    key: string;
    afterMs: number;
  }
  | {
    type: "text";
    label: string;
    text: string;
    afterMs: number;
  };

const DEFAULT_COORDINATES: RecordingCoordinates = {
  openSession: { x: 927, y: 708 },
  quickPickSession: { x: 640, y: 160 },
  tuiClick: { x: 939, y: 536 },
  sessionRefactor: { x: 914, y: 797 },
  sessionRefactorClose: { x: 831, y: 798 },
  reviewFirst: { x: 509, y: 758 },
  reviewKeep: { x: 374, y: 756 },
  reviewSecond: { x: 509, y: 779 },
  reviewThird: { x: 509, y: 801 },
};

export function readRecordingCoordinates(env: NodeJS.ProcessEnv = process.env): RecordingCoordinates {
  return {
    openSession: readPoint(env, "OPENCODE_EDIT_RECORD_OPEN_SESSION", DEFAULT_COORDINATES.openSession),
    quickPickSession: readPoint(env, "OPENCODE_EDIT_RECORD_QUICK_PICK_SESSION", DEFAULT_COORDINATES.quickPickSession),
    tuiClick: readPoint(env, "OPENCODE_EDIT_RECORD_TUI_CLICK", DEFAULT_COORDINATES.tuiClick),
    sessionRefactor: readPoint(env, "OPENCODE_EDIT_RECORD_SESSION_REFACTOR", DEFAULT_COORDINATES.sessionRefactor),
    sessionRefactorClose: readPoint(env, "OPENCODE_EDIT_RECORD_SESSION_REFACTOR_CLOSE", DEFAULT_COORDINATES.sessionRefactorClose),
    reviewFirst: readPoint(env, "OPENCODE_EDIT_RECORD_REVIEW_FIRST", DEFAULT_COORDINATES.reviewFirst),
    reviewKeep: readPoint(env, "OPENCODE_EDIT_RECORD_REVIEW_KEEP", DEFAULT_COORDINATES.reviewKeep),
    reviewSecond: readPoint(env, "OPENCODE_EDIT_RECORD_REVIEW_SECOND", DEFAULT_COORDINATES.reviewSecond),
    reviewThird: readPoint(env, "OPENCODE_EDIT_RECORD_REVIEW_THIRD", DEFAULT_COORDINATES.reviewThird),
  };
}

export function buildRecordingSteps(coordinates: RecordingCoordinates): RecordingStep[] {
  return [
    {
      type: "click",
      label: "Open Session row",
      point: coordinates.openSession,
      afterMs: 900,
    },
    {
      type: "text",
      label: "Filter Quick Pick",
      text: QUICK_PICK_RECORDING_FILTER,
      afterMs: 700,
    },
    {
      type: "click",
      label: "Open Quick Pick session",
      point: coordinates.quickPickSession,
      afterMs: 10000,
    },
    {
      type: "click",
      label: "Open Session row again",
      point: coordinates.openSession,
      afterMs: 900,
    },
    {
      type: "click",
      label: "Open Quick Pick new session",
      point: coordinates.quickPickSession,
      afterMs: 10000,
    },
    {
      type: "click",
      label: "Switch to refactor session row",
      point: coordinates.sessionRefactor,
      afterMs: 10000,
    },
    {
      type: "click",
      label: "Close refactor session row",
      point: coordinates.sessionRefactorClose,
      afterMs: 10000,
    },
    {
      type: "click",
      label: "Switch to first review diff",
      point: coordinates.reviewFirst,
      afterMs: 1000,
    },
    {
      type: "click",
      label: "Keep first review item",
      point: coordinates.reviewKeep,
      afterMs: 1000,
    },
    {
      type: "click",
      label: "Keep second review item",
      point: coordinates.reviewKeep,
      afterMs: 1000,
    },
    {
      type: "click",
      label: "Keep third review item",
      point: coordinates.reviewKeep,
      afterMs: 1000,
    },
  ];
}

function readPoint(env: NodeJS.ProcessEnv, key: string, fallback: RecordingPoint): RecordingPoint {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const match = raw.match(/^(\d+)\s*,\s*(\d+)$/);
  if (!match) {
    return fallback;
  }

  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return fallback;
  }

  return { x, y };
}
