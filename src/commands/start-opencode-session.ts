import type { Disposable } from "vscode";
import type { StartSessionOptions } from "../opencode/session-manager";
import type { OpenCodeSessionSummary } from "../opencode/session-repository";
import { formatSessionUpdatedLabel, readSessionDirectoryLabel } from "../opencode/session-display";
import { dedupeSessionsByTitle } from "../opencode/session-restore";

type MessageDeps = {
  prepareLayout?(): Promise<void>;
  showErrorMessage(message: string): void;
  showInformationMessage?(message: string): void | Promise<void>;
  createQuickPick?(): SessionQuickPickLike;
  listSessions?(cwd?: string): OpenCodeSessionSummary[] | Promise<OpenCodeSessionSummary[]>;
  listAllSessions?(cwd?: string): OpenCodeSessionSummary[] | Promise<OpenCodeSessionSummary[]>;
  listArchivedSessions?(cwd?: string): OpenCodeSessionSummary[] | Promise<OpenCodeSessionSummary[]>;
  deleteSession?(sessionId: string, cwd?: string): void | Promise<void>;
  deleteSessions?(sessionIds: string[], cwd?: string): void | Promise<void>;
  archiveSession?(sessionId: string): void | Promise<void>;
  archiveSessions?(sessionIds: string[]): void | Promise<void>;
  unarchiveSession?(sessionId: string): void | Promise<void>;
  unarchiveSessions?(sessionIds: string[]): void | Promise<void>;
  pathExists?(path: string): boolean | PromiseLike<boolean>;
  getWorkspaceFolders?(): WorkspaceFolderOption[];
  showWorkspaceFolderPick?(folders: WorkspaceFolderOption[]): Promise<WorkspaceFolderOption | undefined>;
  showWarningMessage?(message: string, options?: { modal?: boolean }, ...items: string[]): Promise<string | undefined>;
  forkButton?: QuickPickButtonLike;
  deleteButton?: QuickPickButtonLike;
  archiveButton?: QuickPickButtonLike;
  unarchiveButton?: QuickPickButtonLike;
};

type WorkspaceFolderOption = {
  name: string;
  uri: string;
};

type SessionStarter = {
  startSession(options?: StartSessionOptions): void | Promise<void>;
  waitUntilReady?: () => Promise<void>;
};

type SessionQuickPickItem = {
  label: string;
  kind?: number;
  description?: string;
  detail?: string;
  buttons?: readonly QuickPickButtonLike[];
  itemKind?: "new" | "allSessions" | "archivedSessions" | "session" | "separator";
  session?: OpenCodeSessionSummary;
  directoryExists?: boolean;
};

type QuickPickButtonLike = { tooltip?: string; iconPath?: unknown };

type SessionQuickPickLike = {
  items: readonly SessionQuickPickItem[];
  selectedItems: readonly SessionQuickPickItem[];
  busy: boolean;
  canSelectMany: boolean;
  placeholder: string | undefined;
  title: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept(handler: () => void): Disposable;
  onDidTriggerItemButton(handler: (event: { item: SessionQuickPickItem; button: QuickPickButtonLike }) => void): Disposable;
  onDidHide(handler: () => void): Disposable;
};

type SessionItemButtons = {
  forkButton: QuickPickButtonLike;
  deleteButton: QuickPickButtonLike;
  archiveButton: QuickPickButtonLike;
  unarchiveButton: QuickPickButtonLike;
};

const FALLBACK_FORK_BUTTON = { tooltip: "fork" };
const FALLBACK_DELETE_BUTTON = { tooltip: "delete" };
const FALLBACK_ARCHIVE_BUTTON = { tooltip: "archive" };
const FALLBACK_UNARCHIVE_BUTTON = { tooltip: "unarchive" };

