import * as vscode from "vscode";
import { readApplyPatchFailureRecords, type ApplyPatchFailureRecord } from "./apply-patch-failure-log";
import { BridgeServer } from "./bridge-server";
import { BRIDGE_PLUGIN_FILENAME } from "./plugin-constants";
import { createProposeEditCommand } from "./commands/propose-edit";
import { createQueueReviewEditCommand } from "./commands/queue-review-edit";
import {
  createKeepAllReviewItemsCommand,
  createKeepReviewItemCommand,
  createOpenReviewDiffCommand,
  createUndoAllReviewItemsCommand,
  createUndoReviewItemCommand,
} from "./commands/review-queue-actions";
import { createStartOpenCodeSessionCommand } from "./commands/start-opencode-session";
import {
  OpenCodeSessionManager,
  buildOpenCodeTerminalName,
  buildSessionConfigContent,
  isValidSessionId,
  type StartSessionOptions,
} from "./opencode/session-manager";
import { OpenCodeBackgroundNotifier, type OpenCodeNotificationSettings, type OpenCodeSourceState } from "./notifications/opencode-notifier";
import { NodeNotifierExternalNotifier } from "./notifications/external-notifier";
import { OpenCodeSessionEventMonitor, type OpenCodeEvent } from "./opencode/session-event-monitor";
import { resolveActiveSessionPanelSelection } from "./opencode/active-terminal-selection";
import {
  createSessionRestoreId,
  dedupeSessionsByTitle,
} from "./opencode/session-restore";
import { OpenCodeSessionRepository, type OpenCodeSessionSummary } from "./opencode/session-repository";
import { OpenCodeSessionTitlePoller } from "./opencode/session-title-poller";
import { OpenCodeSessionPanelProvider, OPENCODE_SESSION_PANEL_VIEW_ID } from "./opencode/session-panel-provider";
import type { OpenCodeSessionTabState, OpenCodeSessionTabStatus } from "./opencode/session-tab-status-registry";
import { readOpenCodeEventSessionId, shouldReconcileTitleForEvent } from "./opencode/session-event-routing";
import {
  confirmRestoreSessionId,
  createRestoreSessionTrackingState,
  discardRestoreSessionCandidate,
  queueRestoreSessionCandidate,
  type RestoreSessionTrackingState,
} from "./opencode/session-id-tracker";
import { applyTerminalAttentionLabel, type OpenCodeTerminalLabelState } from "./opencode/terminal-attention";
import { handleTuiActiveSession } from "./opencode/tui-session-activation";
import { getExistingDocumentProbeSupport } from "./copilot/apply-discard-probe";
import { toWorkspaceEditSpec } from "./edit/workspace-edit-adapter";
import { prepareSideBySideEditorLayout } from "./layout/side-by-side-layout";
import type { TuiSessionActiveMessage } from "./bridge-protocol";
import type { PreparedOperation } from "./bridge-editing";
import { toDisplayPathForFile } from "./display-path";
import {
  ReviewDocumentProvider,
  REVIEW_BEFORE_DOCUMENT_SCHEME,
  REVIEW_CURRENT_DOCUMENT_SCHEME,
} from "./review/review-document-provider";
import { ReviewPanelProvider, REVIEW_PANEL_VIEW_ID } from "./review/review-panel-provider";
import { ReviewDiffController } from "./review/review-diff-controller";
import { ReviewQueueManager } from "./review/review-queue-manager";
import { shouldSaveAfterApply } from "./review/review-save-policy";
import { mergeReviewSessionMetadata, type ReviewSessionMetadata } from "./review/review-session-metadata";
import type { ReviewQueueItem } from "./review/review-queue-store";
import { calculateStats, ReviewQueueStore } from "./review/review-queue-store";
import type { DocumentSnapshot, NormalizedProposal } from "./types/proposal";

const REVIEW_QUEUE_STATE_KEY = "opencodeEdit.reviewQueue";
const APPLY_PATCH_FAILURE_RECORDS_KEY = "opencodeEdit.applyPatchFailureRecords";
const MONITOR_ERROR_LOG_COOLDOWN_MS = 30000;
const MAX_MONITOR_ERROR_LOG_BUCKETS = 200;
const TITLE_RECONCILIATION_RETRY_LIMIT = 6;
const TITLE_RECONCILIATION_RETRY_DELAY_MS = 1000;
type ManagedOpenCodeTerminal = vscode.Terminal & {
  opencodeRestoreId?: string;
};
type ManagedOpenCodeSession = {
  terminal: ManagedOpenCodeTerminal;
  openCodePort: number;
};

