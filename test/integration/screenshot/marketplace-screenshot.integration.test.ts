import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import { getTestExtensionId } from "../test-extension";

type ReviewQueueState = {
  items: Array<{ id: string; displayPath: string; changeKind: string }>;
};

type ReviewPanelButtonStyles = {
  toolbarKeep: { backgroundColor: string } | null;
  toolbarUndo: { backgroundColor: string } | null;
  itemKeep: { backgroundColor: string } | null;
  itemUndo: { backgroundColor: string } | null;
};

type SessionPanelState = {
  selectedRestoreId?: string;
  order: string[];
  tabsByRestoreId: Record<string, {
    restoreId: string;
    title: string;
    sessionId?: string;
    cwd?: string;
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

suite("Marketplace Screenshot", () => {
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
    await restoreWorkbenchScreenshotSettings();
    await vscode.commands.executeCommand("opencodeEdit.debug.clearReviewQueue");
    await closeAllReviewDiffTabs();
    for (const terminal of vscode.window.terminals) {
      if (terminal.name === "opencode" || terminal.name.startsWith("opencode:") || terminal.name === "new session" || terminal.name === "Queue diff fixes" || terminal.name === "Summarize pending edits" || terminal.name === "Refactor review queue") {
        terminal.dispose();
      }
    }
  });

  test("captures the review queue workflow screenshot", async function () {
    this.timeout(90000);

    const screenshotPath = process.env.OPENCODE_EDIT_SCREENSHOT_OUT;
    assert.ok(screenshotPath, "expected OPENCODE_EDIT_SCREENSHOT_OUT to be set");
    assert.ok(process.env.DISPLAY, "expected DISPLAY to be set for screenshot capture");
    mkdirSync(path.dirname(screenshotPath), { recursive: true });

    await applyWorkbenchScreenshotSettings();
    await restoreFixtures();
    await queueScreenshotChanges();

    const queueState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as ReviewQueueState;
    assert.equal(queueState.items.length, 3);
    assert.deepEqual(
      Object.fromEntries(queueState.items.map((item) => [item.displayPath, item.changeKind])),
      {
        "screenshot-added-file.ts": "add",
        "screenshot-delete-target.ts": "delete",
        "screenshot-service.ts": "update",
      },
    );

    const modifiedItemId = queueState.items.find(
      (item) => item.displayPath === "screenshot-service.ts" && item.changeKind === "update",
    )?.id;
    assert.ok(modifiedItemId, "expected modified screenshot item");

    const document = await vscode.workspace.openTextDocument(modifiedUri);
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });

    await createScreenshotSessions();
    await showTerminalNamed("Queue diff fixes");
    await waitFor(() => vscode.window.activeTerminal?.name === "Queue diff fixes", "expected Queue diff fixes terminal to be active");

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", modifiedItemId);
    await waitFor(() => hasReviewDiffTab(createBeforeUri(modifiedItemId)), "expected review diff tab to open");

    await vscode.commands.executeCommand("opencodeEdit.debug.revealReviewPanel");
    await vscode.commands.executeCommand("opencodeEdit.debug.revealSessionsPanel");
    await runOptionalCommand("workbench.action.toggleAuxiliaryBar");
    await runOptionalCommand("notifications.clearAll");
    await runOptionalCommand("notifications.hideToasts");
    await runOptionalCommand("workbench.action.closeMessages");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.increasePanelSize");
    await runOptionalCommand("workbench.action.focusFirstEditorGroup");
    await runOptionalCommand("workbench.action.terminal.focus");
    await restoreScreenshotCaptureState(modifiedItemId);
    await waitForReviewPanelButtonStyles();

    const buttonStyles = await getReviewPanelButtonStyles();
    assert.equal(buttonStyles.toolbarKeep?.backgroundColor, "rgb(14, 99, 156)");
    assert.equal(buttonStyles.itemKeep?.backgroundColor, "rgb(14, 99, 156)");

    const capture = spawnSync("import", ["-window", "root", screenshotPath], {
      env: process.env,
      encoding: "utf8",
    });

    assert.equal(capture.status, 0, capture.stderr || capture.stdout || "screenshot capture failed");
  });

  async function applyWorkbenchScreenshotSettings() {
    if (!originalSettings) {
      originalSettings = [
        takeSettingSnapshot("workbench", "colorTheme"),
        takeSettingSnapshot("workbench", "iconTheme"),
        takeSettingSnapshot("window", "commandCenter"),
        takeSettingSnapshot("chat", "commandCenter.enabled", true),
        takeSettingSnapshot("workbench.sideBar", "location"),
        takeSettingSnapshot("workbench.editor", "showTabs"),
      ];
    }

    await updateConfiguration("workbench", "colorTheme", "Default Dark Modern");
    await updateConfiguration("workbench", "iconTheme", null);
    await updateConfiguration("window", "commandCenter", false);
    await updateConfiguration("chat", "commandCenter.enabled", false, true);
    await updateConfiguration("workbench.sideBar", "location", "left");
    await updateConfiguration("workbench.editor", "showTabs", true);
  }

  async function restoreWorkbenchScreenshotSettings() {
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

    try {
      await plugin.tool.edit.execute(
        {
          filePath: "screenshot-service.ts",
          oldString: ORIGINAL_MODIFIED_CONTENT,
          newString: UPDATED_MODIFIED_CONTENT,
        },
        createToolContext(workspaceUri.fsPath),
      );

      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Delete File: screenshot-delete-target.ts",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspaceUri.fsPath),
      );

      await plugin.tool.write.execute(
        {
          filePath: "screenshot-added-file.ts",
          content: ADDED_FILE_CONTENT,
        },
        createToolContext(workspaceUri.fsPath),
      );
    } finally {
      plugin.dispose();
    }
  }

  async function createScreenshotSessions() {
    await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspaceUri.fsPath,
      sessionLabel: "Queue diff fixes",
    });
    await waitFor(() => hasTerminalNamed("Queue diff fixes"), "expected Queue diff fixes terminal to open");

    await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspaceUri.fsPath,
      sessionLabel: "Summarize pending edits",
    });
    await waitFor(() => hasTerminalNamed("Summarize pending edits"), "expected Summarize pending edits terminal to open");

    await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspaceUri.fsPath,
      sessionLabel: "Refactor review queue",
    });
    await waitFor(() => hasTerminalNamed("Refactor review queue"), "expected Refactor review queue terminal to open");

    const sessionState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    const [currentRestoreId, unreadRestoreId, readyRestoreId] = sessionState.order;
    assert.ok(currentRestoreId, "expected current screenshot session");
    assert.ok(unreadRestoreId, "expected unread screenshot session");
    assert.ok(readyRestoreId, "expected ready screenshot session");

    const nextState: SessionPanelState = {
      ...sessionState,
      selectedRestoreId: currentRestoreId,
      tabsByRestoreId: {
        ...sessionState.tabsByRestoreId,
        [currentRestoreId]: {
          ...sessionState.tabsByRestoreId[currentRestoreId],
          sessionId: "ses_current",
          status: "running",
          unread: false,
          hidden: false,
        },
        [unreadRestoreId]: {
          ...sessionState.tabsByRestoreId[unreadRestoreId],
          sessionId: "ses_unread",
          cwd: path.join(workspaceUri.fsPath, "packages", "docs"),
          status: "permission",
          unread: true,
          hidden: false,
        },
        [readyRestoreId]: {
          ...sessionState.tabsByRestoreId[readyRestoreId],
          sessionId: "ses_ready",
          cwd: path.join(workspaceUri.fsPath, "src", "review"),
          status: "normal",
          unread: false,
          hidden: false,
        },
      },
    };

    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionPanelState", nextState);
    const verifiedState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    assert.equal(verifiedState.order.length, 3);
    assert.equal(verifiedState.tabsByRestoreId[unreadRestoreId]?.unread, true);
  }

  async function restoreScreenshotCaptureState(modifiedItemId: string) {
    await showTerminalNamed("Queue diff fixes");
    await waitFor(() => vscode.window.activeTerminal?.name === "Queue diff fixes", "expected Queue diff fixes terminal to be active before capture");
    await waitFor(() => hasReviewDiffTab(createBeforeUri(modifiedItemId)), "expected review diff tab before capture");

    const sessionState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    const queueRestoreId = getRestoreIdByTitle(sessionState, "Queue diff fixes");
    const summarizeRestoreId = getRestoreIdByTitle(sessionState, "Summarize pending edits");
    const refactorRestoreId = getRestoreIdByTitle(sessionState, "Refactor review queue");
    assert.ok(queueRestoreId, "expected Queue diff fixes capture session");
    assert.ok(summarizeRestoreId, "expected Summarize pending edits capture session");
    assert.ok(refactorRestoreId, "expected Refactor review queue capture session");

    const nextState: SessionPanelState = {
      ...sessionState,
      selectedRestoreId: queueRestoreId,
      tabsByRestoreId: {
        ...sessionState.tabsByRestoreId,
        [queueRestoreId]: {
          ...sessionState.tabsByRestoreId[queueRestoreId],
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
        [refactorRestoreId]: {
          ...sessionState.tabsByRestoreId[refactorRestoreId],
          status: "normal",
          unread: false,
          hidden: false,
        },
      },
    };

    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionPanelState", nextState);
    const verifiedState = await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState") as SessionPanelState;
    assert.equal(verifiedState.selectedRestoreId, queueRestoreId);
    assert.equal(verifiedState.tabsByRestoreId[queueRestoreId]?.status, "running");
    assert.equal(verifiedState.tabsByRestoreId[summarizeRestoreId]?.status, "permission");
    assert.equal(verifiedState.tabsByRestoreId[refactorRestoreId]?.status, "normal");
  }

  function getRestoreIdByTitle(state: SessionPanelState, title: string) {
    return Object.entries(state.tabsByRestoreId).find(([, tab]) => tab.title === title)?.[0];
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
    edit.replace(
      uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
      content,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
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

  function createToolContext(directory: string, worktree = directory) {
    return {
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

  function hasOpenCodeTerminal() {
    return vscode.window.terminals.some((terminal) => {
      return terminal.name === "opencode"
        || terminal.name === "new session"
        || terminal.name.startsWith("opencode:");
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

  async function closeAllReviewDiffTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "opencode-review-before";
    });

    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
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
    const deadline = Date.now() + 8000;

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

  async function waitForReviewPanelButtonStyles() {
    await waitFor(async () => {
      const buttonStyles = await getReviewPanelButtonStyles();
      return buttonStyles.toolbarKeep?.backgroundColor === "rgb(14, 99, 156)"
        && buttonStyles.itemKeep?.backgroundColor === "rgb(14, 99, 156)";
    }, "expected review panel button styles to render");
  }

  async function getReviewPanelButtonStyles() {
    return await vscode.commands.executeCommand(
      "opencodeEdit.debug.getReviewPanelButtonStyles",
    ) as ReviewPanelButtonStyles;
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
});

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
