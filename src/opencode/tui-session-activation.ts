import type { TuiSessionActiveMessage } from "../bridge-protocol";
import type { OpenCodeSessionSummary } from "./session-repository";
import { isValidSessionId } from "./session-manager";

export type TuiSessionActivationRestoreInfo = {
  restoreId: string;
  cwd?: string;
};

export type TuiSessionActivationDeps<T extends TuiSessionActivationRestoreInfo> = {
  restoreInfoForPort(openCodePort: number | undefined): T | undefined;
  shouldProcessActivation?(restoreInfo: T, message: TuiSessionActiveMessage): boolean;
  findSessionById(sessionId: string, cwd?: string): Promise<OpenCodeSessionSummary | undefined>;
  confirmSession(restoreInfo: T, session: OpenCodeSessionSummary): Promise<void> | void;
  onError?(error: Error, restoreId: string): void;
};

export type TuiSessionActivationResult = "accepted" | "ignored" | "retry";

export async function handleTuiActiveSession<T extends TuiSessionActivationRestoreInfo>(
  message: TuiSessionActiveMessage,
  deps: TuiSessionActivationDeps<T>,
): Promise<TuiSessionActivationResult> {
  if (!isValidSessionId(message.sessionID)) {
    return "ignored";
  }

  if (message.sessionID.length > 128) {
    return "ignored";
  }

  const restoreInfo = deps.restoreInfoForPort(message.openCodePort);
  if (!restoreInfo) {
    return "retry";
  }

  if (deps.shouldProcessActivation && !deps.shouldProcessActivation(restoreInfo, message)) {
    return "ignored";
  }

  try {
    const session = await deps.findSessionById(message.sessionID, restoreInfo.cwd);
    if (!session) {
      return "retry";
    }

    if (session.parentId || session.id !== message.sessionID) {
      return "ignored";
    }

    if (deps.shouldProcessActivation && !deps.shouldProcessActivation(restoreInfo, message)) {
      return "ignored";
    }

    await deps.confirmSession(restoreInfo, mergeTuiSessionSnapshot(session, message));
    return "accepted";
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), restoreInfo.restoreId);
    return "retry";
  }
}

function mergeTuiSessionSnapshot(session: OpenCodeSessionSummary, message: TuiSessionActiveMessage): OpenCodeSessionSummary {
  const title = sanitizeDisplayText(message.title, 240) ?? sanitizeDisplayText(session.title, 240);
  const updated = message.updated ?? session.updated;
  return {
    ...session,
    ...(title ? { title } : {}),
    ...(updated !== undefined ? { updated } : {}),
  };
}

function sanitizeDisplayText(value: string | undefined, maxLength: number) {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }

  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 3)}...`;
}