export function activate(context: vscode.ExtensionContext) {
  const persistedReviewQueueItems = loadPersistedReviewQueueItems(context);
  let previousReviewItemIds = new Set(persistedReviewQueueItems.map((item) => item.id));
  let reviewDocumentProvider: ReviewDocumentProvider;
  let reviewDiffController: ReviewDiffController | undefined;
  let refreshReviewSessionMetadata: () => Promise<void> = async () => undefined;
  const reviewQueueStore = new ReviewQueueStore(
    persistedReviewQueueItems,
    (items) => {
      const nextIds = new Set(items.map((item) => item.id));
      const removedIds = [...previousReviewItemIds].filter((itemId) => !nextIds.has(itemId));
      if (removedIds.length > 0) {
        reviewDiffController?.prepareForRemoval(removedIds);
      }
      reviewDiffController?.sync(items, removedIds);
      reviewDocumentProvider.notifyChanged([...nextIds]);
      previousReviewItemIds = nextIds;
      void context.workspaceState.update(REVIEW_QUEUE_STATE_KEY, items);
      void refreshReviewSessionMetadata();
    },
  );
  reviewDocumentProvider = new ReviewDocumentProvider(reviewQueueStore);
  reviewDiffController = new ReviewDiffController(reviewQueueStore, reviewDocumentProvider);
  const sessionRepository = new OpenCodeSessionRepository();
  const reviewQueueManager = new ReviewQueueManager(reviewQueueStore, {
    openDiff: (itemId) => reviewDiffController?.open(itemId) ?? Promise.resolve(),
    readTargetState: async (targetUri) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetUri));
        return {
          exists: true,
          text: document.getText(),
        };
      } catch {
        return {
          exists: false,
          text: "",
        };
      }
    },
    writeText: async (targetUri, text) => {
      const uri = vscode.Uri.parse(targetUri);
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        const lastLine = Math.max(document.lineCount - 1, 0);
        const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
        edit.replace(
          uri,
          new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
          text,
        );
        return vscode.workspace.applyEdit(edit);
      } catch {
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { ignoreIfExists: true });
        if (text.length > 0) {
          edit.insert(uri, new vscode.Position(0, 0), text);
        }
        return vscode.workspace.applyEdit(edit);
      }
    },
    deleteFile: async (targetUri) => {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.parse(targetUri));
        return true;
      } catch {
        return false;
      }
    },
    saveTarget: async (targetUri) => {
      return saveAfterApply(vscode.Uri.parse(targetUri), "existing");
    },
    showWarningMessage: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  const reviewPanelProvider = new ReviewPanelProvider(context.extensionUri, reviewQueueStore, reviewQueueManager, reviewDiffController);
  reviewPanelProvider.updateVisibility();
  refreshReviewSessionMetadata = async () => {
    const metadata = await readReviewSessionMetadata(context.workspaceState, reviewQueueStore, sessionRepository);
    reviewPanelProvider.setSessionMetadata(metadata.sessionTitlesById, metadata.sessionCanonicalIdsById);
    reviewPanelProvider.render();
  };
  void refreshReviewSessionMetadata();
  const sessionPanelProvider = new OpenCodeSessionPanelProvider(context.extensionUri, {
    openSessionPicker: async () => {
      await vscode.commands.executeCommand("opencodeEdit.startSession");
    },
    markSelected: (restoreId) => {
      queueOpenCodeTitleReconciliation(restoreId, 0);
    },
    revealSession: (restoreId) => {
      const terminal = findOpenCodeTerminalByRestoreId(restoreId);
      if (terminal) {
        terminal.show(false);
      }
    },
    closeSession: async (restoreId) => {
      const terminal = findOpenCodeTerminalByRestoreId(restoreId);
      const managedTerminal = terminal as ManagedOpenCodeTerminal | undefined;
      if (managedTerminal) {
        delete managedTerminal.opencodeRestoreId;
      }
      terminal?.dispose();
      clearTrackedSession(restoreId);
    },
  });
  const notifier = new OpenCodeBackgroundNotifier({
    isFocused: () => vscode.window.state.focused,
    setStatus: (_status, _source) => undefined,
    markAttention: (source) => {
      if (source?.restoreId) {
        queueOpenCodeTitleReconciliation(source.restoreId, 0);
      }
    },
  }, readNotificationSettings(), new NodeNotifierExternalNotifier());
  const sessionEventMonitors = new Map<string, OpenCodeSessionEventMonitor>();
  const trackedSessionStates = new Map<string, RestoreSessionTrackingState>();
  const restoreIdsByOpenCodePort = new Map<number, string>();
  const restoreInfosByRestoreId = new Map<string, TrackedSessionInfo>();
  const latestTuiActivationsByRestoreId = new Map<string, number>();
  const pendingSessionIdValidations = new Set<string>();
  const queuedTitleReconciliations = new Map<string, NodeJS.Timeout>();
  const titleReconciliationAttempts = new Map<string, number>();
  let titleReconciliationQueue: Promise<void> = Promise.resolve();
  const lastMonitorErrorLogAt = new Map<string, number>();
  let notifyTuiActiveSession: (message: TuiSessionActiveMessage) => Promise<boolean> = async () => false;
  const bridgeServer = new BridgeServer({
    asAbsolutePath: (relativePath) => context.asAbsolutePath(relativePath),
    queuePreparedOperation: async (prepared) => queuePreparedOperation(prepared, reviewQueueStore, reviewPanelProvider),
    readPendingFileState: (uri) => readPendingReviewFileState(uri, reviewQueueStore),
    recordApplyPatchFailure: async (record) => {
      const records = readPersistedApplyPatchFailureRecords(context);
      await context.workspaceState.update(APPLY_PATCH_FAILURE_RECORDS_KEY, [...records, record].slice(-100));
    },
    notifyTuiActiveSession: (message) => notifyTuiActiveSession(message),
    showErrorMessage: (message) => {
          void vscode.window.showErrorMessage(message);
        },
  });
  const createSessionConfig = () =>
    buildSessionConfigContent(
      {
        $schema: "https://opencode.ai/config.json",
        // The bridge plugin shadows the builtin edit tools by name.
        plugin: [
          vscode.Uri.file(context.asAbsolutePath(BRIDGE_PLUGIN_FILENAME)).toString(),
        ],
      },
      {
        disableBuiltinEditing: false,
      },
    );
  const sessionManager = new OpenCodeSessionManager(
    ({ name, env, strictEnv, cwd, shellPath, shellArgs, location }) =>
      vscode.window.createTerminal({
        name,
        env,
        strictEnv,
        cwd,
        shellPath,
        shellArgs,
        location,
      }),
    createSessionConfig,
    () => bridgeServer.environment(),
  );
  const titlePoller = new OpenCodeSessionTitlePoller({
    repository: sessionRepository,
    onTitleChanged: ({ restoreId, sessionId, title, updated }) => {
      void applyResolvedSessionTitle({
        restoreId,
        resolution: {
          terminalName: title,
          sessionLabel: title,
          sessionId,
          updated,
        },
      }).catch(() => {
        queueOpenCodeTitleReconciliation(restoreId, 0);
      });
    },
    onError: (error, entry) => {
      logThrottledMonitorWarning(lastMonitorErrorLogAt, `title-poller:${entry.restoreId}`, "OpenCode title poller retrying:", error);
    },
  });
  void vscode.commands.executeCommand("setContext", "opencodeEdit.hasOpenCodeSessions", false);
  const syncSessionPanelStatus = (restoreId: string) => {
    sessionPanelProvider.updateStatus(restoreId, toSessionPanelStatus(notifier.readSourceState({ restoreId })));
  };
  const registerSessionPanelTab = (restoreInfo: { restoreId?: string; sessionId?: string; sessionLabel?: string; terminalName?: string; cwd?: string; updated?: number | string }, hidden = false) => {
    if (!restoreInfo.restoreId) {
      return;
    }

    const title = restoreInfo.sessionLabel?.trim()
      || restoreInfo.terminalName?.trim()
      || restoreInfo.sessionId
      || "new session";
    sessionPanelProvider.registerSession({
      restoreId: restoreInfo.restoreId,
      sessionId: restoreInfo.sessionId,
      cwd: restoreInfo.cwd,
      updated: restoreInfo.updated,
      title,
      hidden,
      status: toSessionPanelStatus(notifier.readSourceState({ restoreId: restoreInfo.restoreId })),
    });
    titlePoller.track({
      restoreId: restoreInfo.restoreId,
      sessionId: restoreInfo.sessionId,
      cwd: restoreInfo.cwd,
      title,
      updated: restoreInfo.updated,
    });
    void refreshReviewSessionMetadata();
  };
  const applyResolvedSessionTitle = async ({
    restoreId,
    resolution,
  }: {
    restoreId: string;
      resolution: {
        terminalName: string;
        sessionLabel?: string;
        sessionId?: string;
        updated?: number | string;
      };
  }) => {
    sessionPanelProvider.registerSession({
      restoreId,
      title: resolution.sessionLabel ?? resolution.terminalName,
      sessionId: resolution.sessionId,
      updated: resolution.updated,
      status: toSessionPanelStatus(notifier.readSourceState({ restoreId })),
    });
    titlePoller.track({
      restoreId,
      sessionId: resolution.sessionId,
      title: resolution.sessionLabel ?? resolution.terminalName,
      updated: resolution.updated,
    });

    const terminal = findOpenCodeTerminalByRestoreId(restoreId);
    if (!terminal || terminal.exitStatus !== undefined) {
      return;
    }

    const targetTerminalName = applyTerminalAttentionLabel(
      resolution.terminalName,
      readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates),
    );
    if (terminal.name !== targetTerminalName) {
      terminal.show(true);
      await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: targetTerminalName });
    }

    void refreshReviewSessionMetadata();
  };
  const viewedTerminalStates = new Map<string, Exclude<OpenCodeTerminalLabelState, "running" | "normal">>();
  const enqueueTrackedOpenCodeTitleReconciliation = (restoreId: string) => {
    const next = titleReconciliationQueue
      .catch(() => undefined)
      .then(async () => {
        const terminal = findOpenCodeTerminalByRestoreId(restoreId);
        if (!terminal || terminal.exitStatus !== undefined) {
          return;
        }

        const existingInfo = restoreInfosByRestoreId.get(restoreId);
        if (!existingInfo) {
          return;
        }

        const sessionId = existingInfo.sessionId;
        if (!sessionId || !isValidSessionId(sessionId)) {
          return;
        }

        const session = await sessionRepository.findSessionByIdAsync(sessionId, existingInfo.cwd);
        if (!session || session.parentId) {
          return;
        }

        const title = session.title?.trim() || existingInfo.sessionLabel || existingInfo.terminalName || sessionId;
        const terminalState = readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates);
        const targetTerminalName = applyTerminalAttentionLabel(title, terminalState);
        if (terminal.name !== targetTerminalName) {
          try {
            terminal.show(true);
            await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: targetTerminalName });
          } catch {
            const nextAttempt = (titleReconciliationAttempts.get(restoreId) ?? 0) + 1;
            if (nextAttempt <= TITLE_RECONCILIATION_RETRY_LIMIT) {
              titleReconciliationAttempts.set(restoreId, nextAttempt);
              queueOpenCodeTitleReconciliation(restoreId, TITLE_RECONCILIATION_RETRY_DELAY_MS);
            }
            return;
          }
        }

        titleReconciliationAttempts.delete(restoreId);
        await applyResolvedSessionTitle({
          restoreId,
          resolution: { terminalName: title, sessionLabel: title, sessionId, updated: session.updated },
        });
      })
      .catch(() => undefined);
    titleReconciliationQueue = next;
    return next;
  };
  const queueOpenCodeTitleReconciliation = (restoreId: string, delayMs = 250) => {
    clearTimeout(queuedTitleReconciliations.get(restoreId));
    queuedTitleReconciliations.set(restoreId, setTimeout(() => {
      queuedTitleReconciliations.delete(restoreId);
      void enqueueTrackedOpenCodeTitleReconciliation(restoreId);
    }, delayMs));
  };
  const clearTerminalAttentionForActiveTerminal = (terminal: vscode.Terminal | undefined) => {
    if (!terminal) {
      return;
    }

    const managedTerminal = terminal as ManagedOpenCodeTerminal;
    const restoreId = managedTerminal.opencodeRestoreId;
    if (restoreId) {
      const currentState = notifier.readSourceState({ restoreId });
      if (currentState === "permission" || currentState === "error" || currentState === "idle") {
        viewedTerminalStates.set(restoreId, currentState);
      }
      queueOpenCodeTitleReconciliation(restoreId, 0);
    }
  };
  const resetOpenCodeTitleReconciliationAttempts = (restoreId: string) => {
    titleReconciliationAttempts.delete(restoreId);
  };
  const isPlausibleTuiActivation = (timestamp: number) => timestamp <= Date.now() + 60_000;
  const queueAllOpenCodeTitleReconciliations = (delayMs = 250) => {
    for (const restoreId of restoreInfosByRestoreId.keys()) {
      queueOpenCodeTitleReconciliation(restoreId, delayMs);
    }
  };
  const clearTrackedSession = (restoreId: string) => {
    viewedTerminalStates.delete(restoreId);
    trackedSessionStates.delete(restoreId);
    restoreInfosByRestoreId.delete(restoreId);
    latestTuiActivationsByRestoreId.delete(restoreId);
    deleteOpenCodePortRestoreId(restoreIdsByOpenCodePort, restoreId);
    notifier.clearSource({ restoreId });
    sessionPanelProvider.closeSession(restoreId);
    titlePoller.remove(restoreId);
    disposeOpenCodeSessionEventMonitor(restoreId, sessionEventMonitors);
    resetOpenCodeTitleReconciliationAttempts(restoreId);
  };
  type TrackedSessionInfo = {
    restoreId: string;
    sessionId?: string;
    sessionLabel?: string;
    terminalName?: string;
    cwd?: string;
    startedAt?: number;
  };

  const confirmTrackedOpenCodeSession = async (restoreInfo: TrackedSessionInfo, session: OpenCodeSessionSummary) => {
    if (session.parentId || !isValidSessionId(session.id)) {
      return;
    }

    const sessionId = session.id;
    const currentState = trackedSessionStates.get(restoreInfo.restoreId) ?? createRestoreSessionTrackingState(restoreInfo.sessionId);
    notifier.clearSourceExceptSession({ restoreId: restoreInfo.restoreId }, sessionId);
    trackedSessionStates.set(restoreInfo.restoreId, confirmRestoreSessionId(queueRestoreSessionCandidate(currentState, sessionId), sessionId));

    const title = session.title?.trim()
      ? session.title.trim()
      : restoreInfo.sessionLabel ?? restoreInfo.terminalName ?? sessionId;
    titlePoller.track({
      restoreId: restoreInfo.restoreId,
      sessionId,
      cwd: restoreInfo.cwd,
      title,
      updated: session.updated,
    });
    sessionPanelProvider.registerSession({
      restoreId: restoreInfo.restoreId,
      sessionId,
      cwd: restoreInfo.cwd,
      updated: session.updated,
      title,
      status: toSessionPanelStatus(notifier.readSourceState({ restoreId: restoreInfo.restoreId })),
    });
    await applyResolvedSessionTitle({
      restoreId: restoreInfo.restoreId,
      resolution: {
        terminalName: title,
        sessionLabel: title,
        sessionId,
        updated: session.updated,
      },
    });
    resetOpenCodeTitleReconciliationAttempts(restoreInfo.restoreId);
    queueOpenCodeTitleReconciliation(restoreInfo.restoreId, 0);
  };
  notifyTuiActiveSession = async (message) => {
    const result = await handleTuiActiveSession(message, {
      restoreInfoForPort: (openCodePort) => {
        const restoreId = openCodePort ? restoreIdsByOpenCodePort.get(openCodePort) : undefined;
        return restoreId ? restoreInfosByRestoreId.get(restoreId) : undefined;
      },
      shouldProcessActivation: (restoreInfo, activeMessage) => {
        if (!isPlausibleTuiActivation(activeMessage.activationTimestamp)) {
          return false;
        }

        const latestActivation = latestTuiActivationsByRestoreId.get(restoreInfo.restoreId);
        if (latestActivation !== undefined && activeMessage.activationTimestamp < latestActivation) {
          return false;
        }

        latestTuiActivationsByRestoreId.set(restoreInfo.restoreId, activeMessage.activationTimestamp);
        return true;
      },
      findSessionById: (sessionId, cwd) => sessionRepository.findSessionByIdAsync(sessionId, cwd),
      confirmSession: (restoreInfo, session) => confirmTrackedOpenCodeSession(restoreInfo, session),
      onError: (error, restoreId) => {
        logThrottledMonitorWarning(lastMonitorErrorLogAt, `tui-session:${restoreId}`, "OpenCode TUI session bridge retrying:", error);
        queueOpenCodeTitleReconciliation(restoreId, 0);
      },
    });
    return result !== "retry";
  };
  const startOpenCodeSession = async (options: StartSessionOptions = {}) => {
    const startedAt = Date.now();
    const normalizedOptions = {
      ...options,
      startedAt,
      terminalName: options.terminalName ?? buildOpenCodeTerminalName(options),
    };
    const restoreId = createSessionRestoreId();
    trackedSessionStates.set(restoreId, createRestoreSessionTrackingState(options.sessionId));
    const launch = sessionManager.buildLaunchSpec(process.env, normalizedOptions);
    const session = sessionManager.startLaunchSpec(launch) as ManagedOpenCodeSession;
    restoreIdsByOpenCodePort.set(session.openCodePort, restoreId);
    registerSessionPanelTab({ restoreId, sessionId: options.sessionId, sessionLabel: options.sessionLabel, terminalName: normalizedOptions.terminalName, cwd: options.cwd, updated: options.updated }, false);
    const managedTerminal = session.terminal;
    managedTerminal.opencodeRestoreId = restoreId;
    const eventMonitor = new OpenCodeSessionEventMonitor({
      port: session.openCodePort,
      onEvent: (event) => {
        const source = { restoreId };
        const previousTerminalState = readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates);
        const sessionId = readOpenCodeEventSessionId(event);
        if (sessionId) {
          const currentState = trackedSessionStates.get(restoreId) ?? createRestoreSessionTrackingState();
          if (currentState.confirmedSessionId === sessionId) {
            notifier.handleEvent(event, source);
            syncSessionPanelStatus(restoreId);
            if (shouldReconcileTitleForEvent(event, previousTerminalState, readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates))) {
              queueOpenCodeTitleReconciliation(restoreId, 0);
            }
            return;
          }

          const nextState = queueRestoreSessionCandidate(currentState, sessionId);
            if (nextState === currentState) {
              notifier.handleEvent(event, source);
              syncSessionPanelStatus(restoreId);
              if (shouldReconcileTitleForEvent(event, previousTerminalState, readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates))) {
                queueOpenCodeTitleReconciliation(restoreId, 0);
              }
              return;
            }

          trackedSessionStates.set(restoreId, nextState);
          const validationKey = `${restoreId}:${sessionId}`;
          if (!pendingSessionIdValidations.has(validationKey)) {
            pendingSessionIdValidations.add(validationKey);
            void Promise.resolve()
              .then(() => sessionRepository.findSessionByIdAsync(sessionId, options.cwd))
              .then((session) => {
                const latestState = trackedSessionStates.get(restoreId);
                if (!latestState) {
                  return;
                }

                if (
                  latestState.confirmedSessionId
                  && latestState.confirmedSessionId !== sessionId
                  && !latestState.pendingSessionIds.includes(sessionId)
                ) {
                  return;
                }

                if (session && !session.parentId) {
                  trackedSessionStates.set(restoreId, confirmRestoreSessionId(latestState, sessionId));
                  return confirmTrackedOpenCodeSession({ restoreId, sessionId: options.sessionId, sessionLabel: options.sessionLabel, terminalName: normalizedOptions.terminalName, cwd: options.cwd, startedAt }, session);
                }

                trackedSessionStates.set(restoreId, discardRestoreSessionCandidate(latestState, sessionId));
                return undefined;
              })
              .catch(() => {
                const latestState = trackedSessionStates.get(restoreId);
                if (latestState) {
                  trackedSessionStates.set(restoreId, discardRestoreSessionCandidate(latestState, sessionId));
                }
              })
              .finally(() => {
                pendingSessionIdValidations.delete(validationKey);
              });
          }
        }
        notifier.handleEvent(event, source);
        syncSessionPanelStatus(restoreId);
        if (shouldReconcileTitleForEvent(event, previousTerminalState, readTrackedOpenCodeTerminalState(notifier, restoreId, viewedTerminalStates))) {
          queueOpenCodeTitleReconciliation(restoreId, 0);
        }
      },
      onError: (error) => {
        logThrottledMonitorWarning(lastMonitorErrorLogAt, `monitor:${restoreId}`, "OpenCode event monitor retrying:", error);
      },
      onMalformedEvent: (error) => {
        logThrottledMonitorWarning(lastMonitorErrorLogAt, `malformed:${restoreId}`, "Ignored malformed OpenCode event:", error);
      },
    });
    sessionEventMonitors.get(restoreId)?.dispose();
    sessionEventMonitors.set(restoreId, eventMonitor);
    eventMonitor.start();
    resetOpenCodeTitleReconciliationAttempts(restoreId);
    queueOpenCodeTitleReconciliation(restoreId, 0);
  };
  context.subscriptions.push(
    bridgeServer,
    reviewDiffController,
    reviewPanelProvider,
    sessionPanelProvider,
    titlePoller,
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_BEFORE_DOCUMENT_SCHEME, reviewDocumentProvider),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_CURRENT_DOCUMENT_SCHEME, reviewDocumentProvider),
    vscode.window.registerWebviewViewProvider(REVIEW_PANEL_VIEW_ID, reviewPanelProvider),
    vscode.window.registerWebviewViewProvider(OPENCODE_SESSION_PANEL_VIEW_ID, sessionPanelProvider),
    {
      dispose: () => {
        disposeAllOpenCodeSessionEventMonitors(sessionEventMonitors);
        disposeAllQueuedOpenCodeTitleReconciliations(queuedTitleReconciliations);
        titleReconciliationAttempts.clear();
      },
    },
    vscode.window.onDidChangeWindowState((state) => notifier.setFocused(state.focused)),
    vscode.window.onDidOpenTerminal((terminal) => {
      const restoreId = (terminal as ManagedOpenCodeTerminal).opencodeRestoreId;
      if (restoreId) {
        queueOpenCodeTitleReconciliation(restoreId, 0);
      }
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) {
        sessionPanelProvider.clearSelection();
        return;
      }

      clearTerminalAttentionForActiveTerminal(terminal);
      const restoreId = (terminal as ManagedOpenCodeTerminal).opencodeRestoreId;
      const selection = resolveActiveSessionPanelSelection({
        terminalAtRequest: terminal,
        activeTerminal: vscode.window.activeTerminal,
        restoreId,
      });

      switch (selection.type) {
        case "ignore":
          return;
        case "select":
          sessionPanelProvider.selectSession(selection.restoreId);
          return;
        case "clear":
          sessionPanelProvider.clearSelection();
          return;
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (vscode.window.activeTerminal) {
        return;
      }

      sessionPanelProvider.clearSelection();
    }),
    vscode.window.onDidChangeTerminalState((terminal) => {
      const restoreId = (terminal as ManagedOpenCodeTerminal).opencodeRestoreId;
      if (restoreId) {
        queueOpenCodeTitleReconciliation(restoreId);
      }
    }),
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
      const restoreId = (terminal as ManagedOpenCodeTerminal).opencodeRestoreId;
      if (restoreId) {
        queueOpenCodeTitleReconciliation(restoreId, 0);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("opencodeEdit.notifications")) {
        notifier.updateSettings(readNotificationSettings());
      }
    }),
    vscode.commands.registerCommand(
      "opencodeEdit.startSession",
      createStartOpenCodeSessionCommand({
        startSession: (options?: StartSessionOptions) => startOpenCodeSession(options),
        waitUntilReady: () => bridgeServer.waitUntilReady(),
      }, {
        prepareLayout: () => prepareSideBySideEditorLayout((command, ...args) => vscode.commands.executeCommand(command, ...args)),
        showErrorMessage: (message) => {
          void vscode.window.showErrorMessage(message);
        },
        showInformationMessage: (message) => {
          showTransientInformationMessage(message);
        },
        createQuickPick: process.env.OPENCODE_EDIT_BYPASS_SESSION_PICKER === "1"
          ? undefined
          : () => vscode.window.createQuickPick(),
        listSessions: (cwd) => sessionRepository.listSessionsAsync(cwd),
        listAllSessions: (cwd) => sessionRepository.listAllSessionsAsync(cwd),
        listArchivedSessions: (cwd) => sessionRepository.listArchivedSessionsAsync(cwd),
        deleteSession: (sessionId, cwd) => sessionRepository.deleteSession(sessionId, cwd),
        deleteSessions: (sessionIds, cwd) => sessionRepository.deleteSessions(sessionIds, cwd),
        archiveSession: (sessionId) => sessionRepository.archiveSession(sessionId),
        archiveSessions: (sessionIds) => sessionRepository.archiveSessions(sessionIds),
        unarchiveSession: (sessionId) => sessionRepository.unarchiveSession(sessionId),
        unarchiveSessions: (sessionIds) => sessionRepository.unarchiveSessions(sessionIds),
        pathExists: (path) => pathExists(path),
        getWorkspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          uri: folder.uri.fsPath,
        })),
        showWorkspaceFolderPick: async (folders) => {
          const selected = await vscode.window.showQuickPick(
            folders.map((folder) => ({ label: folder.name, description: folder.uri, folder })),
            { placeHolder: "Select workspace folder for the OpenCode session" },
          );
          return selected?.folder;
        },
        showWarningMessage: async (message, options, ...items) => vscode.window.showWarningMessage(message, options ?? {}, ...items),
        forkButton: {
          iconPath: new vscode.ThemeIcon("git-branch"),
          tooltip: "fork",
        },
        deleteButton: {
          iconPath: new vscode.ThemeIcon("trash"),
          tooltip: "delete",
        },
        archiveButton: {
          iconPath: new vscode.ThemeIcon("archive"),
          tooltip: "archive",
        },
        unarchiveButton: {
          iconPath: new vscode.ThemeIcon("reply"),
          tooltip: "unarchive",
        },
      }),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.probeApplyDiscard",
      createProposeEditCommand("auto", createCommandDeps()),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.probeScratchEdit",
      createProposeEditCommand("scratch", createCommandDeps()),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.queueReviewEdit",
      createQueueReviewEditCommand("auto", createQueueCommandDeps(reviewQueueStore, reviewPanelProvider)),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.review.openDiff",
      createOpenReviewDiffCommand(reviewQueueManager),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.review.keep",
      createKeepReviewItemCommand(reviewQueueManager, reviewPanelProvider, reviewDiffController),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.review.undo",
      createUndoReviewItemCommand(reviewQueueManager, reviewPanelProvider, reviewDiffController),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.review.keepAll",
      createKeepAllReviewItemsCommand(reviewQueueManager, reviewPanelProvider, reviewDiffController, () => reviewQueueStore.list()),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.review.undoAll",
      createUndoAllReviewItemsCommand(reviewQueueManager, reviewPanelProvider, reviewDiffController, () => reviewQueueStore.list()),
    ),
    ...createDebugCommandRegistrations({
      context,
      bridgeServer,
      notifier,
      sessionManager,
      restoreIdsByOpenCodePort,
      syncSessionPanelStatus,
      startSession: (options) => startOpenCodeSession(options),
      sessionRepository,
      reviewQueueStore,
      reviewPanelProvider,
      sessionPanelProvider,
    }),
