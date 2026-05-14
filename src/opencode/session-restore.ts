import { randomUUID } from "node:crypto";
import type { StartSessionOptions } from "./session-manager";
import type { OpenCodeSessionSummary } from "./session-repository";
import { clearTerminalAttentionLabel, OPENCODE_TERMINAL_ATTENTION_PREFIX, OPENCODE_TERMINAL_STATE_PREFIXES } from "./terminal-attention";

export type SessionRestoreLaunchOptions = StartSessionOptions & {
  restoreId?: string;
  startedAt?: number;
};

export type PersistedSessionRestoreInfo = StartSessionOptions & {
  opened: boolean;
  restoreId?: string;
  terminalProcessId?: number;
  startedAt?: number;
};

export type SessionRestoreInfo = StartSessionOptions & {
  opened: boolean;
  restoreId: string;
  terminalProcessId?: number;
  startedAt?: number;
};

export type OpenCodeTerminalSnapshot = {
  name: string;
  restoreId?: string;
  processId?: number;
  creationName?: string;
  cwd?: string;
};

export type SessionTitleResolution = {
  terminalName: string;
  sessionLabel?: string;
  sessionId?: string;
  updated?: number | string;
};

export type OpenCodeTerminalMatcher = {
  restoreIds: Set<string>;
  terminalNames: Set<string>;
  terminalProcessIds: Set<number>;
};

export type PersistedRestoreState = {
  restoreStateEnabled: boolean;
  latestRestoreInfo: PersistedSessionRestoreInfo | undefined;
  restoreInfos: PersistedSessionRestoreInfo[];
  trackedRestoreIds: string[];
};

export function createSessionRestoreId() {
  return randomUUID();
}

export function toSessionRestoreInfo(
  options: SessionRestoreLaunchOptions,
  createId: () => string = createSessionRestoreId,
): SessionRestoreInfo {
  const { restoreId, ...launchOptions } = options;

  return {
    ...launchOptions,
    opened: true,
    restoreId: restoreId ?? createId(),
  };
}

export function toSessionLaunchOptions(info: PersistedSessionRestoreInfo): SessionRestoreLaunchOptions {
  const { opened: _opened, restoreId, terminalProcessId: _terminalProcessId, ...launchOptions } = info;
  return {
    ...launchOptions,
    ...(restoreId ? { restoreId } : {}),
  };
}

export function readSessionRestoreInfos(
  restoreInfos: PersistedSessionRestoreInfo[],
  legacyRestoreInfo: PersistedSessionRestoreInfo | undefined,
  createId: () => string = createSessionRestoreId,
): SessionRestoreInfo[] {
  const rawRestoreInfos = restoreInfos.length > 0
    ? restoreInfos
    : legacyRestoreInfo
      ? [legacyRestoreInfo]
      : [{ opened: true, terminalName: "opencode" }];

  return rawRestoreInfos.map((info) => ensureSessionRestoreInfoId(info, createId));
}

export function shouldClearRestoreStateAfterMissingTerminal(
  hasRestoredTerminal: boolean,
  restoreInfos: readonly PersistedSessionRestoreInfo[],
  legacyRestoreInfo: PersistedSessionRestoreInfo | undefined,
) {
  return !hasRestoredTerminal && restoreInfos.length === 0 && legacyRestoreInfo === undefined;
}

export function upsertSessionRestoreInfo(
  existing: PersistedSessionRestoreInfo[],
  next: SessionRestoreInfo,
): SessionRestoreInfo[] {
  return [
    ...existing.filter((item) => item.restoreId !== next.restoreId).map((item) => ensureSessionRestoreInfoId(item)),
    next,
  ];
}

export function removeSessionRestoreInfo(
  existing: PersistedSessionRestoreInfo[],
  restoreId: string,
): SessionRestoreInfo[] {
  return existing
    .filter((item) => item.restoreId !== restoreId)
    .map((item) => ensureSessionRestoreInfoId(item));
}

