import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getTestExtensionId } from "../test-extension";
import { buildRecordingSteps, readRecordingCoordinates, RECORDING_VIEWPORT } from "./recording-plan";
import { PREOPENED_RECORDING_SESSIONS, QUICK_PICK_RECORDING_SESSION } from "./recording-sandbox";
import { buildRecordingTrimFilter, buildRecordingTrimSegments, type RecordedStepTiming } from "./recording-trim";
import { formatSessionUpdatedLabel } from "../../../src/opencode/session-display";

const execFileAsync = promisify(execFile);

const RECORDING_CAPTURE_FPS = 24;
const RECORDING_GIF_FPS = 15;
const RECORDING_GIF_SPEED = 1.3;
const RECORDING_MOUSE_MOVE_DURATION_MS = 500;
const RECORDING_MOUSE_MOVE_STEP_INTERVAL_MS = 25;
const RECORDING_TRIMMED_WAIT_DURATION_MS = 10000;
const RECORDING_TRIMMED_WAIT_UI_SETTLE_MS = 1000;
const RECORDING_PRE_CAPTURE_SCREENSHOT = "/tmp/opencode-recording-precapture.png";
const RECORDING_FIRST_FRAME_SCREENSHOT = "/tmp/opencode-recording-first-frame.png";
const SESSION_TITLE_BEFORE_SCREENSHOT = "/tmp/opencode-session-title-before.png";
const SESSION_TITLE_AFTER_SCREENSHOT = "/tmp/opencode-session-title-after.png";
const SESSION_TITLE_TYPED_SCREENSHOT = "/tmp/opencode-session-title-typed.png";
const SESSION_TITLE_DIFF_REGIONS = [
  { x1: 407, y1: 70, x2: 850, y2: 86 },
  { x1: 676, y1: 99, x2: 850, y2: 124 },
] as const;

type ReviewQueueState = {
  items: Array<{ id: string; displayPath: string; changeKind: string; sourceSessionIds: string[] }>;
};

type SessionPanelState = {
  selectedRestoreId?: string;
  order: string[];
  tabsByRestoreId: Record<string, {
    restoreId: string;
    title: string;
    sessionId?: string;
    cwd?: string;
    updated?: number | string;
    status: "normal" | "running" | "idle" | "permission" | "error";
    hidden: boolean;
    unread: boolean;
  }>;
};

type SettingSnapshot = {
  section: string;
  key: string;
  value: unknown;
  optional?: boolean;
};

