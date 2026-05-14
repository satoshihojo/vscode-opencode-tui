import type { OpenCodeEvent } from "../opencode/session-event-monitor";

export type NotificationStatus =
  | { kind: "clear"; count: 0; label: string }
  | { kind: "busy"; count: number; label: string }
  | { kind: "idle"; count: number; label: string }
  | { kind: "permission"; count: number; label: string }
  | { kind: "error"; count: number; label: string };

export type NotificationUi = {
  isFocused(): boolean;
  setStatus(status: NotificationStatus, source?: OpenCodeNotificationSource): void;
  markAttention?(source?: OpenCodeNotificationSource): void;
};

export type ExternalNotificationKind = "idle" | "permission" | "error";

export type ExternalNotification = {
  kind: ExternalNotificationKind;
  title: string;
  message: string;
  source?: OpenCodeNotificationSource;
};

export type OpenCodeSourceState = "running" | "permission" | "error" | "idle" | "normal";

export type ExternalNotifier = {
  notify(notification: ExternalNotification): void;
};

export type OpenCodeNotificationSource = {
  restoreId?: string;
  sessionId?: string;
};

export type OpenCodeNotificationSettings = {
  enabled: boolean;
  backgroundOnly: boolean;
  onIdle: boolean;
  onPermission: boolean;
  onError: boolean;
};

type SessionState = {
  busySeen: boolean;
  busy: boolean;
  compacting: boolean;
  source?: OpenCodeNotificationSource;
};

type RestoreState = {
  activeSessionIds: Set<string>;
  compactingSessionIds: Set<string>;
  busySeen: boolean;
  source?: OpenCodeNotificationSource;
  idleTimer?: NodeJS.Timeout;
};

export type OpenCodeBackgroundNotifierOptions = {
  idleSettleDelayMs?: number;
};

const MAX_TRACKED_ITEMS = 100;
const MAX_IDENTIFIER_LENGTH = 128;
const POPUP_COOLDOWN_MS = 5000;
const MAX_DISPLAY_TEXT_LENGTH = 240;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const GLOBAL_ERROR_KEY = "global";
const DEFAULT_IDLE_SETTLE_DELAY_MS = 250;

export class OpenCodeBackgroundNotifier {
  private readonly sessions = new Map<string, SessionState>();
  private readonly restores = new Map<string, RestoreState>();
  private readonly pendingPermissions = new Map<string, { title: string; source?: OpenCodeNotificationSource }>();
  private readonly finishedSessions = new Map<string, OpenCodeNotificationSource | undefined>();
  private readonly errors = new Map<string, OpenCodeNotificationSource | undefined>();
  private readonly lastPopupAt = new Map<string, number>();

  constructor(
    private readonly ui: NotificationUi,
    private settings: OpenCodeNotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
    private readonly externalNotifier?: ExternalNotifier,
    private readonly options: OpenCodeBackgroundNotifierOptions = {},
  ) {}

  updateSettings(settings: OpenCodeNotificationSettings) {
    this.settings = settings;
    this.recomputeStatus();
  }

  readSourceState(source: OpenCodeNotificationSource): OpenCodeSourceState {
    if (this.hasErrorForSource(source)) {
      return "error";
    }

    if (this.hasPermissionForSource(source)) {
      return "permission";
    }

    if (this.isSourceBusy(source)) {
      return "running";
    }

    if (this.hasFinishedSource(source)) {
      return "idle";
    }

    return "normal";
  }

  handleEvent(event: OpenCodeEvent, source: OpenCodeNotificationSource = {}) {
    switch (event.type) {
      case "session.status":
        this.handleSessionStatus(event.properties, source);
        break;
      case "session.idle":
        this.handleSessionIdle(readString(event.properties, "sessionID"), source);
        break;
      case "permission.updated":
      case "permission.asked":
        this.handlePermissionUpdated(event.properties, source);
        break;
      case "permission.replied":
        this.handlePermissionReplied(event.properties);
        break;
      case "session.error":
        this.handleSessionError(withSessionId(source, readIdentifier(event.properties, "sessionID")));
        break;
      case "message.part.updated":
      case "message.part.added":
        this.handleMessagePartUpdated(event.properties, source);
        break;
      default:
        break;
    }
  }

  setFocused(focused: boolean) {
    this.recomputeStatus();
  }