vscode.window.onDidCloseTerminal((terminal) => {
      const managedTerminal = terminal as ManagedOpenCodeTerminal;
      const restoreId = managedTerminal.opencodeRestoreId;
      if (!restoreId) {
        return;
      }

      clearTrackedSession(restoreId);
    }),
  );
}

export function deactivate() {}

function applyDebugSessionNotificationStates(
  notifier: OpenCodeBackgroundNotifier,
  inputs: Array<{ restoreId: string; state: OpenCodeSourceState; sessionId?: string }>,
  syncSessionPanelStatus: (restoreId: string) => void,
) {
  const restoreIds = new Set(inputs.map((input) => input.restoreId));
  for (const restoreId of restoreIds) {
    notifier.clearSource({ restoreId });
  }

  for (const input of inputs) {
    const sessionId = input.sessionId ?? toDebugSessionIdentifier(input.restoreId);
    const source = { restoreId: input.restoreId };

    switch (input.state) {
      case "running":
        notifier.handleEvent({
          type: "session.status",
          properties: {
            sessionID: sessionId,
            status: { type: "busy" },
          },
        }, source);
        break;
      case "permission":
        notifier.handleEvent({
          type: "session.status",
          properties: {
            sessionID: sessionId,
            status: { type: "busy" },
          },
        }, source);
        notifier.handleEvent({
          type: "permission.updated",
          properties: {
            id: `per_${sessionId}`,
            sessionID: sessionId,
            title: "Run command",
          },
        }, source);
        break;
      case "error":
        notifier.handleEvent({
          type: "session.error",
          properties: { sessionID: sessionId },
        }, source);
        break;
      case "idle":
        notifier.handleEvent({
          type: "session.status",
          properties: {
            sessionID: sessionId,
            status: { type: "busy" },
          },
        }, source);
        notifier.handleEvent({
          type: "session.idle",
          properties: { sessionID: sessionId },
        }, source);
        break;
      case "normal":
        break;
    }

    syncSessionPanelStatus(input.restoreId);
  }
}