suite("Real OpenCode Recording", () => {
  suiteSetup(function () {
    this.timeout(60000);
  });

  let workspaceUri: vscode.Uri;
  let modifiedUri: vscode.Uri;
  let deletedUri: vscode.Uri;
  let addedUri: vscode.Uri;
  let originalSettings: SettingSnapshot[] | undefined;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(getTestExtensionId());
    if (extension) {
      await extension.activate();
    }

    workspaceUri = getWorkspaceUri();
    modifiedUri = vscode.Uri.joinPath(workspaceUri, "screenshot-service.ts");
    deletedUri = vscode.Uri.joinPath(workspaceUri, "screenshot-delete-target.ts");
    addedUri = vscode.Uri.joinPath(workspaceUri, "screenshot-added-file.ts");
  });

  teardown(async () => {
    await restoreFixtures();
    await restoreWorkbenchRecordingSettings();
    await vscode.commands.executeCommand("opencodeEdit.debug.clearReviewQueue");
    await closeAllReviewDiffTabs();
    await runOptionalCommand("workbench.action.closeQuickOpen");
    for (const terminal of vscode.window.terminals) {
      if (terminal.name === "new session"
        || PREOPENED_RECORDING_SESSIONS.some((fixture) => terminal.name === fixture.title)
        || terminal.name === QUICK_PICK_RECORDING_SESSION.title) {
        terminal.dispose();
      }
    }
  });

  test("records quick pick, session switching, and review diff switching", async function () {
    this.timeout(180000);

    const mp4Path = process.env.OPENCODE_EDIT_RECORDING_MP4_OUT;
    const gifPath = process.env.OPENCODE_EDIT_RECORDING_GIF_OUT;
    const untrimmedMp4Path = process.env.OPENCODE_EDIT_RECORDING_UNTRIMMED_MP4_OUT;
    assert.ok(mp4Path, "expected OPENCODE_EDIT_RECORDING_MP4_OUT to be set");
    assert.ok(gifPath, "expected OPENCODE_EDIT_RECORDING_GIF_OUT to be set");
    assert.ok(process.env.DISPLAY, "expected DISPLAY to be set for recording");
    mkdirSync(path.dirname(mp4Path), { recursive: true });
    mkdirSync(path.dirname(gifPath), { recursive: true });
    if (untrimmedMp4Path) {
      mkdirSync(path.dirname(untrimmedMp4Path), { recursive: true });
    }

    await applyWorkbenchRecordingSettings();
    await restoreFixtures();
    await queueScreenshotChanges();

    const queueState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as ReviewQueueState;
    assert.equal(queueState.items.length, 3);

    const modifiedItemId = queueState.items.find((item) => item.displayPath === "screenshot-service.ts" && item.changeKind === "update")?.id;
    const deletedItemId = queueState.items.find((item) => item.displayPath === "screenshot-delete-target.ts" && item.changeKind === "delete")?.id;
    const addedItemId = queueState.items.find((item) => item.displayPath === "screenshot-added-file.ts" && item.changeKind === "add")?.id;
    assert.ok(modifiedItemId, "expected modified screenshot item");
    assert.ok(deletedItemId, "expected deleted screenshot item");
    assert.ok(addedItemId, "expected added screenshot item");
    assert.deepEqual(
      queueState.items.map((item) => item.sourceSessionIds),
      [
        [PREOPENED_RECORDING_SESSIONS[0].sessionId],
        [PREOPENED_RECORDING_SESSIONS[0].sessionId],
        [PREOPENED_RECORDING_SESSIONS[0].sessionId],
      ],
    );

    const document = await vscode.workspace.openTextDocument(modifiedUri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });

    await createRecordingSessions();
    await showTerminalNamed(PREOPENED_RECORDING_SESSIONS[0].title);
    await waitFor(
      () => vscode.window.activeTerminal?.name === PREOPENED_RECORDING_SESSIONS[0]?.title,
      `expected ${PREOPENED_RECORDING_SESSIONS[0]?.title} terminal to be active`,
    );
    await closeAllReviewDiffTabs();
    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", modifiedItemId);
    await waitFor(() => hasReviewDiffTab(createBeforeUri(modifiedItemId)), "expected modified review diff tab to open");

    await vscode.commands.executeCommand("opencodeEdit.debug.revealReviewPanel");
    await vscode.commands.executeCommand("opencodeEdit.debug.revealSessionsPanel");
    await runOptionalCommand("workbench.action.toggleAuxiliaryBar");
    await runOptionalCommand("notifications.clearAll");
    await runOptionalCommand("notifications.hideToasts");
    await runOptionalCommand("workbench.action.closeMessages");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.focusFirstEditorGroup");
    await restoreRecordingCaptureState(modifiedItemId);
    await ensureRecordingCaptureReady(modifiedItemId);
    await wait(5000);

    const recorder = await startRecording(mp4Path);
    const recordingStartedAt = Date.now();
    let stepTimings: RecordedStepTiming[] = [];
    try {
      const coordinates = readRecordingCoordinates();
      const steps = buildRecordingSteps(coordinates);
      await wait(900);
      for (const step of steps) {
        const startedAtMs = Date.now() - recordingStartedAt;
        if (step.type === "click") {
          await click(step.point.x, step.point.y);
        } else if (step.type === "text") {
          await typeText(step.text);
        } else {
          await key(step.key);
        }
        const actionCompletedAtMs = Date.now() - recordingStartedAt;
        const waitStartedAtMs = step.afterMs === RECORDING_TRIMMED_WAIT_DURATION_MS
          ? await waitForRecordedWaitStart(step.label, recordingStartedAt)
          : actionCompletedAtMs;
        await wait(step.afterMs);
        const waitCompletedAtMs = Date.now() - recordingStartedAt;
        stepTimings.push({
          startedAtMs,
          actionCompletedAtMs,
          waitStartedAtMs,
          waitCompletedAtMs,
          afterMs: step.afterMs,
          trimTrailingPause: step.afterMs === RECORDING_TRIMMED_WAIT_DURATION_MS,
        });
      }
    } finally {
      await stopRecording(recorder);
    }

    if (untrimmedMp4Path) {
      await copyFile(mp4Path, untrimmedMp4Path);
    }

    await trimRecordingMp4(mp4Path, stepTimings, Date.now() - recordingStartedAt);

    await convertMp4ToGif(mp4Path, gifPath);
    await assertGifFirstFrameLooksReady(gifPath);
    assert.equal(existsSync(mp4Path), true, `expected ${mp4Path} to exist`);
    assert.equal(existsSync(gifPath), true, `expected ${gifPath} to exist`);
    if (untrimmedMp4Path) {
      assert.equal(existsSync(untrimmedMp4Path), true, `expected ${untrimmedMp4Path} to exist`);
    }
  });

  test("updates visible session title after TUI /sessions activation", async function () {
    this.timeout(180000);

    await applyWorkbenchRecordingSettings();
    await restoreFixtures();
    const document = await vscode.workspace.openTextDocument(modifiedUri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand("opencodeEdit.debug.revealSessionsPanel");
    await runOptionalCommand("workbench.action.toggleAuxiliaryBar");
    await runOptionalCommand("notifications.clearAll");
    await runOptionalCommand("notifications.hideToasts");
    await runOptionalCommand("workbench.action.closeMessages");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.focusFirstEditorGroup");

    const coordinates = readRecordingCoordinates();
    await click(coordinates.openSession.x, coordinates.openSession.y);
    await wait(900);
    await click(coordinates.quickPickSession.x, coordinates.quickPickSession.y);
    await waitFor(
      () => vscode.window.activeTerminal?.name === "new session",
      "expected new session terminal to become active from the Quick Pick",
    );
    await wait(10000);
    await click(coordinates.tuiClick.x, coordinates.tuiClick.y);
    await wait(500);

    await captureRootWindow(SESSION_TITLE_BEFORE_SCREENSHOT);
    await typeText("/sessions");
    await key("Tab");
    await key("Return");
    await wait(1000);
    await captureRootWindow(SESSION_TITLE_TYPED_SCREENSHOT);

    await waitFor(async () => {
      const state = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
      return Object.values(state.tabsByRestoreId).some((candidate) => {
        return candidate.title !== "new session"
          && candidate.sessionId !== undefined
          && vscode.window.activeTerminal?.name === candidate.title;
      });
    }, "expected TUI /sessions to update VS Code session title away from new session");
    await wait(500);
    await captureRootWindow(SESSION_TITLE_AFTER_SCREENSHOT);

    assert.equal(
      await imageAnyRegionChanged(SESSION_TITLE_BEFORE_SCREENSHOT, SESSION_TITLE_AFTER_SCREENSHOT, SESSION_TITLE_DIFF_REGIONS),
      true,
      "expected pixels in a visible session title region to change after TUI session activation",
    );
  });

  async function applyWorkbenchRecordingSettings() {
    if (!originalSettings) {
      originalSettings = [
        takeSettingSnapshot("workbench", "colorTheme"),
        takeSettingSnapshot("workbench", "iconTheme"),
        takeSettingSnapshot("window", "commandCenter"),
        takeSettingSnapshot("chat", "commandCenter.enabled", true),
        takeSettingSnapshot("workbench.sideBar", "location"),
        takeSettingSnapshot("workbench.editor", "showTabs"),
        takeSettingSnapshot("window", "menuBarVisibility"),
      ];
    }

    await updateConfiguration("workbench", "colorTheme", "Default Dark Modern");
    await updateConfiguration("workbench", "iconTheme", null);
    await updateConfiguration("window", "commandCenter", false);
    await updateConfiguration("chat", "commandCenter.enabled", false, true);
    await updateConfiguration("workbench.sideBar", "location", "left");
    await updateConfiguration("workbench.editor", "showTabs", true);
    await updateConfiguration("window", "menuBarVisibility", "hidden");
  }

  async function restoreWorkbenchRecordingSettings() {
    if (!originalSettings) {
      return;
    }

    for (const setting of originalSettings) {
      await updateConfiguration(setting.section, setting.key, setting.value, setting.optional);
    }

    originalSettings = undefined;
  }

  async function updateConfiguration(section: string, key: string, value: unknown, optional = false) {
    try {
      await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
      if (!optional) {
        throw error;
      }
    }
  }

  function takeSettingSnapshot(section: string, key: string, optional = false): SettingSnapshot {
    return {
      section,
      key,
      value: vscode.workspace.getConfiguration(section).get(key),
      optional,
    };
  }

  async function queueScreenshotChanges() {
    const plugin = await loadBridgePlugin();
    const sourceSessionId = PREOPENED_RECORDING_SESSIONS[0].sessionId;
    try {
      await plugin.tool.edit.execute(
        { filePath: "screenshot-service.ts", oldString: ORIGINAL_MODIFIED_CONTENT, newString: UPDATED_MODIFIED_CONTENT },
        createToolContext(workspaceUri.fsPath, workspaceUri.fsPath, sourceSessionId),
      );
      await plugin.tool.apply_patch.execute(
        { patchText: ["*** Begin Patch", "*** Delete File: screenshot-delete-target.ts", "*** End Patch"].join("\n") },
        createToolContext(workspaceUri.fsPath, workspaceUri.fsPath, sourceSessionId),
      );
      await plugin.tool.write.execute(
        { filePath: "screenshot-added-file.ts", content: ADDED_FILE_CONTENT },
        createToolContext(workspaceUri.fsPath, workspaceUri.fsPath, sourceSessionId),
      );
    } finally {
      plugin.dispose();
    }
  }

  async function createRecordingSessions() {
    const startupFixtures = [
      PREOPENED_RECORDING_SESSIONS[1],
      PREOPENED_RECORDING_SESSIONS[2],
      PREOPENED_RECORDING_SESSIONS[0],
    ].filter((fixture): fixture is NonNullable<typeof fixture> => Boolean(fixture));

    for (const fixture of startupFixtures) {
      await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
        cwd: workspaceUri.fsPath,
        sessionId: fixture.sessionId,
        sessionLabel: fixture.title,
      });
      await waitFor(() => hasTerminalNamed(fixture.title), `expected ${fixture.title} terminal to open`);
      await waitFor(() => hasSessionTitle(fixture.title), `expected ${fixture.title} session row`);
    }

    const sessionState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    assert.equal(sessionState.order.length, PREOPENED_RECORDING_SESSIONS.length);

    const currentRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[0]?.title);
    const runningRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[1]?.title);
    const unreadRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[2]?.title);
    assert.ok(currentRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[0]?.title} recording session`);
    assert.ok(runningRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[1]?.title} recording session`);
    assert.ok(unreadRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[2]?.title} recording session`);

    const nextState: SessionPanelState = {
      ...sessionState,
      order: [currentRestoreId, runningRestoreId, unreadRestoreId],
      selectedRestoreId: currentRestoreId,
      tabsByRestoreId: {
        ...sessionState.tabsByRestoreId,
        [currentRestoreId]: {
          ...sessionState.tabsByRestoreId[currentRestoreId],
          sessionId: "ses_current",
          updated: Date.now() - PREOPENED_RECORDING_SESSIONS[0].updatedOffsetMs,
          status: "normal",
          unread: false,
          hidden: false,
        },
        [runningRestoreId]: {
          ...sessionState.tabsByRestoreId[runningRestoreId],
          sessionId: "ses_running",
          updated: Date.now() - PREOPENED_RECORDING_SESSIONS[1].updatedOffsetMs,
          status: "running",
          unread: false,
          hidden: false,
        },
        [unreadRestoreId]: {
          ...sessionState.tabsByRestoreId[unreadRestoreId],
          sessionId: "ses_unread",
          cwd: path.join(workspaceUri.fsPath, "packages", "docs"),
          updated: Date.now() - PREOPENED_RECORDING_SESSIONS[2].updatedOffsetMs,
          status: "permission",
          unread: true,
          hidden: false,
        },
      },
    };

    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionPanelState", nextState);
    const verifiedState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    assert.equal(verifiedState.tabsByRestoreId[currentRestoreId]?.status, "normal");
    assert.equal(verifiedState.tabsByRestoreId[runningRestoreId]?.status, "running");
    assert.equal(verifiedState.tabsByRestoreId[unreadRestoreId]?.status, "permission");
    assert.equal(verifiedState.tabsByRestoreId[unreadRestoreId]?.unread, true);
    assert.ok(verifiedState.tabsByRestoreId[currentRestoreId]?.updated !== undefined);
    assert.ok(verifiedState.tabsByRestoreId[runningRestoreId]?.updated !== undefined);
    assert.ok(verifiedState.tabsByRestoreId[unreadRestoreId]?.updated !== undefined);
    assert.ok(formatSessionUpdatedLabel(verifiedState.tabsByRestoreId[currentRestoreId]?.updated));
    assert.ok(formatSessionUpdatedLabel(verifiedState.tabsByRestoreId[runningRestoreId]?.updated));
    assert.ok(formatSessionUpdatedLabel(verifiedState.tabsByRestoreId[unreadRestoreId]?.updated));
  }

  async function restoreRecordingCaptureState(modifiedItemId: string) {
    await showTerminalNamed(PREOPENED_RECORDING_SESSIONS[0].title);
    await runOptionalCommand("workbench.action.focusFirstEditorGroup");
    await runOptionalCommand("workbench.action.terminal.focus");
    await runOptionalCommand("workbench.action.focusRightGroup");
    await waitFor(
      () => vscode.window.activeTerminal?.name === PREOPENED_RECORDING_SESSIONS[0]?.title,
      `expected ${PREOPENED_RECORDING_SESSIONS[0]?.title} terminal to be active before capture`,
    );
    await waitFor(() => hasReviewDiffTab(createBeforeUri(modifiedItemId)), "expected modified review diff tab before capture");

    const sessionState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    const queueRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[0]?.title);
    const backgroundRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[1]?.title);
    const summarizeRestoreId = getRestoreIdByTitle(sessionState, PREOPENED_RECORDING_SESSIONS[2]?.title);
    assert.ok(queueRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[0]?.title} capture session`);
    assert.ok(backgroundRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[1]?.title} capture session`);
    assert.ok(summarizeRestoreId, `expected ${PREOPENED_RECORDING_SESSIONS[2]?.title} capture session`);

    const nextState: SessionPanelState = {
      ...sessionState,
      order: [queueRestoreId, backgroundRestoreId, summarizeRestoreId],
      selectedRestoreId: queueRestoreId,
      tabsByRestoreId: {
        ...sessionState.tabsByRestoreId,
        [queueRestoreId]: {
          ...sessionState.tabsByRestoreId[queueRestoreId],
          status: "normal",
          unread: false,
          hidden: false,
        },
        [backgroundRestoreId]: {
          ...sessionState.tabsByRestoreId[backgroundRestoreId],
          status: "running",
          unread: false,
          hidden: false,
        },
        [summarizeRestoreId]: {
          ...sessionState.tabsByRestoreId[summarizeRestoreId],
          status: "permission",
          unread: true,
          hidden: false,
        },
      },
    };

    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionPanelState", nextState);
    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionNotificationStates", [
      { restoreId: queueRestoreId, state: "normal", sessionId: "ses_current" },
      { restoreId: backgroundRestoreId, state: "running", sessionId: "ses_running" },
      { restoreId: summarizeRestoreId, state: "permission", sessionId: "ses_unread" },
    ]);
    const verifiedState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    assert.equal(verifiedState.selectedRestoreId, queueRestoreId);
    assert.equal(verifiedState.tabsByRestoreId[queueRestoreId]?.status, "normal");
    assert.equal(verifiedState.tabsByRestoreId[backgroundRestoreId]?.status, "running");
    assert.equal(verifiedState.tabsByRestoreId[summarizeRestoreId]?.status, "permission");
  }

  async function ensureRecordingCaptureReady(modifiedItemId: string) {
    await waitFor(async () => {
      await restoreRecordingCaptureState(modifiedItemId);
      await captureRootWindow(RECORDING_PRE_CAPTURE_SCREENSHOT);
      return await imageMatchesRecordingExpectations(RECORDING_PRE_CAPTURE_SCREENSHOT);
    }, "expected recording capture frame to show terminal content and status indicators");
  }

  async function loadBridgePlugin() {
    const launchSpec = (await vscode.commands.executeCommand("opencodeEdit.debug.getBridgeLaunchSpec")) as {
      configContent: string;
      environment: Record<string, string>;
    };

    const parsedConfig = JSON.parse(launchSpec.configContent) as { plugin?: string[] };
    const pluginUri = parsedConfig.plugin?.[0];
    assert.ok(pluginUri, "expected bridge plugin URI in launch config");

    const previousBridgeUrl = process.env.OPENCODE_VSCODE_BRIDGE_URL;
    const previousBridgeToken = process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
    process.env.OPENCODE_VSCODE_BRIDGE_URL = launchSpec.environment.OPENCODE_VSCODE_BRIDGE_URL;
    process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = launchSpec.environment.OPENCODE_VSCODE_BRIDGE_TOKEN;

    const { default: bridgePlugin } = await import(pluginUri);
    const plugin = await bridgePlugin();

    return {
      tool: plugin.tool,
      dispose() {
        if (previousBridgeUrl === undefined) {
          delete process.env.OPENCODE_VSCODE_BRIDGE_URL;
        } else {
          process.env.OPENCODE_VSCODE_BRIDGE_URL = previousBridgeUrl;
        }
        if (previousBridgeToken === undefined) {
          delete process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
        } else {
          process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = previousBridgeToken;
        }
      },
    };
  }

  function createToolContext(directory: string, worktree = directory, sessionID?: string) {
    return {
      ...(sessionID ? { sessionID } : {}),
      directory,
      worktree,
      abort: new AbortController().signal,
    };
  }

  function createBeforeUri(itemId: string) {
    return vscode.Uri.from({
      scheme: "opencode-review-before",
      path: `/${Buffer.from(itemId, "utf8").toString("base64url")}`,
    });
  }

  function hasReviewDiffTab(beforeUri: vscode.Uri) {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === beforeUri.toString();
    });
  }

  function hasTerminalNamed(name: string) {
    return vscode.window.terminals.some((terminal) => terminal.name === name);
  }

  async function showTerminalNamed(name: string) {
    const terminal = vscode.window.terminals.find((candidate) => candidate.name === name);
    assert.ok(terminal, `expected terminal named ${name}`);
    terminal.show(false);
    await wait(100);
  }

  async function waitForRecordedWaitStart(stepLabel: string, recordingStartedAt: number) {
    switch (stepLabel) {
      case "Open Quick Pick session": {
        await waitFor(async () => {
          const state = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
          const restoreId = getRestoreIdByTitle(state, QUICK_PICK_RECORDING_SESSION.title);
          return restoreId !== undefined
            && state.selectedRestoreId === restoreId
            && vscode.window.activeTerminal?.name === QUICK_PICK_RECORDING_SESSION.title;
        }, `expected ${QUICK_PICK_RECORDING_SESSION.title} session to become active after quick pick open`);
        break;
      }
      case "Open Quick Pick new session": {
        await waitFor(
          () => vscode.window.activeTerminal?.name === "new session",
          "expected new session terminal to become active",
        );
        break;
      }
      case "Switch to refactor session row": {
        await waitFor(async () => {
          const state = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
          const restoreId = getRestoreIdByTitle(state, QUICK_PICK_RECORDING_SESSION.title);
          return vscode.window.activeTerminal?.name === QUICK_PICK_RECORDING_SESSION.title
            || (restoreId !== undefined && state.selectedRestoreId === restoreId);
        }, `expected ${QUICK_PICK_RECORDING_SESSION.title} session to become selected`);
        break;
      }
      case "Close refactor session row": {
        await waitFor(async () => {
          const hasTitle = await hasSessionTitle(QUICK_PICK_RECORDING_SESSION.title);
          return !hasTitle && !hasTerminalNamed(QUICK_PICK_RECORDING_SESSION.title);
        }, `expected ${QUICK_PICK_RECORDING_SESSION.title} session to close`);
        break;
      }
      default:
        break;
    }

    return Date.now() - recordingStartedAt + RECORDING_TRIMMED_WAIT_UI_SETTLE_MS;
  }

  async function hasSessionTitle(title: string) {
    const state = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    return Object.values(state.tabsByRestoreId).some((tab) => tab.title === title);
  }

  function getRestoreIdByTitle(state: SessionPanelState, title: string | undefined) {
    if (!title) {
      return undefined;
    }

    return Object.entries(state.tabsByRestoreId).find(([, tab]) => tab.title === title)?.[0];
  }

  async function closeAllReviewDiffTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "opencode-review-before";
    });

    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  }

  async function restoreFixtures() {
    await restoreFile(modifiedUri, ORIGINAL_MODIFIED_CONTENT);
    await restoreFile(deletedUri, DELETED_FILE_CONTENT);
    if (await fileExists(addedUri)) {
      await vscode.workspace.fs.delete(addedUri);
    }
  }

  async function restoreFile(uri: vscode.Uri, content: string) {
    if (!(await fileExists(uri))) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const lastLine = Math.max(document.lineCount - 1, 0);
    const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)), content);
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  async function fileExists(uri: vscode.Uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(condition: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await wait(50);
    }
    assert.fail(message);
  }

  function wait(durationMs: number) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  function getWorkspaceUri() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected fixture workspace folder to be available");
    return folder.uri;
  }

  async function runOptionalCommand(command: string) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {}
  }

  async function captureRootWindow(filePath: string) {
    await execFileAsync("import", ["-window", "root", filePath], {
      env: process.env,
    });
  }

  async function imageMatchesRecordingExpectations(filePath: string) {
    const { stdout } = await execFileAsync("python3", ["-c", PYTHON_IMAGE_ASSERT_SCRIPT, filePath]);
    const result = JSON.parse(stdout) as {
      hasNonGrayTerminalPixels: boolean;
      queueIndicator: [number, number, number];
      backgroundIndicator: [number, number, number];
      summarizeIndicator: [number, number, number];
      queueIndicatorIsGreen: boolean;
      backgroundIndicatorIsGreen: boolean;
      summarizeIndicatorIsOrange: boolean;
    };
    return result.hasNonGrayTerminalPixels
      && !result.queueIndicatorIsGreen
      && result.backgroundIndicatorIsGreen
      && result.summarizeIndicatorIsOrange;
  }

  async function imageRegionChanged(
    beforePath: string,
    afterPath: string,
    region: { x1: number; y1: number; x2: number; y2: number },
  ) {
    const { stdout } = await execFileAsync("python3", ["-c", PYTHON_IMAGE_REGION_CHANGED_SCRIPT, beforePath, afterPath, JSON.stringify(region)]);
    return JSON.parse(stdout).changed === true;
  }

  async function imageAnyRegionChanged(
    beforePath: string,
    afterPath: string,
    regions: readonly { x1: number; y1: number; x2: number; y2: number }[],
  ) {
    for (const region of regions) {
      if (await imageRegionChanged(beforePath, afterPath, region)) {
        return true;
      }
    }

    return false;
  }

  async function assertGifFirstFrameLooksReady(gifPath: string) {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      gifPath,
      "-vf",
      "select=eq(n\\,0)",
      "-vsync",
      "0",
      RECORDING_FIRST_FRAME_SCREENSHOT,
    ]);

    const ok = await imageMatchesRecordingExpectations(RECORDING_FIRST_FRAME_SCREENSHOT);
    assert.equal(ok, true, "expected GIF first frame to show terminal content and status indicators");
  }
});

async function click(x: number, y: number) {
  const current = await readMouseLocation();
  if (current.x === x && current.y === y) {
    await execFileAsync("xdotool", ["click", "1"]);
    return;
  }
  await execFileAsync("bash", ["-lc", buildAnimatedClickCommand(current.x, current.y, x, y)]);
}

async function readMouseLocation() {
  const { stdout } = await execFileAsync("xdotool", ["getmouselocation", "--shell"]);
  const x = Number.parseInt(stdout.match(/X=(\d+)/)?.[1] ?? "0", 10);
  const y = Number.parseInt(stdout.match(/Y=(\d+)/)?.[1] ?? "0", 10);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function buildAnimatedClickCommand(startX: number, startY: number, endX: number, endY: number) {
  const steps = Math.max(12, Math.ceil(RECORDING_MOUSE_MOVE_DURATION_MS / RECORDING_MOUSE_MOVE_STEP_INTERVAL_MS));
  const moveDurationMs = RECORDING_MOUSE_MOVE_DURATION_MS;
  const sleepSeconds = (moveDurationMs / steps / 1000).toFixed(6);
  const commands: string[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const nextX = Math.round(startX + (endX - startX) * progress);
    const nextY = Math.round(startY + (endY - startY) * progress);
    commands.push(`xdotool mousemove --sync ${nextX} ${nextY}`);
    commands.push(`sleep ${sleepSeconds}`);
  }
  commands.push("xdotool click 1");
  return commands.join(" && ");
}

async function key(name: string) {
  await execFileAsync("xdotool", ["key", name]);
}

async function typeText(value: string) {
  await execFileAsync("xdotool", ["type", "--delay", "35", value]);
}

async function startRecording(mp4Path: string) {
  const display = process.env.DISPLAY;
  assert.ok(display, "expected DISPLAY for ffmpeg recording");
  const processHandle = spawn("ffmpeg", [
    "-y",
    "-video_size",
    `${RECORDING_VIEWPORT.width}x${RECORDING_VIEWPORT.height}`,
    "-framerate",
    String(RECORDING_CAPTURE_FPS),
    "-f",
    "x11grab",
    "-i",
    display,
    "-pix_fmt",
    "yuv420p",
    mp4Path,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return processHandle;
}

async function stopRecording(processHandle: ReturnType<typeof spawn>) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    processHandle.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    processHandle.once("exit", (code) => {
      if (!settled) {
        settled = true;
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited with code ${code ?? -1}`));
      }
    });
    processHandle.stdin?.write("q");
    processHandle.stdin?.end();
  });
}