  clearSource(source: OpenCodeNotificationSource) {
    for (const [sessionId, state] of this.sessions) {
      if (matchesSource(state.source, source, sessionId)) {
        this.sessions.delete(sessionId);
      }
    }

    for (const [restoreId, state] of this.restores) {
      if (matchesSource(state.source, source)) {
        if (state.idleTimer) {
          clearTimeout(state.idleTimer);
        }
        this.restores.delete(restoreId);
      }
    }

    for (const [permissionId, permission] of this.pendingPermissions) {
      if (matchesSource(permission.source, source)) {
        this.pendingPermissions.delete(permissionId);
      }
    }

    for (const [sessionId, finishedSource] of this.finishedSessions) {
      if (matchesSource(finishedSource, source, sessionId)) {
        this.finishedSessions.delete(sessionId);
      }
    }

    for (const [key, errorSource] of this.errors) {
      if (matchesSource(errorSource, source, source.sessionId)) {
        this.errors.delete(key);
      }
    }

    this.recomputeStatus();
  }

  clearSourceExceptSession(source: OpenCodeNotificationSource, sessionId: string) {
    const validSessionId = validateIdentifier(sessionId);
    if (!validSessionId) {
      return;
    }

    for (const [candidateSessionId, state] of this.sessions) {
      if (candidateSessionId !== validSessionId && matchesSource(state.source, source, candidateSessionId)) {
        this.sessions.delete(candidateSessionId);
      }
    }

    if (source.restoreId) {
      const restoreState = this.restores.get(source.restoreId);
      if (restoreState) {
        for (const activeSessionId of [...restoreState.activeSessionIds]) {
          if (activeSessionId !== validSessionId) {
            restoreState.activeSessionIds.delete(activeSessionId);
          }
        }
        for (const compactingSessionId of [...restoreState.compactingSessionIds]) {
          if (compactingSessionId !== validSessionId) {
            restoreState.compactingSessionIds.delete(compactingSessionId);
          }
        }
        if (restoreState.activeSessionIds.size === 0 && restoreState.compactingSessionIds.size === 0) {
          if (restoreState.idleTimer) {
            clearTimeout(restoreState.idleTimer);
          }
          this.restores.delete(source.restoreId);
        }
      }
    }

    for (const [permissionId, permission] of this.pendingPermissions) {
      if (permission.source?.sessionId !== validSessionId && matchesSource(permission.source, source)) {
        this.pendingPermissions.delete(permissionId);
      }
    }

    for (const [finishedSessionId, finishedSource] of this.finishedSessions) {
      if (finishedSessionId !== validSessionId && matchesSource(finishedSource, source, finishedSessionId)) {
        this.finishedSessions.delete(finishedSessionId);
      }
    }

    for (const [key, errorSource] of this.errors) {
      if (errorSource?.sessionId !== validSessionId && matchesSource(errorSource, source, source.sessionId)) {
        this.errors.delete(key);
      }
    }

    this.recomputeStatus();
  }

  private handleSessionStatus(properties: Record<string, unknown> | undefined, source: OpenCodeNotificationSource) {
    const sessionId = readIdentifier(properties, "sessionID");
    const status = readRecord(properties, "status");
    const statusType = readString(status, "type");
    if (!sessionId || !statusType) {
      return;
    }

    const eventSource = withSessionId(source, sessionId);
    this.clearErrorsForSource(eventSource);
    const state = this.ensureSessionState(sessionId);
    state.source = eventSource;

    const restoreState = source.restoreId ? this.ensureRestoreState(source.restoreId) : undefined;
    if (restoreState) {
      restoreState.source = eventSource;
      if (restoreState.idleTimer) {
        clearTimeout(restoreState.idleTimer);
        restoreState.idleTimer = undefined;
      }
    }

    if (statusType === "busy") {
      state.busySeen = true;
      state.busy = true;
      if (restoreState) {
        restoreState.busySeen = true;
        restoreState.activeSessionIds.add(sessionId);
      } else {
        state.source = eventSource;
      }
      this.finishedSessions.delete(sessionId);
      if (source.restoreId) {
        this.finishedSessions.delete(source.restoreId);
      }
      this.recomputeStatus();
      return;
    }

    if (statusType === "idle") {
      if (state.compacting) {
        state.busy = true;
        if (restoreState) {
          restoreState.activeSessionIds.add(sessionId);
        }
        this.recomputeStatus();
        return;
      }

      state.busy = false;
      if (restoreState) {
        restoreState.activeSessionIds.delete(sessionId);
      }
      this.recomputeStatus();
    }
  }