export function createStartOpenCodeSessionCommand(
  sessionManager: SessionStarter,
  messages: MessageDeps,
) {
  return async () => {
    try {
      if (sessionManager.waitUntilReady) {
        await sessionManager.waitUntilReady();
      }
      await messages.prepareLayout?.();

      if (messages.createQuickPick && messages.listSessions && messages.getWorkspaceFolders) {
        await showSessionQuickPick(sessionManager, messages);
        return;
      }

      await sessionManager.startSession();
    } catch (error) {
      messages.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
}

async function showSessionQuickPick(sessionManager: SessionStarter, messages: MessageDeps) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick || !messages.listSessions || !messages.getWorkspaceFolders) {
    await sessionManager.startSession();
    return;
  }

  const disposables: Disposable[] = [];
  const workspaceFolders = messages.getWorkspaceFolders();
  const primaryCwd = workspaceFolders[0]?.uri;
  const buttons = createSessionItemButtons(messages);

  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = dedupeSessionsByTitle(await messages.listSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildSessionItems(sessions, workspaceFolders, messages, buttons);
    } finally {
      quickPick.busy = false;
    }
  };

  disposables.push(quickPick.onDidAccept(() => {
    void (async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected || selected.itemKind === "separator") {
        return;
      }

      if (selected.itemKind === "new") {
        const folder = await selectWorkspaceFolder(workspaceFolders, messages);
        if (!folder) {
          return;
        }
        quickPick.hide();
        await sessionManager.startSession({ cwd: folder.uri, terminalName: "new session" });
        return;
      }

      if (selected.itemKind === "allSessions") {
        quickPick.hide();
        await showAllSessionsQuickPick(sessionManager, messages, workspaceFolders, primaryCwd, buttons);
        return;
      }

      if (selected.itemKind === "archivedSessions") {
        quickPick.hide();
        await showArchivedSessionsQuickPick(sessionManager, messages, workspaceFolders, primaryCwd, buttons);
        return;
      }

      await openSessionFromItem(sessionManager, messages, quickPick, selected);
    })().catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));

  disposables.push(quickPick.onDidTriggerItemButton((event) => {
    void handleSessionItemButton({
      event,
      sessionManager,
      messages,
      workspaceFolders,
      primaryCwd,
      quickPick,
      buttons,
    }).catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));

  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  quickPick.title = "Start OpenCode Session";
  quickPick.placeholder = "Create, resume, fork, archive, or delete OpenCode sessions";
  await refresh();
  quickPick.show();
}

function createSessionItemButtons(messages: MessageDeps): SessionItemButtons {
  return {
    forkButton: messages.forkButton ?? FALLBACK_FORK_BUTTON,
    deleteButton: messages.deleteButton ?? FALLBACK_DELETE_BUTTON,
    archiveButton: messages.archiveButton ?? FALLBACK_ARCHIVE_BUTTON,
    unarchiveButton: messages.unarchiveButton ?? FALLBACK_UNARCHIVE_BUTTON,
  };
}

async function buildSessionItems(
  sessions: OpenCodeSessionSummary[],
  workspaceFolders: WorkspaceFolderOption[],
  messages: MessageDeps,
  buttons: SessionItemButtons,
): Promise<SessionQuickPickItem[]> {
  return [
    { label: "$(plus) New Session", itemKind: "new" },
    { label: "$(list-unordered) All Sessions...", itemKind: "allSessions" },
    { label: "$(archive) Archived Sessions...", itemKind: "archivedSessions" },
    ...await buildSessionBrowserItems(sessions, workspaceFolders, messages, buttons),
  ];
}

async function buildSessionBrowserItems(
  sessions: OpenCodeSessionSummary[],
  workspaceFolders: WorkspaceFolderOption[],
  messages: MessageDeps,
  buttons: SessionItemButtons,
  options: { separateArchivedSessions?: boolean } = {},
): Promise<SessionQuickPickItem[]> {
  const sessionViews = await withDirectoryExistence(sessions, messages);
  const currentRoots = new Set(workspaceFolders.map((folder) => normalizePathForComparison(folder.uri)));
  const separateArchivedSessions = options.separateArchivedSessions === true;
  const current = sessionViews.filter((session) => session.directoryExists && session.directory && currentRoots.has(normalizePathForComparison(session.directory)) && (!separateArchivedSessions || !isArchivedSession(session)));
  const other = sessionViews.filter((session) => session.directoryExists && (!session.directory || !currentRoots.has(normalizePathForComparison(session.directory))) && (!separateArchivedSessions || !isArchivedSession(session)));
  const archived = separateArchivedSessions
    ? sessionViews.filter((session) => isArchivedSession(session))
    : [];
  const invalid = sessionViews.filter((session) => !session.directoryExists && (!separateArchivedSessions || !isArchivedSession(session)));

  return [
    ...createSessionGroup("Current Workspace", current, buttons),
    ...createSessionGroup("Outside of Workspace", other, buttons),
    ...createSessionGroup("Missing Directories", invalid, buttons, { invalid: true }),
    ...createSessionGroup("Archived Sessions", archived, buttons),
  ];
}