async function convertMp4ToGif(mp4Path: string, gifPath: string) {
  const palettePath = `${gifPath}.palette.png`;
  const speedFilter = `setpts=${(1 / RECORDING_GIF_SPEED).toFixed(6)}*PTS`;
  await execFileAsync("ffmpeg", ["-y", "-i", mp4Path, "-vf", `${speedFilter},fps=${RECORDING_GIF_FPS},scale=1280:-1:flags=lanczos,palettegen`, palettePath]);
  await execFileAsync("ffmpeg", ["-y", "-i", mp4Path, "-i", palettePath, "-lavfi", `${speedFilter},fps=${RECORDING_GIF_FPS},scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse`, gifPath]);
  try {
    await execFileAsync("rm", ["-f", palettePath]);
  } catch {}
}

async function trimRecordingMp4(mp4Path: string, stepTimings: RecordedStepTiming[], totalDurationMs: number) {
  const segments = buildRecordingTrimSegments(stepTimings, totalDurationMs);
  const filter = buildRecordingTrimFilter(segments);
  const trimmedPath = `${mp4Path}.trimmed.mp4`;
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    mp4Path,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-an",
    "-pix_fmt",
    "yuv420p",
    trimmedPath,
  ]);
  await execFileAsync("mv", [trimmedPath, mp4Path]);
}

