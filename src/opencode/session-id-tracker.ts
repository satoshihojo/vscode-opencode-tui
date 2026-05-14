export type RestoreSessionTrackingState = {
  confirmedSessionId?: string;
  pendingSessionIds: string[];
};

export function createRestoreSessionTrackingState(sessionId?: string): RestoreSessionTrackingState {
  return sessionId
    ? { confirmedSessionId: sessionId, pendingSessionIds: [] }
    : { pendingSessionIds: [] };
}

export function queueRestoreSessionCandidate(
  state: RestoreSessionTrackingState,
  nextSessionId: string | undefined,
): RestoreSessionTrackingState {
  if (!nextSessionId || state.confirmedSessionId === nextSessionId || state.pendingSessionIds.includes(nextSessionId)) {
    return state;
  }

  return {
    ...state,
    pendingSessionIds: [...state.pendingSessionIds, nextSessionId],
  };
}

export function confirmRestoreSessionId(
  state: RestoreSessionTrackingState,
  confirmedSessionId: string,
): RestoreSessionTrackingState {
  if (state.confirmedSessionId && state.confirmedSessionId !== confirmedSessionId && !state.pendingSessionIds.includes(confirmedSessionId)) {
    return state;
  }

  return {
    confirmedSessionId,
    pendingSessionIds: state.confirmedSessionId && state.confirmedSessionId !== confirmedSessionId
      ? []
      : state.pendingSessionIds.filter((sessionId) => sessionId !== confirmedSessionId),
  };
}

export function discardRestoreSessionCandidate(
  state: RestoreSessionTrackingState,
  discardedSessionId: string,
): RestoreSessionTrackingState {
  return {
    ...state,
    pendingSessionIds: state.pendingSessionIds.filter((sessionId) => sessionId !== discardedSessionId),
  };
}
