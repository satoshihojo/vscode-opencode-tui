import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { getTestExtensionId } from "../test-extension";

suite("OpenCode Bridge Run", () => {
  suiteSetup(function () {
    this.timeout(30000);
  });

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const editFixturePath = path.join(workspacePath, "bridge-target.ts");
  const editFixtureUri = vscode.Uri.file(editFixturePath);
  const patchFixturePath = path.join(workspacePath, "bridge-patch-target.ts");
  const patchFixtureUri = vscode.Uri.file(patchFixturePath);
  const createdFixturePath = path.join(workspacePath, "bridge-created.ts");
  const createdFixtureUri = vscode.Uri.file(createdFixturePath);
  const deletedFixturePath = path.join(workspacePath, "bridge-delete-target.ts");
  const deletedFixtureUri = vscode.Uri.file(deletedFixturePath);
  const moveSourcePath = path.join(workspacePath, "bridge-move-source.ts");
  const moveSourceUri = vscode.Uri.file(moveSourcePath);
  const moveTargetPath = path.join(workspacePath, "bridge-move-target.ts");
  const moveTargetUri = vscode.Uri.file(moveTargetPath);
  const externalPatchPath = path.join(path.dirname(workspacePath), "outside-bridge-patch-target.ts");
  const externalPatchUri = vscode.Uri.file(externalPatchPath);
  const externalSessionPath = path.join(path.dirname(workspacePath), "outside-session-root");
  const externalRelativePatchPath = path.join(externalSessionPath, "relative-bridge-patch-target.ts");
  const externalRelativePatchUri = vscode.Uri.file(externalRelativePatchPath);
  const externalAllowedDir = path.join(path.dirname(workspacePath), "allowed-external-dir");
  const externalSymlinkPath = path.join(externalAllowedDir, "symlink-escape-target.ts");
  const externalSymlinkEscapePath = path.join(path.dirname(workspacePath), "symlink-escape-target.ts");
  const externalSymlinkEscapeUri = vscode.Uri.file(externalSymlinkEscapePath);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(getTestExtensionId());
    if (extension) {
      await extension.activate();
    }
  });

  teardown(async () => {
    await restoreFixture();
    await vscode.commands.executeCommand("opencodeEdit.debug.setForceGracefulRestoreReuse", undefined);
    await vscode.commands.executeCommand("opencodeEdit.debug.clearReviewQueue");
    await vscode.commands.executeCommand("opencodeEdit.debug.clearApplyPatchFailureRecords");
    await closeAllReviewDiffTabs();
  });

  test("reports a launch command using an OpenCode port separate from the live bridge port", async () => {
    const launchSpec = (await vscode.commands.executeCommand("opencodeEdit.debug.getBridgeLaunchSpec")) as {
      command: string;
      configContent: string;
      environment: Record<string, string>;
    };

    const bridgeUrl = launchSpec.environment.OPENCODE_VSCODE_BRIDGE_URL;
    assert.ok(bridgeUrl, "expected bridge url in launch environment");
      const tuiConfigPath = launchSpec.environment.OPENCODE_TUI_CONFIG;
      assert.ok(tuiConfigPath, "expected TUI config in launch environment");

      const bridgePort = new URL(bridgeUrl).port;
      const commandMatch = /^(?:opencode|opencode\.cmd) --port (\d+)$/.exec(launchSpec.command);
      assert.ok(commandMatch, `unexpected launch command: ${launchSpec.command}`);
      assert.notEqual(commandMatch[1], bridgePort);
      assert.equal(launchSpec.environment._EXTENSION_OPENCODE_PORT, commandMatch[1]);
      assert.match(launchSpec.configContent, /vscode-bridge-plugin\.mjs/);
      const sessionConfig = JSON.parse(launchSpec.configContent) as {
        plugin: string[];
      };
      assert.doesNotMatch(sessionConfig.plugin.join("\n"), /vscode-tui-session-plugin\.mjs/);
      assert.match(tuiConfigPath, /vscode-tui-config\.json/);
      const tuiConfig = JSON.parse(await vscode.workspace.fs.readFile(vscode.Uri.file(tuiConfigPath)).then((bytes) => Buffer.from(bytes).toString("utf8"))) as { plugin?: string[] };
      assert.ok(tuiConfig.plugin?.some((plugin) => /vscode-tui-session-plugin\.mjs/.test(plugin)), "expected TUI session plugin in TUI config");
  });

  test("updates the tracked session when the TUI reports an active session route", async function () {
    this.timeout(30000);

    const beforeState = (await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspacePath,
      sessionLabel: "TUI Route Original",
    })) as { order: string[] };
    const restoreId = beforeState.order.at(-1);
    assert.ok(restoreId, "expected a tracked session restore id");
    const portsByRestoreId = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    const openCodePort = portsByRestoreId[restoreId];
    assert.ok(openCodePort, "expected a tracked OpenCode port for the started session");
    await registerFakeOpenCodeSession({
      id: "ses_tui_route",
      title: "Repository Title",
      directory: workspacePath,
      timeUpdated: 1,
    });

    await vscode.commands.executeCommand("opencodeEdit.debug.notifyTuiActiveSession", {
      type: "tui.session.active",
      sessionID: "ses_tui_route",
      openCodePort,
      title: "TUI Route Replacement",
      updated: 12345,
      activationTimestamp: Date.now(),
    });

    const afterState = (await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState")) as {
      tabsByRestoreId: Record<string, { sessionId?: string; title?: string; updated?: number | string }>;
    };
    assert.equal(afterState.tabsByRestoreId[restoreId]?.sessionId, "ses_tui_route");
    assert.equal(afterState.tabsByRestoreId[restoreId]?.title, "TUI Route Replacement");
    assert.equal(afterState.tabsByRestoreId[restoreId]?.updated, 12345);
  });

  test("clears the previous running state when the TUI switches to a new session", async function () {
    this.timeout(30000);

    const beforeState = (await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspacePath,
      sessionLabel: "TUI Fork Original",
    })) as { order: string[] };
    const restoreId = beforeState.order.at(-1);
    assert.ok(restoreId, "expected a tracked session restore id");
    const portsByRestoreId = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    const openCodePort = portsByRestoreId[restoreId];
    assert.ok(openCodePort, "expected a tracked OpenCode port for the started session");

    await vscode.commands.executeCommand("opencodeEdit.debug.setSessionNotificationStates", [
      { restoreId, state: "running", sessionId: "ses_tui_original" },
    ]);

    await registerFakeOpenCodeSession({
      id: "ses_tui_forked",
      title: "Forked Idle Session",
      directory: workspacePath,
      timeUpdated: 2,
    });
    const afterState = (await vscode.commands.executeCommand("opencodeEdit.debug.notifyTuiActiveSession", {
      type: "tui.session.active",
      sessionID: "ses_tui_forked",
      openCodePort,
      title: "Forked Idle Session",
      updated: 2,
      activationTimestamp: Date.now(),
    })) as {
      tabsByRestoreId: Record<string, { sessionId?: string; title?: string; status?: string }>;
    };

    assert.equal(afterState.tabsByRestoreId[restoreId]?.sessionId, "ses_tui_forked");
    assert.equal(afterState.tabsByRestoreId[restoreId]?.title, "Forked Idle Session");
    assert.equal(afterState.tabsByRestoreId[restoreId]?.status, "normal");
  });

  test("routes a bridge plugin edit even when agent context points outside the VS Code workspace", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: `${path.dirname(externalPatchPath)}/**`, action: "allow" },
    ]);

    try {
      await plugin.tool.edit.execute(
        {
          filePath: "bridge-target.ts",
          oldString: 'export const bridgeMessage = "before bridge";\n',
          newString: 'export const bridgeMessage = "after bridge from mismatched context";\n',
        },
        createToolContext("/tmp", "/"),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-target.ts");

    const document = await vscode.workspace.openTextDocument(editFixtureUri);
    assert.match(document.getText(), /after bridge from mismatched context/);
  });

  test("routes a bridge plugin write for a new file when agent context points outside the VS Code workspace", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: `${path.dirname(externalPatchPath)}/**`, action: "allow" },
    ]);

    try {
      await plugin.tool.write.execute(
        {
          filePath: "bridge-created-from-mismatched-context.ts",
          content: 'export const mismatchedContextWrite = true;\n',
        },
        createToolContext("/tmp", "/"),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-created-from-mismatched-context.ts");

    const createdUri = vscode.Uri.file(path.join(workspacePath, "bridge-created-from-mismatched-context.ts"));
    const document = await vscode.workspace.openTextDocument(createdUri);
    assert.match(document.getText(), /mismatchedContextWrite = true/);
  });

  test("routes a real bridge plugin edit into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.edit.execute(
        {
          filePath: "bridge-target.ts",
          oldString: 'export const bridgeMessage = "before bridge";\n',
          newString: 'export const bridgeMessage = "after bridge";\n',
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string; revision: number }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-target.ts");

    const document = await vscode.workspace.openTextDocument(editFixtureUri);
    assert.match(document.getText(), /after bridge/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const reverted = await vscode.workspace.openTextDocument(editFixtureUri);
    assert.match(reverted.getText(), /before bridge/);
  });

  test("rejects workspace edit targets denied by native edit permission", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: editFixturePath, action: "deny" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.edit.execute(
          {
            filePath: "bridge-target.ts",
            oldString: 'export const bridgeMessage = "before bridge";\n',
            newString: 'export const bridgeMessage = "after bridge";\n',
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);
    const document = await vscode.workspace.openTextDocument(editFixtureUri);
    assert.match(document.getText(), /before bridge/);
  });

  test("rejects external edit targets authorized only by read permission", async function () {
    this.timeout(30000);

    await restoreFile(externalPatchUri, "export const outsideValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "read", pattern: externalPatchPath, action: "allow" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.edit.execute(
          {
            filePath: externalPatchPath,
            oldString: "export const outsideValue = 1;",
            newString: "export const outsideValue = 2;",
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);
  });

  test("routes externally authorized edit targets into the review queue", async function () {
    this.timeout(30000);

    await restoreFile(externalPatchUri, "export const outsideValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: externalPatchPath, action: "allow" },
      { permission: "external_directory", pattern: `${path.dirname(externalPatchPath)}/*`, action: "allow" },
    ]);

    try {
      await plugin.tool.edit.execute(
        {
          filePath: externalPatchPath,
          oldString: "export const outsideValue = 1;",
          newString: "export const outsideValue = 2;",
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, externalPatchPath);

    const document = await vscode.workspace.openTextDocument(externalPatchUri);
    assert.match(document.getText(), /outsideValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);
  });

  test("rejects external write targets authorized only by read permission", async function () {
    this.timeout(30000);

    const externalWritePath = path.join(path.dirname(workspacePath), "outside-write-target.ts");
    const externalWriteUri = vscode.Uri.file(externalWritePath);
    await restoreFile(externalWriteUri, "export const outsideWriteValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "read", pattern: externalWritePath, action: "allow" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.write.execute(
          {
            filePath: externalWritePath,
            content: "export const outsideWriteValue = 2;\n",
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);

    const unchangedDocument = await vscode.workspace.openTextDocument(externalWriteUri);
    assert.match(unchangedDocument.getText(), /outsideWriteValue = 1/);
  });

  test("routes externally authorized write targets into the review queue", async function () {
    this.timeout(30000);

    const externalWritePath = path.join(path.dirname(workspacePath), "outside-write-target.ts");
    const externalWriteUri = vscode.Uri.file(externalWritePath);
    await restoreFile(externalWriteUri, "export const outsideWriteValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: externalWritePath, action: "allow" },
      { permission: "external_directory", pattern: `${path.dirname(externalWritePath)}/*`, action: "allow" },
    ]);

    try {
      await plugin.tool.write.execute(
        {
          filePath: externalWritePath,
          content: "export const outsideWriteValue = 2;\n",
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, externalWritePath);

    const document = await vscode.workspace.openTextDocument(externalWriteUri);
    assert.match(document.getText(), /outsideWriteValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);
  });

  test("rejects external write targets without external directory permission", async function () {
    this.timeout(30000);

    const externalWritePath = path.join(path.dirname(workspacePath), "outside-write-target.ts");
    const externalWriteUri = vscode.Uri.file(externalWritePath);
    await restoreFile(externalWriteUri, "export const outsideWriteValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: externalWritePath, action: "allow" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.write.execute(
          {
            filePath: externalWritePath,
            content: "export const outsideWriteValue = 2;\n",
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);

    const unchangedDocument = await vscode.workspace.openTextDocument(externalWriteUri);
    assert.match(unchangedDocument.getText(), /outsideWriteValue = 1/);
  });

  test("rejects workspace write targets denied by native edit permission", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: createdFixturePath, action: "deny" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.write.execute(
          {
            filePath: "bridge-created.ts",
            content: 'export const createdByWrite = "hello bridge";\n',
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);
    assert.equal(await fileExists(createdFixtureUri), false);
  });

  test("routes a real bridge plugin write into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.write.execute(
        {
          filePath: "bridge-created.ts",
          content: 'export const createdByWrite = "hello bridge";\n',
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-created.ts");

    const createdDocument = await vscode.workspace.openTextDocument(createdFixtureUri);
    assert.match(createdDocument.getText(), /hello bridge/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const existsAfterUndo = await fileExists(createdFixtureUri);
    assert.equal(existsAfterUndo, false);
  });

  test("routes a real bridge plugin apply_patch into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const patchValue = 1;",
            "+export const patchValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-patch-target.ts");

    const patchedDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.match(patchedDocument.getText(), /patchValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const reverted = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.match(reverted.getText(), /patchValue = 1/);
  });

  test("routes apply_patch on top of pending review state for the same file", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const patchValue = 1;",
            "+export const patchValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath, workspacePath, "ses_pending_alpha"),
      );

      await restoreFile(patchFixtureUri, "export const patchValue = 1;\n");

      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const patchValue = 2;",
            "+export const patchValue = 3;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath, workspacePath, "ses_pending_beta"),
      );
    } finally {
      plugin.dispose();
    }

    const patchedDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.match(patchedDocument.getText(), /patchValue = 3/);

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ currentText: string; originalText: string; sourceSessionIds: string[] }>;
    };
    assert.equal(state.items.length, 1);
    assert.match(state.items[0]?.originalText ?? "", /patchValue = 1/);
    assert.match(state.items[0]?.currentText ?? "", /patchValue = 3/);
    assert.deepEqual(state.items[0]?.sourceSessionIds, ["ses_pending_alpha", "ses_pending_beta"]);
  });

  test("routes apply_patch without stealing focus from the active editor", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);
    const activeDocument = await vscode.workspace.openTextDocument(editFixtureUri);
    await vscode.window.showTextDocument(activeDocument, { preview: false });
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), editFixtureUri.toString());

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const patchValue = 1;",
            "+export const patchValue = 3;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), editFixtureUri.toString());

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);
  });

  test("restores a session by relaunching OpenCode in the existing terminal tab", async function () {
    this.timeout(30000);

    const beforeState = (await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspacePath,
      sessionLabel: "Restore Reuse Session",
    })) as { order: string[] };
    const restoreId = beforeState.order.at(-1);
    assert.ok(restoreId, "expected a tracked session restore id");
    await registerFakeOpenCodeSession({
      id: "ses_restore_reuse",
      title: "Restore Reuse Session",
      directory: workspacePath,
      timeUpdated: Date.now(),
    });
    const terminal = await waitForTerminalNamed("Restore Reuse Session");
    const terminalCountBeforeRestore = vscode.window.terminals.length;
    const portsBeforeRestore = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    const originalOpenCodePort = portsBeforeRestore[restoreId];
    assert.ok(originalOpenCodePort, "expected original tracked OpenCode port before restore");

    await vscode.commands.executeCommand("opencodeEdit.debug.restoreOpenCodeSession");
    await waitFor(async () => {
      const portsByRestoreId = await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts") as Record<string, number>;
      return typeof portsByRestoreId[restoreId] === "number";
    }, "expected restored session to keep a tracked OpenCode port");

    const portsAfterRestore = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    assert.notEqual(portsAfterRestore[restoreId], originalOpenCodePort);

    assert.equal(vscode.window.terminals.length, terminalCountBeforeRestore);
    assert.equal(vscode.window.terminals.includes(terminal), true);
  });

  test("falls back to a new terminal when restore reuse cannot terminate the existing TUI", async function () {
    this.timeout(30000);

    const beforeState = (await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspacePath,
      sessionLabel: "Restore Fallback Session",
    })) as { order: string[] };
    const restoreId = beforeState.order.at(-1);
    assert.ok(restoreId, "expected a tracked session restore id");
    await registerFakeOpenCodeSession({
      id: "ses_restore_fallback",
      title: "Restore Fallback Session",
      directory: workspacePath,
      timeUpdated: Date.now(),
    });

    const originalTerminal = await waitForTerminalNamed("Restore Fallback Session");
    const terminalCountBeforeRestore = vscode.window.terminals.length;
    const portsBeforeRestore = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    const originalOpenCodePort = portsBeforeRestore[restoreId];
    assert.ok(originalOpenCodePort, "expected original tracked OpenCode port before fallback restore");

    await vscode.commands.executeCommand("opencodeEdit.debug.setForceGracefulRestoreReuse", false);
    await vscode.commands.executeCommand("opencodeEdit.debug.restoreOpenCodeSession");

    await waitFor(async () => {
      const portsByRestoreId = await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts") as Record<string, number>;
      return typeof portsByRestoreId[restoreId] === "number" && portsByRestoreId[restoreId] !== originalOpenCodePort;
    }, "expected fallback restore to replace the tracked OpenCode port");

    await waitFor(() => !vscode.window.terminals.includes(originalTerminal), "expected fallback restore to retire the original terminal");

    const terminalsNamedAfterRestore = vscode.window.terminals.filter((candidate) => candidate.name === "Restore Fallback Session");
    assert.equal(terminalsNamedAfterRestore.length, 1);
    assert.equal(vscode.window.terminals.length, terminalCountBeforeRestore);
  });

  test("falls back safely when restore starts with unsent terminal input still present", async function () {
    this.timeout(30000);

    const beforeState = (await vscode.commands.executeCommand("opencodeEdit.debug.startOpenCodeSession", {
      cwd: workspacePath,
      sessionLabel: "Restore Pending Input Session",
    })) as { order: string[] };
    const restoreId = beforeState.order.at(-1);
    assert.ok(restoreId, "expected a tracked session restore id");
    await registerFakeOpenCodeSession({
      id: "ses_restore_pending_input",
      title: "Restore Pending Input Session",
      directory: workspacePath,
      timeUpdated: Date.now(),
    });

    const originalTerminal = await waitForTerminalNamed("Restore Pending Input Session");
    originalTerminal.show(false);
    await waitFor(() => vscode.window.activeTerminal === originalTerminal, "expected pending-input terminal to become active");
    originalTerminal.sendText("aaaaa", false);
    await wait(150);

    const terminalCountBeforeRestore = vscode.window.terminals.length;
    const portsBeforeRestore = (await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts")) as Record<string, number>;
    const originalOpenCodePort = portsBeforeRestore[restoreId];
    assert.ok(originalOpenCodePort, "expected original tracked OpenCode port before pending-input restore");

    await vscode.commands.executeCommand("opencodeEdit.debug.setForceGracefulRestoreReuse", false);
    await vscode.commands.executeCommand("opencodeEdit.debug.restoreOpenCodeSession");

    await waitFor(async () => {
      const portsByRestoreId = await vscode.commands.executeCommand("opencodeEdit.debug.getTrackedOpenCodePorts") as Record<string, number>;
      return typeof portsByRestoreId[restoreId] === "number" && portsByRestoreId[restoreId] !== originalOpenCodePort;
    }, "expected pending-input restore to replace the tracked OpenCode port");

    await waitFor(() => !vscode.window.terminals.includes(originalTerminal), "expected pending-input restore to retire the original terminal");

    const sessionState = (await vscode.commands.executeCommand("opencodeEdit.debug.getSessionPanelState")) as {
      tabsByRestoreId: Record<string, { title?: string }>;
    };
    assert.equal(sessionState.tabsByRestoreId[restoreId]?.title, "Restore Pending Input Session");
    assert.equal(vscode.window.terminals.length, terminalCountBeforeRestore);
  });


  test("routes out-of-order multi-hunk apply_patch into the review queue", async function () {
    this.timeout(30000);

    await restoreFile(patchFixtureUri, [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const lastValue = 1;",
      "",
    ].join("\n"));
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const lastValue = 1;",
            "+export const lastValue = 2;",
            "@@",
            "-export const firstValue = 1;",
            "+export const firstValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const patchedDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.match(patchedDocument.getText(), /firstValue = 2/);
    assert.match(patchedDocument.getText(), /lastValue = 2/);
  });

  test("routes insertion-only apply_patch hunks after their matched context", async function () {
    this.timeout(30000);

    await restoreFile(patchFixtureUri, [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const lastValue = 1;",
      "",
    ].join("\n"));
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@ export const middleValue = 1;",
            "+export const insertedValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const patchedDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.equal(patchedDocument.getText(), [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const insertedValue = 2;",
      "export const lastValue = 1;",
      "",
    ].join("\n"));
  });

  test("routes apply_patch with repeated same-file update blocks in one request", async function () {
    this.timeout(30000);

    await restoreFile(patchFixtureUri, [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const lastValue = 1;",
      "",
    ].join("\n"));
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const firstValue = 1;",
            "+export const firstValue = 2;",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const lastValue = 1;",
            "+export const lastValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const patchedDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.equal(patchedDocument.getText(), [
      "export const firstValue = 2;",
      "export const middleValue = 1;",
      "export const lastValue = 2;",
      "",
    ].join("\n"));
  });

  test("surfaces hunk-indexed patch failures without hiding details", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: bridge-patch-target.ts",
              "@@",
              "-export const missingValue = 1;",
              "+export const missingValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /Patch hunk 1 failed.*No files were changed/s,
      );
    } finally {
      plugin.dispose();
    }
  });

  test("records structured apply_patch failures for later inspection", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: bridge-patch-target.ts",
              "@@",
              "-export const missingValue = 1;",
              "+export const missingValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /Patch hunk 1 failed.*No files were changed/s,
      );
    } finally {
      plugin.dispose();
    }

    const records = await vscode.commands.executeCommand("opencodeEdit.debug.getApplyPatchFailureRecords") as Array<{
      tool: string;
      errorCode: string;
      message: string;
      sessionId?: string;
      cwd: string;
      worktree: string;
      hunkIndex?: number;
      filePath?: string;
      patchSummary?: {
        hunkCount: number;
        targetPaths: string[];
      };
      timestamp: number;
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.tool, "apply_patch");
    assert.equal(records[0]?.errorCode, "EXPECTED_LINES_NOT_FOUND");
    assert.match(records[0]?.message ?? "", /Patch hunk 1 failed.*No files were changed/s);
    assert.equal(records[0]?.sessionId, "ses_bridge_test");
    assert.equal(records[0]?.cwd, workspacePath);
    assert.equal(records[0]?.worktree, workspacePath);
    assert.equal(records[0]?.hunkIndex, 1);
    assert.equal(records[0]?.filePath, path.join(workspacePath, "bridge-patch-target.ts"));
    assert.equal(records[0]?.patchSummary?.hunkCount, 1);
    assert.deepEqual(records[0]?.patchSummary?.targetPaths, ["bridge-patch-target.ts"]);
    assert.equal(typeof records[0]?.timestamp, "number");
  });

  test("clears persisted apply_patch failure records", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: bridge-patch-target.ts",
              "@@",
              "-export const missingValue = 1;",
              "+export const missingValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /Patch hunk 1 failed.*No files were changed/s,
      );
    } finally {
      plugin.dispose();
    }

    const beforeClear = await vscode.commands.executeCommand("opencodeEdit.debug.getApplyPatchFailureRecords") as unknown[];
    assert.equal(beforeClear.length, 1);

    await vscode.commands.executeCommand("opencodeEdit.debug.clearApplyPatchFailureRecords");

    const afterClear = await vscode.commands.executeCommand("opencodeEdit.debug.getApplyPatchFailureRecords") as unknown[];
    assert.deepEqual(afterClear, []);
  });

  test("records apply_patch failures returned without throwing", async function () {
    this.timeout(30000);

    const originalApplyEdit = vscode.workspace.applyEdit;
    (vscode.workspace.applyEdit as typeof vscode.workspace.applyEdit) = async () => false;
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: bridge-patch-target.ts",
              "@@",
              "-export const patchValue = 1;",
              "+export const patchValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /VS Code failed to apply the requested edit\./,
      );
    } finally {
      plugin.dispose();
      (vscode.workspace.applyEdit as typeof vscode.workspace.applyEdit) = originalApplyEdit;
    }

    const records = await vscode.commands.executeCommand("opencodeEdit.debug.getApplyPatchFailureRecords") as Array<{
      errorCode: string;
      message: string;
      patchSummary?: { hunkCount: number; targetPaths: string[] };
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.errorCode, "VSCODE_APPLY_EDIT_FAILED");
    assert.equal(records[0]?.message, "VS Code failed to apply the requested edit.");
    assert.equal(records[0]?.patchSummary?.hunkCount, 1);
    assert.deepEqual(records[0]?.patchSummary?.targetPaths, ["bridge-patch-target.ts"]);
  });

  test("routes apply_patch absolute paths outside the workspace into the review queue", async function () {
    this.timeout(30000);

    await restoreFile(externalPatchUri, "export const outsideValue = 1;\n");
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: `${path.dirname(externalPatchPath)}/**`, action: "allow" },
      { permission: "external_directory", pattern: `${path.dirname(externalPatchPath)}/*`, action: "allow" },
    ]);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            `*** Update File: ${externalPatchPath}`,
            "@@",
            "-export const outsideValue = 1;",
            "+export const outsideValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string; originalText: string; currentText: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, externalPatchPath);
    assert.match(state.items[0]?.originalText ?? "", /outsideValue = 1/);
    assert.match(state.items[0]?.currentText ?? "", /outsideValue = 2/);

    const patchedDocument = await vscode.workspace.openTextDocument(externalPatchUri);
    assert.match(patchedDocument.getText(), /outsideValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", state.items[0]?.id);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), createCurrentUri(state.items[0]!.id).toString());
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? "", /outsideValue = 2/);
    const beforeDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.scheme === "opencode-review-before");
    assert.ok(beforeDocument, "expected before-side review document to open");
    assert.match(beforeDocument.getText(), /outsideValue = 1/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const revertedDocument = await vscode.workspace.openTextDocument(externalPatchUri);
    assert.match(revertedDocument.getText(), /outsideValue = 1/);
  });

  test("rejects apply_patch absolute paths outside the authorized scope", async function () {
    this.timeout(30000);

    await restoreFile(externalPatchUri, "export const outsideValue = 1;\n");
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              `*** Update File: ${externalPatchPath}`,
              "@@",
              "-export const outsideValue = 1;",
              "+export const outsideValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);

    const unchangedDocument = await vscode.workspace.openTextDocument(externalPatchUri);
    assert.match(unchangedDocument.getText(), /outsideValue = 1/);
  });

  test("rejects apply_patch symlink escapes from an authorized external directory", async function () {
    this.timeout(30000);

    await fs.mkdir(externalAllowedDir, { recursive: true });
    await restoreFile(externalSymlinkEscapeUri, "export const escapeValue = 1;\n");
    await fs.rm(externalSymlinkPath, { force: true });
    await fs.symlink(externalSymlinkEscapePath, externalSymlinkPath);
    const plugin = await loadBridgePluginWithPermissions(workspacePath, [
      { permission: "edit", pattern: `${externalAllowedDir}/**`, action: "allow" },
    ]);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              `*** Update File: ${externalSymlinkPath}`,
              "@@",
              "-export const escapeValue = 1;",
              "+export const escapeValue = 2;",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /permission denied/,
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: unknown[];
    };
    assert.deepEqual(state.items, []);

    const unchangedDocument = await vscode.workspace.openTextDocument(externalSymlinkEscapeUri);
    assert.match(unchangedDocument.getText(), /escapeValue = 1/);
  });

  test("routes apply_patch relative paths in an outside-workspace OpenCode session", async function () {
    this.timeout(30000);

    await restoreFile(externalRelativePatchUri, "export const relativeOutsideValue = 1;\n");
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: relative-bridge-patch-target.ts",
            "@@",
            "-export const relativeOutsideValue = 1;",
            "+export const relativeOutsideValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(externalSessionPath, externalSessionPath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string; originalText: string; currentText: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, externalRelativePatchPath);
    assert.match(state.items[0]?.originalText ?? "", /relativeOutsideValue = 1/);
    assert.match(state.items[0]?.currentText ?? "", /relativeOutsideValue = 2/);

    const patchedDocument = await vscode.workspace.openTextDocument(externalRelativePatchUri);
    assert.match(patchedDocument.getText(), /relativeOutsideValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", state.items[0]?.id);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), createCurrentUri(state.items[0]!.id).toString());
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? "", /relativeOutsideValue = 2/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const revertedDocument = await vscode.workspace.openTextDocument(externalRelativePatchUri);
    assert.match(revertedDocument.getText(), /relativeOutsideValue = 1/);
  });

  test("routes outside-workspace relative apply_patch to the session file when a workspace file has the same name", async function () {
    this.timeout(30000);

    const externalCollisionUri = vscode.Uri.file(path.join(externalSessionPath, "bridge-patch-target.ts"));
    await restoreFile(externalCollisionUri, "export const relativeOutsideValue = 1;\n");
    await restoreFile(patchFixtureUri, "export const workspaceCollisionValue = 1;\n");
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-patch-target.ts",
            "@@",
            "-export const relativeOutsideValue = 1;",
            "+export const relativeOutsideValue = 2;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(externalSessionPath, externalSessionPath),
      );
    } finally {
      plugin.dispose();
    }

    const patchedDocument = await vscode.workspace.openTextDocument(externalCollisionUri);
    assert.match(patchedDocument.getText(), /relativeOutsideValue = 2/);

    const workspaceDocument = await vscode.workspace.openTextDocument(patchFixtureUri);
    assert.match(workspaceDocument.getText(), /workspaceCollisionValue = 1/);
  });

  test("routes outside-workspace relative add patches to the session file when a workspace file has the same name", async function () {
    this.timeout(30000);

    const collisionFileName = "bridge-add-collision-target.ts";
    const externalCollisionUri = vscode.Uri.file(path.join(externalSessionPath, collisionFileName));
    const workspaceCollisionUri = vscode.Uri.file(path.join(workspacePath, collisionFileName));
    if (await fileExists(externalCollisionUri)) {
      await vscode.workspace.fs.delete(externalCollisionUri);
    }
    await restoreFile(workspaceCollisionUri, "export const workspaceCollisionValue = 1;\n");
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            `*** Add File: ${collisionFileName}`,
            "+export const relativeOutsideAdded = true;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(externalSessionPath, externalSessionPath),
      );
    } finally {
      plugin.dispose();
    }

    const addedDocument = await vscode.workspace.openTextDocument(externalCollisionUri);
    assert.match(addedDocument.getText(), /relativeOutsideAdded = true/);

    const workspaceDocument = await vscode.workspace.openTextDocument(workspaceCollisionUri);
    assert.match(workspaceDocument.getText(), /workspaceCollisionValue = 1/);
  });

  test("routes apply_patch add file into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Add File: bridge-added-by-patch.ts",
            "+export const addedByPatch = true;",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-added-by-patch.ts");

    const addedUri = vscode.Uri.file(path.join(workspacePath, "bridge-added-by-patch.ts"));
    const addedDocument = await vscode.workspace.openTextDocument(addedUri);
    assert.match(addedDocument.getText(), /addedByPatch = true/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const existsAfterUndo = await fileExists(addedUri);
    assert.equal(existsAfterUndo, false);
  });

  test("routes apply_patch delete file into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Delete File: bridge-delete-target.ts",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-delete-target.ts");
    assert.equal(await fileExists(deletedFixtureUri), false);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const restoredDocument = await vscode.workspace.openTextDocument(deletedFixtureUri);
    assert.match(restoredDocument.getText(), /deleteMe = true/);
  });

  test("routes apply_patch move file into the review queue", async function () {
    this.timeout(30000);

    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await plugin.tool.apply_patch.execute(
        {
          patchText: [
            "*** Begin Patch",
            "*** Update File: bridge-move-source.ts",
            "*** Move to: bridge-move-target.ts",
            "@@",
            "-export const moveMe = \"source\";",
            "+export const moveMe = \"target\";",
            "*** End Patch",
          ].join("\n"),
        },
        createToolContext(workspacePath),
      );
    } finally {
      plugin.dispose();
    }

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "bridge-move-target.ts");
    assert.equal(await fileExists(moveSourceUri), false);

    const movedDocument = await vscode.workspace.openTextDocument(moveTargetUri);
    assert.match(movedDocument.getText(), /moveMe = "target"/);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", state.items[0]?.id);

    const restoredSource = await vscode.workspace.openTextDocument(moveSourceUri);
    assert.match(restoredSource.getText(), /moveMe = "source"/);
    assert.equal(await fileExists(moveTargetUri), false);
  });

  test("rejects apply_patch move when the target file already exists", async function () {
    this.timeout(30000);

    await restoreFile(moveTargetUri, 'export const moveMe = "already exists";\n');
    const plugin = await loadBridgePlugin(workspacePath);

    try {
      await assert.rejects(
        plugin.tool.apply_patch.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: bridge-move-source.ts",
              "*** Move to: bridge-move-target.ts",
              "@@",
              "-export const moveMe = \"source\";",
              "+export const moveMe = \"target\";",
              "*** End Patch",
            ].join("\n"),
          },
          createToolContext(workspacePath),
        ),
        /move target already exists/,
      );
    } finally {
      plugin.dispose();
    }
  });

  async function restoreFixture() {
    await restoreFile(editFixtureUri, 'export const bridgeMessage = "before bridge";\n');
    await restoreFile(patchFixtureUri, "export const patchValue = 1;\n");
    await restoreFile(deletedFixtureUri, "export const deleteMe = true;\n");
    await restoreFile(moveSourceUri, 'export const moveMe = "source";\n');
    if (await fileExists(createdFixtureUri)) {
      await vscode.workspace.fs.delete(createdFixtureUri);
    }
    const addedByPatchUri = vscode.Uri.file(path.join(workspacePath, "bridge-added-by-patch.ts"));
    if (await fileExists(addedByPatchUri)) {
      await vscode.workspace.fs.delete(addedByPatchUri);
    }
    const mismatchedWriteUri = vscode.Uri.file(path.join(workspacePath, "bridge-created-from-mismatched-context.ts"));
    if (await fileExists(mismatchedWriteUri)) {
      await vscode.workspace.fs.delete(mismatchedWriteUri);
    }
    if (await fileExists(moveTargetUri)) {
      await vscode.workspace.fs.delete(moveTargetUri);
    }
    if (await fileExists(externalPatchUri)) {
      await vscode.workspace.fs.delete(externalPatchUri);
    }
    if (await fileExists(externalRelativePatchUri)) {
      await vscode.workspace.fs.delete(externalRelativePatchUri);
    }
    const externalCollisionUri = vscode.Uri.file(path.join(externalSessionPath, "bridge-patch-target.ts"));
    if (await fileExists(externalCollisionUri)) {
      await vscode.workspace.fs.delete(externalCollisionUri);
    }
    const externalAddCollisionUri = vscode.Uri.file(path.join(externalSessionPath, "bridge-add-collision-target.ts"));
    if (await fileExists(externalAddCollisionUri)) {
      await vscode.workspace.fs.delete(externalAddCollisionUri);
    }
    const workspaceAddCollisionUri = vscode.Uri.file(path.join(workspacePath, "bridge-add-collision-target.ts"));
    if (await fileExists(workspaceAddCollisionUri)) {
      await vscode.workspace.fs.delete(workspaceAddCollisionUri);
    }
    await fs.rm(externalSymlinkPath, { force: true });
    if (await fileExists(externalSymlinkEscapeUri)) {
      await vscode.workspace.fs.delete(externalSymlinkEscapeUri);
    }
    await fs.rm(externalAllowedDir, { force: true, recursive: true });
  }

  async function registerFakeOpenCodeSession({
    id,
    title,
    directory,
    timeUpdated,
  }: {
    id: string;
    title: string;
    directory: string;
    timeUpdated: number;
  }) {
    await vscode.commands.executeCommand("opencodeEdit.debug.registerSessionForTest", {
      id,
      title,
      directory,
      updated: timeUpdated,
      created: timeUpdated,
      projectId: "proj_test",
    }, directory);
  }

  async function loadBridgePlugin(_rootPath: string) {
    const launchSpec = (await vscode.commands.executeCommand("opencodeEdit.debug.getBridgeLaunchSpec")) as {
      command: string;
      configContent: string;
      environment: Record<string, string>;
    };

    const parsedConfig = JSON.parse(launchSpec.configContent) as {
      plugin?: string[];
    };
    const pluginUri = parsedConfig.plugin?.[0];
    assert.ok(pluginUri, "expected bridge plugin URI in launch config");

    const previousBridgeUrl = process.env.OPENCODE_VSCODE_BRIDGE_URL;
    const previousBridgeToken = process.env.OPENCODE_VSCODE_BRIDGE_TOKEN;
    const previousWorkspaceRoots = process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS;
    process.env.OPENCODE_VSCODE_BRIDGE_URL = launchSpec.environment.OPENCODE_VSCODE_BRIDGE_URL;
    process.env.OPENCODE_VSCODE_BRIDGE_TOKEN = launchSpec.environment.OPENCODE_VSCODE_BRIDGE_TOKEN;
    process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS = launchSpec.environment.OPENCODE_VSCODE_WORKSPACE_ROOTS;

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
        if (previousWorkspaceRoots === undefined) {
          delete process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS;
        } else {
          process.env.OPENCODE_VSCODE_WORKSPACE_ROOTS = previousWorkspaceRoots;
        }
      },
    };
  }

  async function loadBridgePluginWithPermissions(
    rootPath: string,
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>,
  ) {
    const plugin = await loadBridgePlugin(rootPath);
    const applyPatch = plugin.tool.apply_patch;
    const edit = plugin.tool.edit;
    const write = plugin.tool.write;

    return {
      tool: {
        ...plugin.tool,
        edit: {
          ...edit,
          async execute(args: unknown, context: ReturnType<typeof createToolContext>) {
            return edit.execute(args, withTestAsk(context, permission));
          },
        },
        write: {
          ...write,
          async execute(args: unknown, context: ReturnType<typeof createToolContext>) {
            return write.execute(args, withTestAsk(context, permission));
          },
        },
        apply_patch: {
          ...applyPatch,
          async execute(args: unknown, context: ReturnType<typeof createToolContext>) {
            return applyPatch.execute(args, withTestAsk(context, permission));
          },
        },
      },
      dispose: plugin.dispose,
    };
  }

  function withTestAsk(
    context: ReturnType<typeof createToolContext>,
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>,
  ) {
    return {
      ...context,
      async ask(input: { permission: string; patterns: string[] }) {
        if (input.patterns.every((pattern) => isLexicallyAllowedTestPermissionPath(pattern, input.permission, permission))) {
          return undefined;
        }

        throw new Error("permission denied");
      },
    };
  }

  async function waitForTerminalNamed(name: string) {
    let terminal = vscode.window.terminals.find((candidate) => candidate.name === name);
    if (terminal) {
      return terminal;
    }

    await waitFor(() => {
      terminal = vscode.window.terminals.find((candidate) => candidate.name === name);
      return terminal !== undefined;
    }, `expected terminal named ${name}`);
    assert.ok(terminal, `expected terminal named ${name}`);
    return terminal;
  }

  async function waitFor(condition: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 10000;
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

  function createToolContext(
    directory: string,
    worktree = directory,
    sessionID = "ses_bridge_test",
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> = [],
  ) {
    return {
      sessionID,
      messageID: "msg_bridge_test",
      agent: "build",
      directory,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask(input: { permission: string; patterns: string[] }) {
        if (input.patterns.every((pattern) => isAllowedTestPermissionPath(pattern, input.permission, directory, worktree, permission))) {
          return undefined;
        }

        throw new Error("permission denied");
      },
    };
  }

  function isAllowedTestPermissionPath(
    filePath: string,
    permissionName: string,
    directory: string,
    worktree: string,
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>,
  ) {
    const realFilePath = realpathForTestComparison(filePath);
    const directoryRoot = realpathForTestComparison(directory);
    const worktreeRoot = realpathForTestComparison(worktree);
    if (isWithinTestRoot(realFilePath, directoryRoot) || isWithinTestRoot(realFilePath, worktreeRoot)) {
      return true;
    }

    return permission.some((rule) => {
      if (rule.action !== "allow" || !isMatchingTestPermission(rule.permission, permissionName)) {
        return false;
      }

      const normalizedPattern = path.resolve(rule.pattern);
      if (normalizedPattern.endsWith(`${path.sep}**`)) {
        const root = realpathForTestComparison(normalizedPattern.slice(0, -3));
        return isWithinTestRoot(realFilePath, root);
      }

      return realpathForTestComparison(normalizedPattern) === realFilePath;
    });
  }

  function isLexicallyAllowedTestPermissionPath(
    filePath: string,
    permissionName: string,
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>,
  ) {
    const absolutePath = path.resolve(filePath);
    return permission.some((rule) => {
      if (rule.action !== "allow" || !isMatchingTestPermission(rule.permission, permissionName)) {
        return false;
      }

      const normalizedPattern = path.resolve(rule.pattern);
      if (normalizedPattern.endsWith(`${path.sep}**`)) {
        return isWithinTestRoot(absolutePath, normalizedPattern.slice(0, -3));
      }

      return normalizedPattern === absolutePath;
    });
  }

  function isMatchingTestPermission(rulePermission: string, requestedPermission: string) {
    return rulePermission === requestedPermission;
  }

  function isWithinTestRoot(filePath: string, root: string) {
    const relative = path.relative(root, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function realpathForTestComparison(filePath: string): string {
    const absolutePath = path.resolve(filePath);
    try {
      return realpathSync.native(absolutePath);
    } catch {
      const parent = path.dirname(absolutePath);
      if (parent === absolutePath) {
        return absolutePath;
      }

      return path.join(realpathForTestComparison(parent), path.basename(absolutePath));
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

  function createCurrentUri(itemId: string) {
    return vscode.Uri.from({
      scheme: "opencode-review-current",
      path: `/${Buffer.from(itemId, "utf8").toString("base64url")}`,
    });
  }

  async function fileExists(uri: vscode.Uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async function closeAllReviewDiffTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === "opencode-review-before";
    });
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  }
});