const PYTHON_IMAGE_ASSERT_SCRIPT = String.raw`from PIL import Image
import json
import sys

img = Image.open(sys.argv[1]).convert("RGB")

def is_green(pixel):
    r, g, b = pixel
    return g >= 140 and g >= r + 20 and g >= b + 20

def is_orange(pixel):
    r, g, b = pixel
    return r >= 140 and g >= 80 and b <= 125 and r >= g

background_indicator = img.getpixel((850, 749))
summarize_indicator = img.getpixel((850, 770))
queue_indicator = img.getpixel((850, 725))
has_non_gray = False
for y in range(170, 580):
    for x in range(860, 1230):
        pixel = img.getpixel((x, y))
        if max(pixel) - min(pixel) >= 3:
            has_non_gray = True
            break
    if has_non_gray:
        break

print(json.dumps({
    "hasNonGrayTerminalPixels": has_non_gray,
    "queueIndicator": queue_indicator,
    "backgroundIndicator": background_indicator,
    "summarizeIndicator": summarize_indicator,
    "queueIndicatorIsGreen": is_green(queue_indicator),
    "backgroundIndicatorIsGreen": is_green(background_indicator),
    "summarizeIndicatorIsOrange": is_orange(summarize_indicator),
}))`;

const PYTHON_IMAGE_REGION_CHANGED_SCRIPT = String.raw`from PIL import Image
import json
import sys

before = Image.open(sys.argv[1]).convert("RGB")
after = Image.open(sys.argv[2]).convert("RGB")
region = json.loads(sys.argv[3])
changed = False
changed_count = 0
for y in range(region["y1"], region["y2"] + 1):
    for x in range(region["x1"], region["x2"] + 1):
        if before.getpixel((x, y)) != after.getpixel((x, y)):
            changed = True
            changed_count += 1

print(json.dumps({
    "changed": changed,
    "changedCount": changed_count,
}))`;