function createSessionGroup(
  label: string,
  sessions: SessionView[],
  buttons: SessionItemButtons,
  options: { invalid?: boolean; includeButtons?: boolean } = {},
) {
  return sessions.length > 0
    ? [{ label, kind: -1 as const, itemKind: "separator" as const }, ...sessions.map((session) => sessionToItem(session, buttons, options))]
    : [];
}

function sessionToItem(
  session: SessionView,
  buttons: SessionItemButtons,
  options: { invalid?: boolean; includeButtons?: boolean } = {},
): SessionQuickPickItem {
  const invalid = options.invalid === true;
  const includeButtons = options.includeButtons !== false;

  return {
    label: `${invalid ? "$(warning) " : ""}${getSessionTitle(session)}`,
    description: formatSessionQuickPickDescription(session),
    detail: undefined,
    itemKind: "session",
    session,
    directoryExists: session.directoryExists,
    ...(includeButtons ? { buttons: buildSessionRowButtons(session, buttons) } : {}),
  };
}

function formatSessionQuickPickDescription(session: OpenCodeSessionSummary) {
  return [
    session.id,
    readSessionDirectoryLabel(session.directory),
    formatSessionUpdatedLabel(session.updated),
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join("  ");
}

function buildSessionRowButtons(session: OpenCodeSessionSummary, buttons: SessionItemButtons) {
  return [buttons.forkButton, buttons.deleteButton, isArchivedSession(session) ? buttons.unarchiveButton : buttons.archiveButton];
}

async function showDeleteSessionsQuickPick(
  messages: MessageDeps,
  workspaceFolders: WorkspaceFolderOption[],
  primaryCwd: string | undefined,
  preselectedSessionIds: string[] = [],
) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick) {
    return;
  }

  const disposables: Disposable[] = [];
  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = await (messages.listAllSessions?.(primaryCwd) ?? messages.listSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildManageSessionItems(sessions, workspaceFolders, messages, false, preselectedSessionIds);
      applyPreselectedSessions(quickPick, preselectedSessionIds);
    } finally {
      quickPick.busy = false;
    }
  };

  quickPick.canSelectMany = true;
  quickPick.title = "Delete OpenCode Sessions";
  quickPick.placeholder = "Select one or more sessions to delete";
  disposables.push(quickPick.onDidAccept(() => {
    void (async () => {
      const sessions = getSelectedSessions(quickPick);
      if (sessions.length === 0) {
        return;
      }

      const sessionIds = sessions.map((session) => session.id);
      if (messages.deleteSessions) {
        await messages.deleteSessions(sessionIds, undefined);
      } else {
        for (const session of sessions) {
          await messages.deleteSession?.(session.id, undefined);
        }
      }
      quickPick.hide();
      await messages.showInformationMessage?.(formatDeletedManageAction(sessions.length));
    })().catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  await refresh();
  quickPick.show();
}

async function showAllSessionsQuickPick(
  sessionManager: SessionStarter,
  messages: MessageDeps,
  workspaceFolders: WorkspaceFolderOption[],
  primaryCwd: string | undefined,
  buttons: SessionItemButtons,
) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick) {
    return;
  }

  const disposables: Disposable[] = [];
  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = await (messages.listAllSessions?.(primaryCwd) ?? messages.listSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildSessionBrowserItems(sessions, workspaceFolders, messages, buttons, { separateArchivedSessions: true });
    } finally {
      quickPick.busy = false;
    }
  };

  quickPick.title = "All OpenCode Sessions";
  quickPick.placeholder = "Open or manage any OpenCode session, including archived and child sessions";
  disposables.push(quickPick.onDidAccept(() => {
    void openSessionFromItem(sessionManager, messages, quickPick, quickPick.selectedItems[0])
      .catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidTriggerItemButton((event) => {
    void handleSessionItemButton({
      event,
      sessionManager,
      messages,
      workspaceFolders,
      primaryCwd,
      quickPick,
      buttons,
    }).catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  await refresh();
  quickPick.show();
}

async function showArchivedSessionsQuickPick(
  sessionManager: SessionStarter,
  messages: MessageDeps,
  workspaceFolders: WorkspaceFolderOption[],
  primaryCwd: string | undefined,
  buttons: SessionItemButtons,
) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick) {
    return;
  }

  const disposables: Disposable[] = [];
  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = await (messages.listArchivedSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildSessionBrowserItems(sessions, workspaceFolders, messages, buttons);
    } finally {
      quickPick.busy = false;
    }
  };

  quickPick.title = "Archived OpenCode Sessions";
  quickPick.placeholder = "Open or manage archived OpenCode sessions";
  disposables.push(quickPick.onDidAccept(() => {
    void openSessionFromItem(sessionManager, messages, quickPick, quickPick.selectedItems[0])
      .catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidTriggerItemButton((event) => {
    void handleSessionItemButton({
      event,
      sessionManager,
      messages,
      workspaceFolders,
      primaryCwd,
      quickPick,
      buttons,
    }).catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  await refresh();
  quickPick.show();
}

async function showArchiveSessionsQuickPick(
  messages: MessageDeps,
  workspaceFolders: WorkspaceFolderOption[],
  primaryCwd: string | undefined,
  preselectedSessionIds: string[] = [],
) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick) {
    return;
  }

  const disposables: Disposable[] = [];
  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = await (messages.listAllSessions?.(primaryCwd) ?? messages.listSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildManageSessionItems(sessions.filter((session) => !isArchivedSession(session)), workspaceFolders, messages, false, preselectedSessionIds);
      applyPreselectedSessions(quickPick, preselectedSessionIds);
    } finally {
      quickPick.busy = false;
    }
  };

  quickPick.canSelectMany = true;
  quickPick.title = "Archive OpenCode Sessions";
  quickPick.placeholder = "Select one or more sessions to archive";
  disposables.push(quickPick.onDidAccept(() => {
    void (async () => {
      const sessions = getSelectedSessions(quickPick);
      if (sessions.length === 0) {
        return;
      }

      const successCount = await runManageSessionAction({
          action: "archive",
          sessions,
          quickPick,
          refresh,
          runBatch: messages.archiveSessions ? (sessionIds) => messages.archiveSessions?.(sessionIds) : undefined,
          run: (session) => messages.archiveSession?.(session.id),
        });
        await messages.showInformationMessage?.(formatCompletedManageAction("archive", successCount));
    })().catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  await refresh();
  quickPick.show();
}

async function showUnarchiveSessionsQuickPick(
  messages: MessageDeps,
  workspaceFolders: WorkspaceFolderOption[],
  primaryCwd: string | undefined,
  preselectedSessionIds: string[] = [],
) {
  const quickPick = messages.createQuickPick?.();
  if (!quickPick) {
    return;
  }

  const disposables: Disposable[] = [];
  const refresh = async () => {
    quickPick.busy = true;
    try {
      const sessions = await (messages.listArchivedSessions?.(primaryCwd) ?? []);
      quickPick.items = await buildManageSessionItems(sessions, workspaceFolders, messages, false, preselectedSessionIds);
      applyPreselectedSessions(quickPick, preselectedSessionIds);
    } finally {
      quickPick.busy = false;
    }
  };

  quickPick.canSelectMany = true;
  quickPick.title = "Unarchive OpenCode Sessions";
  quickPick.placeholder = "Select one or more sessions to unarchive";
  disposables.push(quickPick.onDidAccept(() => {
    void (async () => {
      const sessions = getSelectedSessions(quickPick);
      if (sessions.length === 0) {
        return;
      }

      const successCount = await runManageSessionAction({
          action: "unarchive",
          sessions,
          quickPick,
          refresh,
          runBatch: messages.unarchiveSessions ? (sessionIds) => messages.unarchiveSessions?.(sessionIds) : undefined,
          run: (session) => messages.unarchiveSession?.(session.id),
        });
        await messages.showInformationMessage?.(formatCompletedManageAction("unarchive", successCount));
    })().catch((error) => messages.showErrorMessage(error instanceof Error ? error.message : String(error)));
  }));
  disposables.push(quickPick.onDidHide(() => disposeAll(disposables, quickPick)));

  await refresh();
  quickPick.show();
}

async function buildManageSessionItems(
  sessions: OpenCodeSessionSummary[],
  workspaceFolders: WorkspaceFolderOption[],
  messages: MessageDeps,
  includeButtons = true,
  preselectedSessionIds: string[] = [],
) {
  const sessionViews = await withDirectoryExistence(sessions, messages);
  const currentRoots = new Set(workspaceFolders.map((folder) => normalizePathForComparison(folder.uri)));
  const current = sessionViews.filter((session) => session.directoryExists && session.directory && currentRoots.has(normalizePathForComparison(session.directory)));
  const other = sessionViews.filter((session) => session.directoryExists && (!session.directory || !currentRoots.has(normalizePathForComparison(session.directory))));
  const invalid = sessionViews.filter((session) => !session.directoryExists);
  const buttons = createSessionItemButtons(messages);

  return movePreselectedItemsToTop([
    ...createSessionGroup("Current Workspace", current, buttons, { includeButtons }),
    ...createSessionGroup("Outside of Workspace", other, buttons, { includeButtons }),
    ...createSessionGroup("Missing Directories", invalid, buttons, { invalid: true, includeButtons }),
  ], preselectedSessionIds);
}

function applyPreselectedSessions(quickPick: SessionQuickPickLike, preselectedSessionIds: string[]) {
  if (preselectedSessionIds.length === 0) {
    return;
  }

  const itemBySessionId = new Map(
    quickPick.items.flatMap((item) => item.session ? [[item.session.id, item] as const] : []),
  );

  quickPick.selectedItems = uniqueSessionIds(preselectedSessionIds)
    .flatMap((sessionId) => {
      const item = itemBySessionId.get(sessionId);
      return item ? [item] : [];
    });
}

function movePreselectedItemsToTop(items: SessionQuickPickItem[], preselectedSessionIds: string[]) {
  const orderedSessionIds = uniqueSessionIds(preselectedSessionIds);
  if (orderedSessionIds.length === 0) {
    return items;
  }

  const itemBySessionId = new Map(
    items.flatMap((item) => item.session ? [[item.session.id, item] as const] : []),
  );
  const preselectedItems = orderedSessionIds.flatMap((sessionId) => {
    const item = itemBySessionId.get(sessionId);
    return item ? [item] : [];
  });
  if (preselectedItems.length === 0) {
    return items;
  }

  const preselectedIds = new Set(preselectedItems.flatMap((item) => item.session ? [item.session.id] : []));
  return [
    ...preselectedItems,
    ...items.filter((item) => !item.session || !preselectedIds.has(item.session.id)),
  ];
}

function uniqueSessionIds(sessionIds: string[]) {
  const seen = new Set<string>();
  return sessionIds.filter((sessionId) => {
    if (seen.has(sessionId)) {
      return false;
    }
    seen.add(sessionId);
    return true;
  });
}

async function openSessionFromItem(
  sessionManager: SessionStarter,
  messages: MessageDeps,
  quickPick: SessionQuickPickLike,
  selected: SessionQuickPickItem | undefined,
) {
  if (!selected?.session) {
    return;
  }

  if (selected.directoryExists === false) {
    await messages.showWarningMessage?.(
      "The directory for this session may not be directly accessible from VS Code, but the session can still be opened.",
      { modal: false },
    );
  }

  quickPick.hide();
  await sessionManager.startSession({
    sessionId: selected.session.id,
    cwd: selected.session.directory,
    sessionLabel: selected.session.title,
    ...(selected.session.updated !== undefined ? { updated: selected.session.updated } : {}),
  });
}

async function handleSessionItemButton({
  event,
  sessionManager,
  messages,
  workspaceFolders,
  primaryCwd,
  quickPick,
  buttons,
}: {
  event: { item: SessionQuickPickItem; button: QuickPickButtonLike };
  sessionManager: SessionStarter;
  messages: MessageDeps;
  workspaceFolders: WorkspaceFolderOption[];
  primaryCwd: string | undefined;
  quickPick: SessionQuickPickLike;
  buttons: SessionItemButtons;
}) {
  const session = event.item.session;
  if (!session) {
    return;
  }

  if (event.button === buttons.forkButton) {
    const folder = await selectWorkspaceFolder(workspaceFolders, messages, session.directory);
    if (!folder) {
      return;
    }
    quickPick.hide();
    await sessionManager.startSession({
      sessionId: session.id,
      fork: true,
      cwd: folder.uri,
      sessionLabel: session.title,
      ...(session.updated !== undefined ? { updated: session.updated } : {}),
    });
    return;
  }

  if (event.button === buttons.deleteButton) {
    quickPick.hide();
    await showDeleteSessionsQuickPick(messages, workspaceFolders, primaryCwd, [session.id]);
    return;
  }

  if (event.button === buttons.archiveButton) {
    quickPick.hide();
    await showArchiveSessionsQuickPick(messages, workspaceFolders, primaryCwd, [session.id]);
    return;
  }

  if (event.button === buttons.unarchiveButton) {
    quickPick.hide();
    await showUnarchiveSessionsQuickPick(messages, workspaceFolders, primaryCwd, [session.id]);
  }
}

function getSelectedSessions(quickPick: SessionQuickPickLike) {
  return quickPick.selectedItems.flatMap((item) => item.session ? [item.session] : []);
}

async function runManageSessionAction({
  action,
  sessions,
  quickPick,
  refresh,
  runBatch,
  run,
}: {
  action: "archive" | "unarchive";
  sessions: OpenCodeSessionSummary[];
  quickPick: SessionQuickPickLike;
  refresh: () => Promise<void>;
  runBatch?: (sessionIds: string[]) => void | Promise<void>;
  run: (session: OpenCodeSessionSummary) => void | Promise<void>;
}) {
  quickPick.busy = true;
  try {
    if (runBatch) {
      await runBatch(sessions.map((session) => session.id));
      quickPick.hide();
      return sessions.length;
    }

    const failures: Array<{ session: OpenCodeSessionSummary; message: string }> = [];
    let successCount = 0;
    for (const session of sessions) {
      try {
        await run(session);
        successCount += 1;
      } catch (error) {
        failures.push({
          session,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (failures.length === 0) {
      quickPick.hide();
      return successCount;
    }

    if (successCount > 0) {
      await refresh();
    }

    throw new Error(formatManageSessionActionFailure(action, successCount, failures));
  } finally {
    quickPick.busy = false;
  }
}

function formatManageSessionActionFailure(
  action: "archive" | "unarchive",
  successCount: number,
  failures: Array<{ session: OpenCodeSessionSummary; message: string }>,
) {
  const failureSummary = failures
    .map(({ session, message }) => `${getSessionTitle(session)}: ${message}`)
    .join("; ");
  const failedCountLabel = formatSessionCount(failures.length);
  if (successCount > 0) {
    return `${formatCompletedManageAction(action, successCount)}, but failed to ${action} ${failedCountLabel}: ${failureSummary}`;
  }
  return `Failed to ${action} ${failedCountLabel}: ${failureSummary}`;
}

function formatDeletedManageAction(count: number) {
  return `Deleted ${formatSessionCount(count)}`;
}

function formatCompletedManageAction(action: "archive" | "unarchive", count: number) {
  const verb = action === "archive" ? "Archived" : "Unarchived";
  return `${verb} ${formatSessionCount(count)}`;
}

function formatSessionCount(count: number) {
  return `${count} OpenCode session${count === 1 ? "" : "s"}`;
}

type SessionView = OpenCodeSessionSummary & { directoryExists: boolean };

async function withDirectoryExistence(sessions: OpenCodeSessionSummary[], messages: MessageDeps): Promise<SessionView[]> {
  const checks = sessions.map(async (session) => ({
    ...session,
    directoryExists: session.directory ? await checkPathExists(session.directory, messages) : false,
  }));
  return Promise.all(checks);
}

async function checkPathExists(path: string, messages: MessageDeps) {
  return messages.pathExists ? messages.pathExists(path) : true;
}

function getSessionTitle(session: OpenCodeSessionSummary) {
  return typeof session.title === "string" && session.title.trim() ? session.title.trim() : session.id;
}

function isArchivedSession(session: OpenCodeSessionSummary) {
  if (typeof session.timeArchived === "number") {
    return true;
  }

  if (typeof session.timeArchived === "string") {
    const value = session.timeArchived.trim().toLowerCase();
    return value.length > 0 && value !== "null";
  }

  return false;
}

function formatInvalidDirectoryDetail(session: OpenCodeSessionSummary) {
  return session.directory ? `Missing directory: ${session.directory}` : "No directory recorded";
}

function formatMissingDirectoryMessage(session: OpenCodeSessionSummary) {
  return session.directory
    ? `Cannot open OpenCode session because its directory no longer exists: ${session.directory}`
    : "Cannot open OpenCode session because it has no recorded directory.";
}

function normalizePathForComparison(path: string): string {
  return path
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\/+$/, "");
}

function disposeAll(disposables: Disposable[], quickPick: SessionQuickPickLike) {
  for (const disposable of disposables) {
    disposable.dispose();
  }
  quickPick.dispose();
}

async function selectWorkspaceFolder(
  folders: WorkspaceFolderOption[],
  messages: MessageDeps,
  preferredUri?: string,
) {
  if (folders.length === 0) {
    throw new Error("OpenCode requires an open workspace folder.");
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const preferred = preferredUri ? folders.find((folder) => folder.uri === preferredUri) : undefined;
  return messages.showWorkspaceFolderPick ? messages.showWorkspaceFolderPick(folders) : preferred ?? folders[0];
}
