import type { OpenCodeEvent } from "./session-event-monitor";
import { isValidSessionId } from "./session-manager";
import type { OpenCodeTerminalLabelState } from "./terminal-attention";

export function readOpenCodeEventSessionId(event: OpenCodeEvent) {
  const info = readRecord(event.properties?.info);
  const sessionId = event.properties?.sessionID
    ?? event.properties?.sessionId
    ?? info?.id
    ?? info?.sessionID
    ?? info?.sessionId;
  return typeof sessionId === "string" && isValidSessionId(sessionId) ? sessionId : undefined;
}

export function shouldReconcileTitleForEvent(
  event: OpenCodeEvent,
  previousState?: OpenCodeTerminalLabelState,
  nextState?: OpenCodeTerminalLabelState,
) {
  if (previousState && nextState) {
    return previousState !== nextState;
  }

  if (event.type !== "session.status") {
    return event.type === "session.updated" || event.type === "session.idle" || event.type === "session.error" || event.type === "permission.updated" || event.type === "permission.replied";
  }

  const status = event.properties?.status;
  const statusRecord = status && typeof status === "object" && !Array.isArray(status)
    ? status as Record<string, unknown>
    : undefined;
  const statusType = typeof statusRecord?.type === "string"
    ? statusRecord.type
    : undefined;
  return statusType === "busy" || statusType === "idle";
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