  private handleSessionIdle(sessionId: string | undefined, source: OpenCodeNotificationSource) {
    sessionId = validateIdentifier(sessionId);
    if (!sessionId) {
      return;
    }

    if (source.restoreId) {
      this.handleRestoreSessionIdle(sessionId, source);
      return;
    }

    const state = this.sessions.get(sessionId);
    if (!state?.busySeen) {
      return;
    }

    if (state.compacting) {
      state.busy = true;
      this.recomputeStatus();
      return;
    }

    const eventSource = withSessionId(source.restoreId ? source : state.source ?? source, sessionId);
    this.sessions.delete(sessionId);
    this.evictOldestIfNeeded(this.finishedSessions);
    this.finishedSessions.set(sessionId, eventSource);
    this.recomputeStatus();
    this.markAttention("onIdle", eventSource);
    if (this.shouldShowPopup("onIdle", "idle")) {
      const message = "OpenCode session finished.";
      this.notifyExternal({ kind: "idle", title: "OpenCode", message, source: eventSource });
    }
  }

  private handlePermissionUpdated(properties: Record<string, unknown> | undefined, source: OpenCodeNotificationSource) {
    const id = readIdentifier(properties, "id");
    if (!id || this.pendingPermissions.has(id)) {
      return;
    }

    const sessionId = readIdentifier(properties, "sessionID");
    this.clearCompactingSession(sessionId, source);
    const title = sanitizeDisplayText(readPermissionTitle(properties), "permission required");
    this.evictOldestIfNeeded(this.pendingPermissions);
    const eventSource = withSessionId(source, sessionId);
    this.pendingPermissions.set(id, { title, source: eventSource });
    this.recomputeStatus();
    this.markAttention("onPermission", eventSource);
    if (this.shouldShowPopup("onPermission", "permission")) {
      const message = `OpenCode is waiting for permission: ${title}`;
      this.notifyExternal({ kind: "permission", title: "OpenCode", message, source: eventSource });
    }
  }

  private handlePermissionReplied(properties: Record<string, unknown> | undefined) {
    const permissionId = readIdentifier(properties, "permissionID") ?? readIdentifier(properties, "requestID");
    if (!permissionId) {
      return;
    }

    this.pendingPermissions.delete(permissionId);
    this.recomputeStatus();
  }

  private handleSessionError(source: OpenCodeNotificationSource) {
    this.evictOldestIfNeeded(this.errors);
    this.errors.set(toSourceKey(source), source);
    this.recomputeStatus();
    this.markAttention("onError", source);
    if (this.shouldShowPopup("onError", "error")) {
      const message = "OpenCode session reported an error.";
      this.notifyExternal({ kind: "error", title: "OpenCode", message, source });
    }
  }

  private handleMessagePartUpdated(properties: Record<string, unknown> | undefined, source: OpenCodeNotificationSource) {
    const sessionId = readIdentifier(properties, "sessionID");
    if (!sessionId) {
      return;
    }

    if (!isCompactionPart(readRecord(properties, "part"))) {
      this.clearCompactingSession(sessionId, source);
      return;
    }

    const eventSource = withSessionId(source, sessionId);
    const state = this.ensureSessionState(sessionId);
    state.busySeen = true;
    state.busy = true;
    state.compacting = true;
    state.source = eventSource;

    if (source.restoreId) {
      const restoreState = this.ensureRestoreState(source.restoreId);
      restoreState.busySeen = true;
      restoreState.source = eventSource;
      restoreState.activeSessionIds.add(sessionId);
      restoreState.compactingSessionIds.add(sessionId);
      if (restoreState.idleTimer) {
        clearTimeout(restoreState.idleTimer);
        restoreState.idleTimer = undefined;
      }
    }

    this.finishedSessions.delete(sessionId);
    if (source.restoreId) {
      this.finishedSessions.delete(source.restoreId);
    }
    this.recomputeStatus();
  }