export function updateSessionRestoreInfo(
  existing: PersistedSessionRestoreInfo[],
  restoreId: string,
  update: (info: SessionRestoreInfo) => SessionRestoreInfo,
): SessionRestoreInfo[] {
  return existing.map((item) => {
    const next = ensureSessionRestoreInfoId(item);
    return next.restoreId === restoreId ? update(next) : next;
  });
}

export function updateRestoreInfoFromSession(
  info: SessionRestoreInfo,
  session: OpenCodeSessionSummary,
): SessionRestoreInfo {
  const title = readSessionTitle(session);
  return {
    ...info,
    sessionId: session.id,
    ...(title ? { sessionLabel: title, terminalName: title } : {}),
    ...(session.updated !== undefined ? { updated: session.updated } : {}),
  };
}

export function dedupeSessionsByTitle(sessions: OpenCodeSessionSummary[]): OpenCodeSessionSummary[] {
  const seenTitles = new Set<string>();
  const deduped: OpenCodeSessionSummary[] = [];

  for (const session of sessions) {
    if (session.parentId) {
      continue;
    }

    const titleKey = readNormalizedSessionTitle(session);
    if (!titleKey) {
      deduped.push(session);
      continue;
    }

    if (seenTitles.has(titleKey)) {
      continue;
    }

    seenTitles.add(titleKey);
    deduped.push(session);
  }

  return deduped;
}

export function resolveRestoreSessionOptions(
  info: PersistedSessionRestoreInfo,
  sessions: {
    exactSession?: OpenCodeSessionSummary;
    latestSession?: OpenCodeSessionSummary;
  },
): SessionRestoreLaunchOptions {
  const launchOptions = toSessionLaunchOptions(info);
  const exactSession = readRestorableSession(sessions.exactSession);
  if (info.sessionId && exactSession?.id === info.sessionId) {
    return {
      ...launchOptions,
      ...(exactSession.updated !== undefined ? { updated: exactSession.updated } : {}),
    };
  }

  const latestSession = readRestorableSession(sessions.latestSession);
  if (!latestSession?.id) {
    if (info.sessionId && sessions.exactSession?.id === info.sessionId && sessions.exactSession.parentId) {
      const { sessionId: _sessionId, ...launchOptionsWithoutSessionId } = launchOptions;
      return launchOptionsWithoutSessionId;
    }

    return launchOptions;
  }

  return {
    ...launchOptions,
    sessionId: latestSession.id,
    sessionLabel: latestSession.title ?? launchOptions.sessionLabel,
    ...(latestSession.updated !== undefined ? { updated: latestSession.updated } : {}),
  };
}

export function resolveSessionTitle(
  info: Pick<PersistedSessionRestoreInfo, "sessionId" | "sessionLabel" | "terminalName">,
  sessions: {
    exactSession?: OpenCodeSessionSummary;
    latestSession?: OpenCodeSessionSummary;
  },
): SessionTitleResolution {
  const exactSession = readRestorableSession(sessions.exactSession);
  const exactTitle = readSessionTitle(exactSession);
  if (info.sessionId && exactSession?.id === info.sessionId && exactTitle) {
    return {
      terminalName: exactTitle,
      sessionLabel: exactTitle,
      sessionId: exactSession.id,
      ...(exactSession.updated !== undefined ? { updated: exactSession.updated } : {}),
    };
  }

  const latestSession = readRestorableSession(sessions.latestSession);
  const latestTitle = readSessionTitle(latestSession);
  if (latestTitle && latestSession?.id) {
    return {
      terminalName: latestTitle,
      sessionLabel: latestTitle,
      sessionId: latestSession.id,
      ...(latestSession.updated !== undefined ? { updated: latestSession.updated } : {}),
    };
  }

  const fallbackTitle = normalizeFallbackTitle(info.sessionLabel?.trim() || info.terminalName?.trim());
  const shouldPreserveFallbackSessionId = !!info.sessionId && (!sessions.exactSession || !sessions.exactSession.parentId);
  return {
    terminalName: fallbackTitle || "new session",
    ...(info.sessionLabel?.trim() ? { sessionLabel: info.sessionLabel.trim() } : {}),
    ...(shouldPreserveFallbackSessionId ? { sessionId: info.sessionId } : {}),
  };
}