const ORIGINAL_MODIFIED_CONTENT = `import { workspace, window } from "vscode";

type ReviewSummary = {
  total: number;
  pending: number;
  saved: number;
};

export async function loadReviewSummary(): Promise<ReviewSummary> {
  const documents = await workspace.findFiles("src/**/*.ts", "**/node_modules/**", 200);
  const pending = documents.filter((document) => document.path.includes("review")).length;

  return {
    total: documents.length,
    pending,
    saved: documents.length - pending,
  };
}

export async function showReviewSummary() {
  const summary = await loadReviewSummary();
  void window.showInformationMessage(
    \`Review queue: \${summary.pending} pending files out of \${summary.total}\`,
  );
}
`;

const UPDATED_MODIFIED_CONTENT = `import { workspace, window } from "vscode";

type ReviewSummary = {
  total: number;
  pending: number;
  saved: number;
  added: number;
  deleted: number;
};

function sortByPath(input: Array<{ path: string }>) {
  return [...input].sort((left, right) => left.path.localeCompare(right.path));
}

export async function loadReviewSummary(): Promise<ReviewSummary> {
  const documents = sortByPath(await workspace.findFiles("src/**/*.ts", "**/node_modules/**", 200));
  const pending = documents.filter((document) => document.path.includes("review")).length;
  const added = documents.filter((document) => document.path.includes("added")).length;
  const deleted = documents.filter((document) => document.path.includes("deleted")).length;

  return {
    total: documents.length,
    pending,
    saved: documents.length - pending,
    added,
    deleted,
  };
}

export async function showReviewSummary() {
  const summary = await loadReviewSummary();
  void window.showInformationMessage(
    \`Review queue: \${summary.pending} pending, \${summary.added} added, \${summary.deleted} deleted, \${summary.saved} saved\`,
  );
}

export function formatReviewLabel(summary: ReviewSummary) {
  return [
    \`pending:\${summary.pending}\`,
    \`added:\${summary.added}\`,
    \`deleted:\${summary.deleted}\`,
    \`saved:\${summary.saved}\`,
  ].join(" | ");
}
`;

const DELETED_FILE_CONTENT = `export const deprecatedReviewFlow = {
  id: "legacy-review-flow",
  enabled: false,
  reason: "Replaced by the OpenCode review queue panel.",
};
`;

const ADDED_FILE_CONTENT = `export type ReviewQueueCard = {
  title: string;
  description: string;
  status: "added" | "modified" | "deleted";
};

export const reviewQueueCards: ReviewQueueCard[] = [
  {
    title: "Queue added file",
    description: "Shows how a brand new file appears in the Pending Changes panel.",
    status: "added",
  },
  {
    title: "Queue deleted file",
    description: "Demonstrates delete recovery through Undo in the review queue.",
    status: "deleted",
  },
];
`;