  private clearCompactingSession(sessionId: string | undefined, source: OpenCodeNotificationSource) {
    sessionId = validateIdentifier(sessionId);
    if (!sessionId) {
      return;
    }

    const state = this.sessions.get(sessionId);
    if (state) {
      state.compacting = false;
    }

    if (source.restoreId) {
      const restoreState = this.restores.get(source.restoreId);
      if (restoreState) {
        restoreState.compactingSessionIds.delete(sessionId);
        if (restoreState.activeSessionIds.has(sessionId) && !state?.busy) {
          restoreState.activeSessionIds.delete(sessionId);
          if (restoreState.busySeen && restoreState.activeSessionIds.size === 0) {
            this.finishRestoreSession(source.restoreId, restoreState.source ?? withSessionId(source, sessionId));
            return;
          }
        }
      }
    }
  }

  private markAttention(kind: "onIdle" | "onPermission" | "onError", source: OpenCodeNotificationSource | undefined) {
    if (!this.settings.enabled || !this.settings[kind]) {
      return;
    }

    this.ui.markAttention?.(source);
  }

  private notifyExternal(notification: ExternalNotification) {
    try {
      this.externalNotifier?.notify(notification);
    } catch {
      // Desktop notification is best-effort.
    }
  }

  private shouldShowPopup(kind: "onIdle" | "onPermission" | "onError", bucket: string = kind) {
    if (!this.settings.enabled || !this.settings[kind]) {
      return false;
    }

    if (this.settings.backgroundOnly && this.ui.isFocused()) {
      return false;
    }

    const now = Date.now();
    const previous = this.lastPopupAt.get(bucket) ?? 0;
    if (now - previous < POPUP_COOLDOWN_MS) {
      return false;
    }

    this.lastPopupAt.set(bucket, now);
    return true;
  }

  private ensureSessionState(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    this.evictOldestIfNeeded(this.sessions);
    const state: SessionState = { busySeen: false, busy: false, compacting: false };
    this.sessions.set(sessionId, state);
    return state;
  }

  private ensureRestoreState(restoreId: string) {
    const existing = this.restores.get(restoreId);
    if (existing) {
      return existing;
    }

    this.evictOldestIfNeeded(this.restores);
    const state: RestoreState = { activeSessionIds: new Set(), compactingSessionIds: new Set(), busySeen: false };
    this.restores.set(restoreId, state);
    return state;
  }

  private handleRestoreSessionIdle(sessionId: string, source: OpenCodeNotificationSource) {
    const restoreId = source.restoreId;
    if (!restoreId) {
      return;
    }

    this.sessions.delete(sessionId);
    const restoreState = this.ensureRestoreState(restoreId);
    restoreState.activeSessionIds.delete(sessionId);
    restoreState.source = withSessionId(source, sessionId);

    if (restoreState.compactingSessionIds.has(sessionId)) {
      restoreState.activeSessionIds.add(sessionId);
      this.scheduleCompactionCompletion(restoreId, restoreState, source);
      this.recomputeStatus();
      return;
    }

    if (!restoreState.busySeen) {
      return;
    }

    if (restoreState.idleTimer) {
      clearTimeout(restoreState.idleTimer);
    }

    const idleSettleDelayMs = this.options.idleSettleDelayMs ?? DEFAULT_IDLE_SETTLE_DELAY_MS;
    if (idleSettleDelayMs <= 0) {
      if (restoreState.activeSessionIds.size === 0) {
        this.finishRestoreSession(restoreId, restoreState.source ?? source);
      } else {
        this.recomputeStatus();
      }
      return;
    }

    restoreState.idleTimer = setTimeout(() => {
      const latestState = this.restores.get(restoreId);
      if (!latestState || latestState.activeSessionIds.size > 0 || !latestState.busySeen) {
        return;
      }

      latestState.idleTimer = undefined;
      this.finishRestoreSession(restoreId, latestState.source ?? source);
    }, idleSettleDelayMs);
    restoreState.idleTimer.unref?.();
    this.recomputeStatus();
  }

