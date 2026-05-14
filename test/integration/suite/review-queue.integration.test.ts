import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { getTestExtensionId } from "../test-extension";

suite("OpenCode Review Queue", () => {
  suiteSetup(function () {
    this.timeout(20000);
  });

  const fixturePath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", "probe-target.ts");
  const fixtureUri = vscode.Uri.file(fixturePath);
  const secondFixturePath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", "bridge-target.ts");
  const secondFixtureUri = vscode.Uri.file(secondFixturePath);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(getTestExtensionId());
    if (extension) {
      await extension.activate();
    }
  });

  teardown(async () => {
    await restoreFixture();
    await restoreSecondFixture();
    await vscode.commands.executeCommand("opencodeEdit.debug.clearReviewQueue");
    await closeAllReviewDiffTabs();
  });

  test("queues a file, opens diffs, and keeps cumulative undo state until kept", async function () {
    this.timeout(20000);
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");

    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; displayPath: string }>;
    };
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0]?.displayPath, "probe-target.ts");

    const panelHtml = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewPanelHtml")) as string;
    assert.match(panelHtml, /Keep All/);
    assert.match(panelHtml, /Undo All/);
    assert.match(panelHtml, /probe-target\.ts/);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", state.items[0]?.id);
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, "opencode-review-current");
    assert.equal(activeTab?.label ?? "", "probe-target.ts");

    const beforeDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.scheme === "opencode-review-before");
    assert.ok(beforeDocument, "expected before-side review document to open");
    assert.equal(beforeDocument.getText(), "export const answer = 42;\n");
    const currentDocument = vscode.window.activeTextEditor?.document;
    assert.match(currentDocument?.getText() ?? "", /opencode-tui-integration probe/);
    assert.equal(currentDocument?.languageId, "typescript");

    await vscode.commands.executeCommand("opencodeEdit.review.keep", state.items[0]?.id);
    const keptState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string }>;
    };
    assert.equal(keptState.items.length, 0);

    const afterKeep = await vscode.workspace.openTextDocument(fixtureUri);
    assert.match(afterKeep.getText(), /opencode-tui-integration probe/);

    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");
    const queuedState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string }>;
    };
    assert.equal(queuedState.items.length, 1);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", queuedState.items[0]?.id);
    const undoneState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string }>;
    };
    assert.equal(undoneState.items.length, 0);

    const afterUndo = await vscode.workspace.openTextDocument(fixtureUri);
    assert.match(afterUndo.getText(), /opencode-tui-integration probe/);

    await vscode.commands.executeCommand("opencodeEdit.debug.clearReviewQueue");
    await restoreFixture();

    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");
    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");

    const cumulativeState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string; revision: number }>;
    };
    assert.equal(cumulativeState.items.length, 1);
    assert.equal(cumulativeState.items[0]?.revision, 2);

    await vscode.commands.executeCommand("opencodeEdit.review.undo", cumulativeState.items[0]?.id);
    const afterCumulativeUndo = await vscode.workspace.openTextDocument(fixtureUri);
    assert.equal(afterCumulativeUndo.getText(), "export const answer = 42;\n");
  });

  test("closes an open review diff when Keep All clears the queue", async function () {
    this.timeout(20000);
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");
    const state = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string }>;
    };
    const itemId = state.items[0]?.id;
    assert.ok(itemId, "expected queued item id");

    const beforeUri = createBeforeUri(itemId);
    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", itemId);
    assert.equal(hasReviewDiffTab(beforeUri), true);

    const beforeDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === beforeUri.toString());
    assert.ok(beforeDocument, "expected before-side review document to open");
    assert.equal(beforeDocument.getText(), "export const answer = 42;\n");

    await vscode.commands.executeCommand("opencodeEdit.review.keepAll");
    await waitFor(() => !hasReviewDiffTab(beforeUri), "expected Keep All to close the open review diff tab");
    assert.equal(beforeDocument.getText(), "export const answer = 42;\n");

    const keptState = (await vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState")) as {
      items: Array<{ id: string }>;
    };
    assert.equal(keptState.items.length, 0);
  });

  test("opens review diffs in preview mode and advances on Keep when the tab is still preview", async function () {
    this.timeout(20000);
    await queueFixtureChange(fixtureUri);
    await queueFixtureChange(secondFixtureUri);

    const state = await getQueueState();
    assert.equal(state.items.length, 2);

    const firstItemId = findItemId(state, "probe-target.ts");
    const secondItemId = findItemId(state, "bridge-target.ts");
    assert.ok(firstItemId);
    assert.ok(secondItemId);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", firstItemId);

    const firstTab = getReviewDiffTab(createBeforeUri(firstItemId));
    assert.ok(firstTab, "expected first diff tab");
    assert.equal(firstTab.isPreview, true);
    assert.equal(firstTab.isPinned, false);

    await vscode.commands.executeCommand("opencodeEdit.review.keep", firstItemId);

    await waitFor(() => !hasReviewDiffTab(createBeforeUri(firstItemId)), "expected kept preview diff to close");
    await waitFor(() => hasReviewDiffTab(createBeforeUri(secondItemId)), "expected next preview diff to open");

    const secondTab = getReviewDiffTab(createBeforeUri(secondItemId));
    assert.ok(secondTab, "expected second diff tab");
    assert.equal(secondTab.isPreview, true);
    assert.equal(secondTab.isPinned, false);
  });

  test("replaces a non-preview review diff with the kept file after Keep", async function () {
    this.timeout(20000);
    await queueFixtureChange(fixtureUri);
    await queueFixtureChange(secondFixtureUri);

    const state = await getQueueState();
    const firstItemId = findItemId(state, "probe-target.ts");
    const secondItemId = findItemId(state, "bridge-target.ts");
    assert.ok(firstItemId);
    assert.ok(secondItemId);

    const firstBeforeUri = createBeforeUri(firstItemId);
    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", firstItemId);
    await reopenDiffPinned(firstItemId, "probe-target.ts");

    await waitFor(() => {
      const tab = getReviewDiffTab(firstBeforeUri);
      return !!tab && !tab.isPreview;
    }, "expected review diff tab to become non-preview");

    await vscode.commands.executeCommand("opencodeEdit.review.keep", firstItemId);

    await waitFor(async () => (await getQueueState()).items.length === 1, "expected first item to be removed from queue");
    await waitFor(() => !hasReviewDiffTab(firstBeforeUri), "expected non-preview diff to be replaced");
    assert.equal(hasOpenFileTab(fixtureUri), true);
    assert.equal(hasReviewDiffTab(createBeforeUri(secondItemId)), false);
  });

  test("advances on Undo when the active review diff is still preview", async function () {
    this.timeout(20000);
    await queueFixtureChange(fixtureUri);
    await queueFixtureChange(secondFixtureUri);

    const state = await getQueueState();
    const firstItemId = findItemId(state, "probe-target.ts");
    const secondItemId = findItemId(state, "bridge-target.ts");
    assert.ok(firstItemId);
    assert.ok(secondItemId);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", firstItemId);
    await vscode.commands.executeCommand("opencodeEdit.review.undo", firstItemId);

    await waitFor(() => !hasReviewDiffTab(createBeforeUri(firstItemId)), "expected undone preview diff to close");
    await waitFor(() => hasReviewDiffTab(createBeforeUri(secondItemId)), "expected next preview diff to open after Undo");
  });

  test("Keep All closes preview review diffs and replaces non-preview diffs with kept files", async function () {
    this.timeout(20000);
    await queueFixtureChange(fixtureUri);
    await queueFixtureChange(secondFixtureUri);

    const state = await getQueueState();
    const firstItemId = findItemId(state, "probe-target.ts");
    const secondItemId = findItemId(state, "bridge-target.ts");
    assert.ok(firstItemId);
    assert.ok(secondItemId);

    const firstBeforeUri = createBeforeUri(firstItemId);
    const secondBeforeUri = createBeforeUri(secondItemId);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", firstItemId);
    await reopenDiffPinned(firstItemId, "probe-target.ts");
    await waitFor(() => {
      const tab = getReviewDiffTab(firstBeforeUri);
      return !!tab && !tab.isPreview;
    }, "expected first review diff tab to become non-preview");

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", secondItemId);
    await waitFor(() => {
      const tab = getReviewDiffTab(secondBeforeUri);
      return !!tab && tab.isPreview;
    }, "expected second review diff tab to remain preview");

    await vscode.commands.executeCommand("opencodeEdit.review.keepAll");

    await waitFor(() => !hasReviewDiffTab(secondBeforeUri), "expected preview diff tab to close after Keep All");
    await waitFor(() => !hasReviewDiffTab(firstBeforeUri), "expected non-preview diff to be replaced after Keep All");
    assert.equal(hasOpenFileTab(fixtureUri), true);
    assert.equal((await getQueueState()).items.length, 0);
  });

  test("Undo All closes preview review diffs and replaces non-preview diffs with restored files", async function () {
    this.timeout(20000);
    await queueFixtureChange(fixtureUri);
    await queueFixtureChange(secondFixtureUri);

    const state = await getQueueState();
    const firstItemId = findItemId(state, "probe-target.ts");
    const secondItemId = findItemId(state, "bridge-target.ts");
    assert.ok(firstItemId);
    assert.ok(secondItemId);

    const firstBeforeUri = createBeforeUri(firstItemId);
    const secondBeforeUri = createBeforeUri(secondItemId);

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", firstItemId);
    await reopenDiffPinned(firstItemId, "probe-target.ts");
    await waitFor(() => {
      const tab = getReviewDiffTab(firstBeforeUri);
      return !!tab && !tab.isPreview;
    }, "expected first review diff tab to become non-preview");

    await vscode.commands.executeCommand("opencodeEdit.review.openDiff", secondItemId);
    await waitFor(() => {
      const tab = getReviewDiffTab(secondBeforeUri);
      return !!tab && tab.isPreview;
    }, "expected second review diff tab to remain preview");

    await vscode.commands.executeCommand("opencodeEdit.review.undoAll");

    await waitFor(() => !hasReviewDiffTab(secondBeforeUri), "expected preview diff tab to close after Undo All");
    await waitFor(() => !hasReviewDiffTab(firstBeforeUri), "expected non-preview diff to be replaced after Undo All");
    assert.equal(hasOpenFileTab(fixtureUri), true);
    assert.equal((await getQueueState()).items.length, 0);
  });

  async function restoreFixture() {
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    const edit = new vscode.WorkspaceEdit();
    const lastLine = Math.max(document.lineCount - 1, 0);
    const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
    edit.replace(
      fixtureUri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
      "export const answer = 42;\n",
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  async function restoreSecondFixture() {
    const document = await vscode.workspace.openTextDocument(secondFixtureUri);
    const edit = new vscode.WorkspaceEdit();
    const lastLine = Math.max(document.lineCount - 1, 0);
    const lastCharacter = document.lineCount === 0 ? 0 : document.lineAt(lastLine).text.length;
    edit.replace(
      secondFixtureUri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastCharacter)),
      'export const bridgeMessage = "before bridge";\n',
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  async function queueFixtureChange(uri: vscode.Uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("opencodeEdit.queueReviewEdit");
  }

  function getQueueState() {
    return vscode.commands.executeCommand("opencodeEdit.debug.getReviewQueueState") as Promise<{
      items: Array<{ id: string; displayPath: string }>;
    }>;
  }

  function findItemId(state: { items: Array<{ id: string; displayPath: string }> }, displayPath: string) {
    return state.items.find((item) => item.displayPath === displayPath)?.id;
  }

  function createBeforeUri(itemId: string) {
    return vscode.Uri.from({
      scheme: "opencode-review-before",
      path: `/${Buffer.from(itemId, "utf8").toString("base64url")}`,
    });
  }

  function hasReviewDiffTab(beforeUri: vscode.Uri) {
    return !!getReviewDiffTab(beforeUri);
  }

  function hasOpenFileTab(uri: vscode.Uri) {
    const target = uri.toString();
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
      return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === target;
    });
  }

  function getReviewDiffTab(beforeUri: vscode.Uri) {
    const beforeUriString = beforeUri.toString();
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === beforeUriString;
    });
  }

  async function reopenDiffPinned(itemId: string, title: string) {
    const beforeUri = createBeforeUri(itemId);
    await closeReviewDiffTabs(beforeUri);
    const currentUri = vscode.Uri.parse(itemId);
    await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  async function closeReviewDiffTabs(beforeUri: vscode.Uri) {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
      return tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === beforeUri.toString();
    });

    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
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

  async function waitFor(condition: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.fail(message);
  }
});