export function resolveRestoreSessionFallbackByLatestSession(
  info: PersistedSessionRestoreInfo,
  latestSession: OpenCodeSessionSummary | undefined,
): SessionRestoreLaunchOptions {
  const restorableSession = readRestorableSession(latestSession);
  if (!restorableSession?.id) {
    return toSessionLaunchOptions(info);
  }

  return {
    ...toSessionLaunchOptions(info),
    sessionId: restorableSession.id,
    sessionLabel: restorableSession.title ?? info.sessionLabel,
    ...(restorableSession.updated !== undefined ? { updated: restorableSession.updated } : {}),
  };
}

export function shouldRetrySessionTitleResolution(
  info: Pick<PersistedSessionRestoreInfo, "sessionId" | "sessionLabel" | "terminalName">,
  resolvedTerminalName: string,
  exactSessionTitle?: string,
) {
  if (info.sessionLabel?.trim()) {
    return false;
  }

  if (info.sessionId && exactSessionTitle?.trim()) {
    return false;
  }

  return resolvedTerminalName === (info.terminalName?.trim() || "new session");
}

export function createOpenCodeTerminalMatcher(
  restoreInfos: PersistedSessionRestoreInfo[],
  legacyRestoreInfo: PersistedSessionRestoreInfo | undefined,
  trackedRestoreIds: string[],
  createId: () => string = createSessionRestoreId,
): OpenCodeTerminalMatcher {
  const entries = readSessionRestoreInfos(restoreInfos, legacyRestoreInfo, createId);

  return {
    restoreIds: new Set([
      ...trackedRestoreIds,
      ...entries.map((info) => info.restoreId),
    ]),
    terminalNames: new Set(entries.flatMap((info) => info.terminalName ? [info.terminalName] : [])),
    terminalProcessIds: new Set(entries.flatMap((info) => typeof info.terminalProcessId === "number" ? [info.terminalProcessId] : [])),
  };
}

export function matchesOpenCodeTerminal(
  terminal: OpenCodeTerminalSnapshot,
  matcher: OpenCodeTerminalMatcher,
) {
  return terminal.name === "opencode"
    || terminal.name.startsWith("opencode:")
    || (typeof terminal.restoreId === "string" && matcher.restoreIds.has(terminal.restoreId))
    || (typeof terminal.processId === "number" && matcher.terminalProcessIds.has(terminal.processId))
    || matcher.terminalNames.has(terminal.name)
    || (!!terminal.creationName && matcher.terminalNames.has(terminal.creationName))
    || matcher.restoreIds.has(terminal.name)
    || (!!terminal.creationName && matcher.restoreIds.has(terminal.creationName))
    || matchesManagedOpenCodeTerminalName(terminal.name, matcher);
}

export function resolveOpenCodeTerminalRestoreId(
  terminal: OpenCodeTerminalSnapshot,
  restoreInfos: PersistedSessionRestoreInfo[],
  legacyRestoreInfo: PersistedSessionRestoreInfo | undefined,
  createId: () => string = createSessionRestoreId,
) {
  if (terminal.restoreId) {
    return terminal.restoreId;
  }

  const entries = readSessionRestoreInfos(restoreInfos, legacyRestoreInfo, createId);
  if (typeof terminal.processId === "number") {
    const processMatch = entries.find((info) => info.terminalProcessId === terminal.processId);
    if (processMatch) {
      return processMatch.restoreId;
    }
  }

  const nameMatches = entries.filter((info) => matchesManagedRestoreEntry(terminal.name, info));
  if (nameMatches.length === 1) {
    return nameMatches[0]?.restoreId;
  }

  const creationName = terminal.creationName;
  if (creationName) {
    const creationNameMatches = entries.filter((info) => matchesManagedRestoreEntry(creationName, info));
    if (creationNameMatches.length === 1) {
      return creationNameMatches[0]?.restoreId;
    }

    if (terminal.cwd) {
      const cwdMatch = creationNameMatches.find((info) => info.cwd === terminal.cwd);
      if (cwdMatch) {
        return cwdMatch.restoreId;
      }
    }
  }

  return undefined;
}