  private scheduleCompactionCompletion(
    restoreId: string,
    restoreState: RestoreState,
    source: OpenCodeNotificationSource,
  ) {
    if (restoreState.idleTimer) {
      clearTimeout(restoreState.idleTimer);
    }

    const idleSettleDelayMs = this.options.idleSettleDelayMs ?? DEFAULT_IDLE_SETTLE_DELAY_MS;
    if (idleSettleDelayMs <= 0) {
      return;
    }

    restoreState.idleTimer = setTimeout(() => {
      const latestState = this.restores.get(restoreId);
      if (!latestState?.busySeen) {
        return;
      }

      latestState.idleTimer = undefined;
      const hasNonCompactingActiveSession = [...latestState.activeSessionIds].some(
        (sessionId) => !latestState.compactingSessionIds.has(sessionId),
      );
      if (hasNonCompactingActiveSession) {
        this.recomputeStatus();
        return;
      }

      for (const compactingSessionId of latestState.compactingSessionIds) {
        latestState.activeSessionIds.delete(compactingSessionId);
      }
      latestState.compactingSessionIds.clear();

      if (latestState.activeSessionIds.size === 0) {
        this.finishRestoreSession(restoreId, latestState.source ?? source);
        return;
      }

      this.recomputeStatus();
    }, idleSettleDelayMs);
    restoreState.idleTimer.unref?.();
  }

  private finishRestoreSession(restoreId: string, source: OpenCodeNotificationSource) {
    const restoreState = this.restores.get(restoreId);
    if (!restoreState?.busySeen) {
      return;
    }

    for (const activeSessionId of restoreState.activeSessionIds) {
      this.sessions.delete(activeSessionId);
    }
    this.restores.delete(restoreId);
    this.evictOldestIfNeeded(this.finishedSessions);
    this.finishedSessions.set(restoreId, source);
    this.recomputeStatus();
    this.markAttention("onIdle", source);
    if (this.shouldShowPopup("onIdle", "idle")) {
      const message = "OpenCode session finished.";
      this.notifyExternal({ kind: "idle", title: "OpenCode", message, source });
    }
  }

  private recomputeStatus() {
    if (!this.settings.enabled) {
      this.ui.setStatus({ kind: "clear", count: 0, label: "OpenCode notifications disabled." });
      return;
    }

    if (this.errors.size > 0) {
      this.ui.setStatus(
        { kind: "error", count: this.errors.size, label: "OpenCode session error." },
        firstMapValue(this.errors),
      );
      return;
    }

    if (this.pendingPermissions.size > 0) {
      this.ui.setStatus(
        { kind: "permission", count: this.pendingPermissions.size, label: "OpenCode needs permission." },
        firstMapValue(this.pendingPermissions)?.source,
      );
      return;
    }

    const busyRestores = countBusyRestores(this.restores);
    if (busyRestores.count > 0) {
      this.ui.setStatus({ kind: "busy", count: busyRestores.count, label: "OpenCode is running." }, busyRestores.source);
      return;
    }

    const busySessions = countBusySessions(this.sessions);
    if (busySessions.count > 0) {
      this.ui.setStatus({ kind: "busy", count: busySessions.count, label: "OpenCode is running." }, busySessions.source);
      return;
    }

    if (this.finishedSessions.size > 0) {
      this.ui.setStatus(
        { kind: "idle", count: this.finishedSessions.size, label: "OpenCode session finished." },
        firstMapValue(this.finishedSessions),
      );
      return;
    }

    this.ui.setStatus({ kind: "clear", count: 0, label: "OpenCode is idle." });
  }

  private evictOldestIfNeeded<T>(map: Map<string, T>) {
    while (map.size >= MAX_TRACKED_ITEMS) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      map.delete(oldest);
    }
  }

  private hasErrorForSource(source: OpenCodeNotificationSource) {
    for (const [key, errorSource] of this.errors) {
      if (matchesSource(errorSource, source, source.sessionId) || key === toSourceKey(source)) {
        return true;
      }
    }

    return false;
  }

  private hasPermissionForSource(source: OpenCodeNotificationSource) {
    for (const permission of this.pendingPermissions.values()) {
      if (matchesSource(permission.source, source, source.sessionId)) {
        return true;
      }
    }

    return false;
  }

  private isSourceBusy(source: OpenCodeNotificationSource) {
    if (source.restoreId) {
      const restoreState = this.restores.get(source.restoreId);
      if (restoreState?.activeSessionIds.size) {
        return true;
      }
    }

    for (const [sessionId, state] of this.sessions) {
      if (!state.busy || !matchesSource(state.source, source, sessionId)) {
        continue;
      }

      return true;
    }

    return false;
  }

  private hasFinishedSource(source: OpenCodeNotificationSource) {
    for (const [key, finishedSource] of this.finishedSessions) {
      if (matchesSource(finishedSource, source, key.startsWith("ses") ? key : source.sessionId) || key === toSourceKey(source)) {
        return true;
      }
    }

    return false;
  }

  private clearErrorsForSource(source: OpenCodeNotificationSource) {
    for (const [key, errorSource] of this.errors) {
      if (matchesSource(errorSource, source, source.sessionId)) {
        this.errors.delete(key);
      }
    }
  }
}