function toDebugSessionIdentifier(restoreId: string) {
  const normalized = restoreId.replace(/[^A-Za-z0-9_]/g, "_");
  return `ses_debug_${normalized}`;
}

function createDebugCommandRegistrations({
  context,
  bridgeServer,
  notifier,
  sessionManager,
  restoreIdsByOpenCodePort,
  syncSessionPanelStatus,
  startSession,
  sessionRepository,
  reviewQueueStore,
  reviewPanelProvider,
  sessionPanelProvider,
}: {
  context: vscode.ExtensionContext;
  bridgeServer: BridgeServer;
  notifier: OpenCodeBackgroundNotifier;
  sessionManager: OpenCodeSessionManager;
  restoreIdsByOpenCodePort: Map<number, string>;
  syncSessionPanelStatus(restoreId: string): void;
  startSession(options?: StartSessionOptions): Promise<void>;
  sessionRepository: OpenCodeSessionRepository;
  reviewQueueStore: ReviewQueueStore;
  reviewPanelProvider: ReviewPanelProvider;
  sessionPanelProvider: OpenCodeSessionPanelProvider;
}) {
  const debugRepository = sessionRepository as OpenCodeSessionRepository & {
    registerSessionForTest?(session: OpenCodeSessionSummary, cwd?: string): void;
  };

  if (context.extensionMode !== vscode.ExtensionMode.Development && context.extensionMode !== vscode.ExtensionMode.Test) {
    return [];
  }

  return [
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getReviewQueueState",
      () => reviewPanelProvider.getState(),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getReviewPanelHtml",
      () => reviewPanelProvider.getHtml(),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.clearReviewQueue",
      () => {
        reviewQueueStore.keepAll();
        reviewPanelProvider.render();
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getBridgeLaunchSpec",
      async () => {
        await bridgeServer.waitUntilReady();
        const launch = sessionManager.buildLaunchSpec();
        return {
          command: launch.command,
          configContent: launch.env.OPENCODE_CONFIG_CONTENT,
          environment: {
            OPENCODE_CALLER: launch.env.OPENCODE_CALLER,
            OPENCODE_TUI_CONFIG: launch.env.OPENCODE_TUI_CONFIG,
            OPENCODE_VSCODE_BRIDGE_PORT: launch.env.OPENCODE_VSCODE_BRIDGE_PORT,
            OPENCODE_VSCODE_BRIDGE_TOKEN: launch.env.OPENCODE_VSCODE_BRIDGE_TOKEN,
            OPENCODE_VSCODE_BRIDGE_URL: launch.env.OPENCODE_VSCODE_BRIDGE_URL,
            OPENCODE_VSCODE_WORKSPACE_ROOTS: launch.env.OPENCODE_VSCODE_WORKSPACE_ROOTS,
            WSLENV: launch.env.WSLENV,
            _EXTENSION_OPENCODE_PORT: launch.env._EXTENSION_OPENCODE_PORT,
          },
        };
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.startOpenCodeSession",
      async (options?: StartSessionOptions) => {
        await startSession(options);
        return sessionPanelProvider.getState();
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.revealReviewPanel",
      async () => {
        reviewPanelProvider.reveal();
        await vscode.commands.executeCommand("workbench.view.extension.opencodeEdit");
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getSessionPanelState",
      () => sessionPanelProvider.getState(),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getTrackedOpenCodePorts",
      () => Object.fromEntries([...restoreIdsByOpenCodePort].map(([port, restoreId]) => [restoreId, port])),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.registerSessionForTest",
      (session: OpenCodeSessionSummary, cwd?: string) => {
        debugRepository.registerSessionForTest?.(session, cwd);
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.notifyTuiActiveSession",
      async (input: TuiSessionActiveMessage) => {
        const accepted = await bridgeServer.notifyTuiActiveSessionForTest(input);
        if (!accepted) {
          throw new Error("TUI session activation was not accepted.");
        }
        return sessionPanelProvider.getState();
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.setSessionNotificationStates",
      (inputs: Array<{ restoreId: string; state: OpenCodeSourceState; sessionId?: string }>) => {
        applyDebugSessionNotificationStates(notifier, inputs, syncSessionPanelStatus);
        return sessionPanelProvider.getState();
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.setSessionPanelState",
      (state: OpenCodeSessionTabState) => {
        sessionPanelProvider.replaceState(state);
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.revealSessionsPanel",
      async () => {
        sessionPanelProvider.reveal();
        await vscode.commands.executeCommand("workbench.view.extension.opencodeEdit");
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getReviewPanelButtonStyles",
      async () => {
        reviewPanelProvider.reveal();
        await vscode.commands.executeCommand("workbench.view.extension.opencodeEdit");
        return reviewPanelProvider.getButtonStyles();
      },
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.getApplyPatchFailureRecords",
      () => readPersistedApplyPatchFailureRecords(context),
    ),
    vscode.commands.registerCommand(
      "opencodeEdit.debug.clearApplyPatchFailureRecords",
      async () => {
        await context.workspaceState.update(APPLY_PATCH_FAILURE_RECORDS_KEY, []);
      },
    ),
  ];
}

function findOpenCodeTerminalByRestoreId(restoreId: string): ManagedOpenCodeTerminal | undefined {
  for (const terminal of vscode.window.terminals) {
    const managedTerminal = terminal as ManagedOpenCodeTerminal;
    if (managedTerminal.opencodeRestoreId === restoreId) {
      return managedTerminal;
    }
  }

  return undefined;
}

function showTransientInformationMessage(message: string, durationMs = 4000) {
  void vscode.window.showInformationMessage(message);
  setTimeout(() => {
    // VS Code does not support dismissing a specific information toast, so closeMessages is the closest best-effort fallback.
    void Promise.resolve(vscode.commands.executeCommand("workbench.action.closeMessages")).then(undefined, () => undefined);
  }, durationMs);
}

function logThrottledMonitorWarning(
  lastLogAt: Map<string, number>,
  key: string,
  message: string,
  error: Error,
) {
  const now = Date.now();
  const previous = lastLogAt.get(key) ?? 0;
  if (now - previous < MONITOR_ERROR_LOG_COOLDOWN_MS) {
    return;
  }

  evictOldestIfNeeded(lastLogAt, MAX_MONITOR_ERROR_LOG_BUCKETS);
  lastLogAt.set(key, now);
  console.warn(message, error.message);
}

function evictOldestIfNeeded<T>(map: Map<string, T>, maxItems: number) {
  while (map.size >= maxItems) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) {
      return;
    }

    map.delete(oldest);
  }
}

function readNotificationSettings(): OpenCodeNotificationSettings {
  const config = vscode.workspace.getConfiguration("opencodeEdit.notifications");
  return {
    enabled: config.get<boolean>("enabled", true),
    backgroundOnly: config.get<boolean>("backgroundOnly", true),
    onIdle: config.get<boolean>("onIdle", true),
    onPermission: config.get<boolean>("onPermission", true),
    onError: config.get<boolean>("onError", true),
  };
}

function disposeOpenCodeSessionEventMonitor(
  restoreId: string,
  monitors: Map<string, OpenCodeSessionEventMonitor>,
) {
  monitors.get(restoreId)?.dispose();
  monitors.delete(restoreId);
}

function disposeAllOpenCodeSessionEventMonitors(monitors: Map<string, OpenCodeSessionEventMonitor>) {
  for (const monitor of monitors.values()) {
    monitor.dispose();
  }
  monitors.clear();
}

function disposeAllQueuedOpenCodeTitleReconciliations(timeouts: Map<string, NodeJS.Timeout>) {
  for (const timeout of timeouts.values()) {
    clearTimeout(timeout);
  }
  timeouts.clear();
}

function tryConvertWslPathToWindows(wslPath: string): string | undefined {
  const match = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const driveLetter = match[1].toUpperCase();
  const rest = match[2].replace(/\//g, "\\");
  return `${driveLetter}:\\${rest}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path));
    return true;
  } catch {
    const windowsPath = tryConvertWslPathToWindows(path);
    if (windowsPath) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(windowsPath));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function upsertString(existing: string[], value: string) {
  return [...existing.filter((item) => item !== value), value];
}

function deleteOpenCodePortRestoreId(portMap: Map<number, string>, restoreId: string) {
  for (const [port, candidateRestoreId] of portMap) {
    if (candidateRestoreId === restoreId) {
      portMap.delete(port);
    }
  }
}



function readTrackedOpenCodeTerminalState(
  notifier: OpenCodeBackgroundNotifier,
  restoreId: string,
  viewedTerminalStates: Map<string, Exclude<OpenCodeTerminalLabelState, "running" | "normal">>,
): OpenCodeTerminalLabelState {
  const state = toTerminalLabelState(notifier.readSourceState({ restoreId }));
  if (state === "running" || state === "normal") {
    viewedTerminalStates.delete(restoreId);
    return state;
  }

  return viewedTerminalStates.get(restoreId) === state
    ? "normal"
    : state;
}

function toTerminalLabelState(state: OpenCodeSourceState): OpenCodeTerminalLabelState {
  return state;
}

function toSessionPanelStatus(state: OpenCodeSourceState): OpenCodeSessionTabStatus {
  switch (state) {
    case "running":
    case "idle":
    case "permission":
    case "error":
      return state;
    default:
      return "normal";
  }
}







function createCommandDeps() {
  return {
    getActiveDocument: async (): Promise<DocumentSnapshot | undefined> => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        return undefined;
      }

      const support = getActiveDocumentProbeSupport(document);
      if (!support.supported) {
        void vscode.window.showWarningMessage(support.reason);
        return undefined;
      }

      return snapshotDocument(document);
    },
    createScratchDocument: async (): Promise<DocumentSnapshot> => {
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: "",
      });
      await vscode.window.showTextDocument(document, { preview: false });
      return snapshotDocument(document);
    },
    applyProposal: async (proposal: NormalizedProposal) => {
      const spec = toWorkspaceEditSpec(proposal);
      const edit = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.parse(spec.target.uri);
      const wasDirtyBeforeApply = await readDirtyState(uri);

      if (spec.target.kind === "scratch") {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
      }

      for (const operation of spec.operations) {
        if (operation.kind === "insert" && operation.position) {
          edit.insert(
            uri,
            new vscode.Position(operation.position.line, operation.position.character),
            operation.newText,
            operation.metadata,
          );
          continue;
        }

        const document = await vscode.workspace.openTextDocument(uri);
        const lastLine = Math.max(document.lineCount - 1, 0);
        const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
        edit.replace(
          uri,
          new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
          operation.newText,
          operation.metadata,
        );
      }

      const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
      if (!applied) {
        return {
          applied: false,
          saved: false,
          wasDirtyBeforeApply,
        };
      }

      const saved = await saveAfterApplyWithState(uri, spec.target.kind, wasDirtyBeforeApply);
      return {
        applied: true,
        saved,
        wasDirtyBeforeApply,
      };
    },
    showInformationMessage: (message: string) => {
      if (process.env.OPENCODE_EDIT_SUPPRESS_NOTIFICATIONS === "1") {
        return;
      }
      void vscode.window.showInformationMessage(message);
    },
    showWarningMessage: (message: string) => {
      void vscode.window.showWarningMessage(message);
    },
    showErrorMessage: (message: string) => {
      void vscode.window.showErrorMessage(message);
    },
  };
}

function createQueueCommandDeps(
  reviewQueueStore: ReviewQueueStore,
  reviewPanelProvider: ReviewPanelProvider,
) {
  return {
    getActiveDocument: async (): Promise<DocumentSnapshot | undefined> => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        return undefined;
      }

      const support = getActiveDocumentProbeSupport(document);
      if (!support.supported) {
        void vscode.window.showWarningMessage(support.reason);
        return undefined;
      }

      return snapshotDocument(document);
    },
    createScratchDocument: async (): Promise<DocumentSnapshot> => {
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: "",
      });
      await vscode.window.showTextDocument(document, { preview: false });
      return snapshotDocument(document);
    },
    applyProposal: async (proposal: NormalizedProposal) => {
      return applyProposalImmediately(proposal);
    },
    queueProposal: async (
      proposal: NormalizedProposal,
      originalText: string,
      result: { applied: boolean; saved: boolean; wasDirtyBeforeApply: boolean },
    ) => {
      const currentText = await readCurrentTextRequired(proposal.target.uri);
      reviewQueueStore.upsert({
        targetUri: proposal.target.uri,
        displayPath: toDisplayPath(proposal.target.uri),
        changeKind: "update",
        originalText,
        currentText,
        currentExists: true,
        languageId: await readLanguageId(proposal.target.uri),
        targetKind: proposal.target.kind,
        saved: result.saved,
        wasDirtyBeforeApply: result.wasDirtyBeforeApply,
      });
      reviewPanelProvider.render();
    },
    revealReviewPanel: () => {
      reviewPanelProvider.reveal();
      void vscode.commands.executeCommand("workbench.view.extension.opencodeEdit");
    },
    showInformationMessage: (message: string) => {
      void vscode.window.showInformationMessage(message);
    },
    showWarningMessage: (message: string) => {
      void vscode.window.showWarningMessage(message);
    },
    showErrorMessage: (message: string) => {
      void vscode.window.showErrorMessage(message);
    },
  };
}

function snapshotDocument(document: vscode.TextDocument): DocumentSnapshot {
  return {
    uri: document.uri.toString(),
    fileName: document.fileName,
    languageId: document.languageId,
    text: document.getText(),
  };
}

function getActiveDocumentProbeSupport(document: vscode.TextDocument) {
  const allowedScheme = document.uri.scheme === "file" || document.uri.scheme === "untitled";
  if (!allowedScheme) {
    return {
      supported: false as const,
      reason: `OpenCode TUI Integration Probe only targets file and untitled documents. Falling back from ${document.uri.scheme}: to a scratch document.`,
    };
  }

  const writable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);
  if (writable === false) {
    return {
      supported: false as const,
      reason: `OpenCode TUI Integration Probe cannot edit ${document.uri.scheme}: documents because the file system is read-only. Falling back to a scratch document.`,
    };
  }

  return getExistingDocumentProbeSupport(snapshotDocument(document));
}

async function saveAfterApply(uri: vscode.Uri, targetKind: NormalizedProposal["target"]["kind"]) {
  return saveAfterApplyWithState(uri, targetKind, false);
}

async function saveAfterApplyWithState(
  uri: vscode.Uri,
  targetKind: NormalizedProposal["target"]["kind"],
  wasDirtyBeforeApply: boolean,
) {
  if (!shouldSaveAfterApply({ targetKind, wasDirtyBeforeApply, scheme: uri.scheme })) {
    return false;
  }

  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return document.isDirty ? document.save() : true;
  } catch {
    return false;
  }
}

async function applyProposalImmediately(proposal: NormalizedProposal) {
  const spec = toWorkspaceEditSpec(proposal);
  const edit = new vscode.WorkspaceEdit();
  const uri = vscode.Uri.parse(spec.target.uri);
  const wasDirtyBeforeApply = await readDirtyState(uri);

  if (spec.target.kind === "scratch") {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  for (const operation of spec.operations) {
    if (operation.kind === "insert" && operation.position) {
      edit.insert(uri, new vscode.Position(operation.position.line, operation.position.character), operation.newText);
      continue;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const lastLine = Math.max(document.lineCount - 1, 0);
    const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
    edit.replace(
      uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
      operation.newText,
    );
  }

  const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
  if (!applied) {
    return {
      applied: false,
      saved: false,
      wasDirtyBeforeApply,
    };
  }

  const saved = await saveAfterApplyWithState(uri, spec.target.kind, wasDirtyBeforeApply);
  return {
    applied: true,
    saved,
    wasDirtyBeforeApply,
  };
}

async function readDirtyState(uri: vscode.Uri) {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    return document.isDirty;
  } catch {
    return false;
  }
}

async function readCurrentTextRequired(targetUri: string) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetUri));
  return document.getText();
}

async function readTargetState(targetUri: string) {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetUri));
    return {
      exists: true,
      text: document.getText(),
    };
  } catch {
    return {
      exists: false,
      text: "",
    };
  }
}

function readPendingReviewFileState(uri: vscode.Uri, reviewQueueStore: ReviewQueueStore) {
  const item = reviewQueueStore.get(uri.toString());
  if (!item) {
    return undefined;
  }

  return {
    exists: item.currentExists,
    text: item.currentText,
  };
}

async function readLanguageId(targetUri: string) {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetUri));
    return document.languageId;
  } catch {
    return "plaintext";
  }
}

function toDisplayPath(targetUri: string) {
  const uri = vscode.Uri.parse(targetUri);
  if (uri.scheme === "file") {
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return toDisplayPathForFile(uri.fsPath, workspaceRoots);
  }

  return uri.path.replace(/^\//, "");
}

function loadPersistedReviewQueueItems(context: vscode.ExtensionContext): ReviewQueueItem[] {
  const value = context.workspaceState.get<ReviewQueueItem[]>(REVIEW_QUEUE_STATE_KEY);
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => ({
    ...item,
    changeKind: item.changeKind ?? "update",
    currentExists: item.currentExists ?? true,
    sourceSessionIds: readSourceSessionIds(item.sourceSessionIds),
    stats: isValidReviewQueueItemStats(item.stats) ? item.stats : calculateStats({
      changeKind: item.changeKind ?? "update",
      originalText: item.originalText,
      currentText: item.currentText,
      currentExists: item.currentExists ?? true,
    }),
  }));
}

function readPersistedApplyPatchFailureRecords(context: vscode.ExtensionContext): ApplyPatchFailureRecord[] {
  return readApplyPatchFailureRecords(context.workspaceState.get<ApplyPatchFailureRecord[]>(APPLY_PATCH_FAILURE_RECORDS_KEY));
}

function readReviewSessionMetadataFromWorkspaceState(_workspaceState: vscode.Memento): ReviewSessionMetadata {
  // Persistence-based restore state removed; return empty metadata
  // Session titles are now sourced from the runtime restoreInfosByRestoreId map
  return {
    sessionTitlesById: {},
    sessionCanonicalIdsById: {},
  };
}

async function readReviewSessionMetadata(
  workspaceState: vscode.Memento,
  reviewQueueStore: ReviewQueueStore,
  sessionRepository: OpenCodeSessionRepository,
): Promise<ReviewSessionMetadata> {
  const baseMetadata = readReviewSessionMetadataFromWorkspaceState(workspaceState);
  const queueSessionIds = reviewQueueStore
    .list()
    .flatMap((item) => item.sourceSessionIds)
    .filter((sessionId, index, allSessionIds) => isValidSessionId(sessionId) && allSessionIds.indexOf(sessionId) === index);

  if (queueSessionIds.length === 0) {
    return baseMetadata;
  }

  const sessions = await readReviewSessionsForMetadata(queueSessionIds, sessionRepository);
  return mergeReviewSessionMetadata(baseMetadata, sessions);
}

async function readReviewSessionsForMetadata(
  sessionIds: readonly string[],
  sessionRepository: OpenCodeSessionRepository,
) {
  const sessionsById = new Map<string, OpenCodeSessionSummary>();
  const pendingSessionIds = [...new Set(sessionIds.filter((sessionId) => isValidSessionId(sessionId)))];

  while (pendingSessionIds.length > 0) {
    const sessionId = pendingSessionIds.shift();
    if (!sessionId || sessionsById.has(sessionId)) {
      continue;
    }

    let session: OpenCodeSessionSummary | undefined;
    try {
      session = await sessionRepository.findSessionByIdAsync(sessionId);
    } catch {
      continue;
    }

    if (!session) {
      continue;
    }

    sessionsById.set(session.id, session);
    if (session.parentId && !sessionsById.has(session.parentId)) {
      pendingSessionIds.push(session.parentId);
    }
  }

  return [...sessionsById.values()];
}

function readSourceSessionIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const validSessionIds = value.filter((sessionId): sessionId is string => typeof sessionId === "string" && /^ses[A-Za-z0-9_]+$/.test(sessionId) && sessionId.length <= 128);
  return [...new Set(validSessionIds)];
}

function isValidReviewQueueItemStats(stats: ReviewQueueItem["stats"] | undefined) {
  return !!stats
    && Number.isInteger(stats.additions)
    && stats.additions >= 0
    && Number.isInteger(stats.deletions)
    && stats.deletions >= 0;
}

async function queuePreparedOperation(
  prepared: PreparedOperation,
  reviewQueueStore: ReviewQueueStore,
  reviewPanelProvider: ReviewPanelProvider,
) {
  const dirtyStateByTargetUri = new Map<string, boolean>();
  for (const change of prepared.changes) {
    dirtyStateByTargetUri.set((change.moveUri ?? change.uri).toString(), await readDirtyState(change.uri));
  }

  const applied = await vscode.workspace.applyEdit(prepared.edit, { isRefactoring: false });
  if (!applied) {
    return {
      ok: false as const,
      error: "VS Code failed to apply the requested edit.",
    };
  }

  for (const change of prepared.changes) {
    const targetUri = (change.moveUri ?? change.uri).toString();
    const wasDirtyBeforeApply = dirtyStateByTargetUri.get(targetUri) ?? false;
    const saveUri = change.kind === "delete" ? undefined : change.moveUri ?? change.uri;
    const saved = saveUri ? await saveAfterApplyWithState(saveUri, "existing", wasDirtyBeforeApply) : false;
    const targetState = await readTargetState(targetUri);
    reviewQueueStore.upsert({
      targetUri,
      displayPath: change.relativePath,
      changeKind: change.kind,
      originalText: change.oldText,
      currentText: targetState.text,
      currentExists: targetState.exists,
      sourceUri: change.kind === "move" ? change.uri.toString() : undefined,
      sourceSessionId: prepared.sourceSessionId,
      languageId: await readLanguageId(targetUri),
      targetKind: "existing",
      saved,
      wasDirtyBeforeApply,
    });
  }

  reviewPanelProvider.render();

  return {
    ok: true as const,
    result: {
      output: prepared.output,
      metadata: prepared.metadata,
    },
  };
}