export function updatePersistedRestoreStateSnapshot(
  currentState: PersistedRestoreState,
  update: (state: PersistedRestoreState) => PersistedRestoreState,
) {
  const nextState = update(currentState);
  return {
    shouldWriteRestoreStateEnabled: currentState.restoreStateEnabled !== nextState.restoreStateEnabled,
    shouldWriteLatestRestoreInfo: currentState.latestRestoreInfo !== nextState.latestRestoreInfo,
    shouldWriteRestoreInfos: currentState.restoreInfos !== nextState.restoreInfos,
    shouldWriteTrackedRestoreIds: currentState.trackedRestoreIds !== nextState.trackedRestoreIds,
    nextState,
  };
}

export async function waitForOpenCodeTerminalRestore(
  check: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    wait?: (durationMs: number) => Promise<void>;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const wait = options.wait ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }

    await wait(pollIntervalMs);
  }

  return check();
}

export function readRestorableSession(session: OpenCodeSessionSummary | undefined) {
  return session?.parentId ? undefined : session;
}

export function readLatestSessionForDirectory(sessions: OpenCodeSessionSummary[], cwd: string, startedAt: number) {
  return sessions.find((session) => {
    if (session.parentId || session.directory !== cwd || typeof session.title !== "string" || session.title.trim().length === 0) {
      return false;
    }

    const createdAt = typeof session.created === "number"
      ? session.created
      : typeof session.created === "string"
        ? Number.parseInt(session.created, 10)
        : Number.NaN;
    return Number.isFinite(createdAt) && Math.abs(createdAt - startedAt) <= 5000;
  });
}

function ensureSessionRestoreInfoId(
  info: PersistedSessionRestoreInfo,
  createId: () => string = createSessionRestoreId,
): SessionRestoreInfo {
  return {
    ...info,
    restoreId: info.restoreId ?? createId(),
  };
}

function readNormalizedSessionTitle(session: OpenCodeSessionSummary) {
  return typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : undefined;
}

function readSessionTitle(session: OpenCodeSessionSummary | undefined) {
  return session?.title?.trim() || undefined;
}

function normalizeFallbackTitle(title: string | undefined) {
  const normalized = title?.trim();
  if (!normalized) {
    return undefined;
  }

  return clearTerminalAttentionLabel(normalized).trim() || undefined;
}

function matchesManagedOpenCodeTerminalName(name: string, matcher: OpenCodeTerminalMatcher) {
  for (const terminalName of matcher.terminalNames) {
    if (readManagedOpenCodeTerminalNames(terminalName).has(name)) {
      return true;
    }
  }

  for (const restoreId of matcher.restoreIds) {
    if (readManagedOpenCodeTerminalNames(restoreId).has(name)) {
      return true;
    }
  }

  return false;
}

function matchesManagedRestoreEntry(name: string, info: SessionRestoreInfo) {
  return !!info.terminalName && readManagedOpenCodeTerminalNames(info.terminalName).has(name)
    || readManagedOpenCodeTerminalNames(info.restoreId).has(name);
}

function readManagedOpenCodeTerminalNames(name: string) {
  return new Set([
    name,
    `${OPENCODE_TERMINAL_ATTENTION_PREFIX}${name}`,
    ...Object.values(OPENCODE_TERMINAL_STATE_PREFIXES).map((prefix) => `${prefix}${name}`),
  ]);
}