const DEFAULT_NOTIFICATION_SETTINGS: OpenCodeNotificationSettings = {
  enabled: true,
  backgroundOnly: true,
  onIdle: true,
  onPermission: true,
  onError: true,
};

function readRecord(value: Record<string, unknown> | undefined, key: string) {
  const next = value?.[key];
  return next && typeof next === "object" && !Array.isArray(next) ? next as Record<string, unknown> : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string) {
  const next = value?.[key];
  return typeof next === "string" ? next : undefined;
}

function readIdentifier(value: Record<string, unknown> | undefined, key: string) {
  return validateIdentifier(readString(value, key));
}


function readPermissionTitle(properties: Record<string, unknown> | undefined) {
  const permission = readString(properties, "permission");
  const patterns = readStringArray(properties, "patterns");
  if (permission && patterns.length > 0) {
    return `${permission} (${patterns.length} ${patterns.length === 1 ? "pattern" : "patterns"})`;
  }

  if (permission) {
    return permission;
  }

  return undefined;
}

function readStringArray(value: Record<string, unknown> | undefined, key: string) {
  const next = value?.[key];
  if (!Array.isArray(next) || !next.every((item): item is string => typeof item === "string")) {
    return [];
  }

  return next;
}

function isCompactionPart(part: Record<string, unknown> | undefined) {
  if (!part) {
    return false;
  }

  if (readString(part, "type") === "compaction" || readString(part, "deltaType") === "compaction_delta") {
    return true;
  }

  const delta = readRecord(part, "delta");
  if (readString(delta, "type") === "compaction_delta") {
    return true;
  }

  const providerOptions = readRecord(part, "providerOptions");
  const anthropic = readRecord(providerOptions, "anthropic");
  return readString(anthropic, "type") === "compaction";
}

function validateIdentifier(value: string | undefined) {
  if (!value || value.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(value)) {
    return undefined;
  }

  return value;
}

function withSessionId(source: OpenCodeNotificationSource | undefined, sessionId: string | undefined) {
  return {
    ...(source ?? {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function matchesSource(
  candidate: OpenCodeNotificationSource | undefined,
  source: OpenCodeNotificationSource,
  candidateSessionId?: string,
) {
  if (source.restoreId && candidate?.restoreId === source.restoreId) {
    return true;
  }

  return !!source.sessionId && (candidate?.sessionId === source.sessionId || candidateSessionId === source.sessionId);
}

function toSourceKey(source: OpenCodeNotificationSource) {
  if (source.restoreId) {
    return `restore:${source.restoreId}`;
  }

  if (source.sessionId) {
    return `session:${source.sessionId}`;
  }

  return GLOBAL_ERROR_KEY;
}

function countBusyRestores(restores: Map<string, RestoreState>) {
  let count = 0;
  let source: OpenCodeNotificationSource | undefined;
  for (const state of restores.values()) {
    if (state.activeSessionIds.size === 0) {
      continue;
    }

    count += 1;
    source ??= state.source;
  }

  return { count, source };
}

function countBusySessions(sessions: Map<string, SessionState>) {
  let count = 0;
  let source: OpenCodeNotificationSource | undefined;
  for (const state of sessions.values()) {
    if (!state.busy) {
      continue;
    }

    count += 1;
    source ??= state.source;
  }

  return { count, source };
}

function firstMapValue<T>(map: Map<string, T>) {
  return map.values().next().value as T | undefined;
}

function sanitizeDisplayText(value: string | undefined, fallback: string) {
  const cleaned = (value ?? fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeValue = cleaned || fallback;
  return safeValue.length <= MAX_DISPLAY_TEXT_LENGTH
    ? safeValue
    : `${safeValue.slice(0, MAX_DISPLAY_TEXT_LENGTH - 3)}...`;
}
