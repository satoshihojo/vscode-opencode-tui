import * as vscode from "vscode";
import { ReviewDocumentProvider } from "./review-document-provider";
import { createReviewDiffTargets } from "./review-diff-targets";
import type { ReviewQueueItem, ReviewQueueStore } from "./review-queue-store";

type ReviewQueueStoreLike = Pick<ReviewQueueStore, "get" | "list">;

type PreparedRemovalState = {
  isPreview: boolean;
  replacementUri?: string;
  replacementPreview?: boolean;
};

export class ReviewDiffController implements vscode.Disposable {
  private activeItemId?: string;
  private queuedItemIds: string[];
  private readonly preparedRemovalStates = new Map<string, PreparedRemovalState>();

  constructor(
    private readonly store: ReviewQueueStoreLike,
    private readonly documentProvider: ReviewDocumentProvider,
  ) {
    this.queuedItemIds = this.store.list().map((item) => item.id);
  }

  dispose() {
    this.activeItemId = undefined;
    this.queuedItemIds = [];
    this.preparedRemovalStates.clear();
  }

  prepareForRemoval(itemIds: string[]) {
    this.prepareRemovalStates(itemIds);
  }

  prepareForKeep(itemIds: string[]) {
    this.prepareRemovalStates(itemIds, (item) => getKeepReplacement(item));
  }

  prepareForUndo(itemIds: string[]) {
    this.prepareRemovalStates(itemIds, (item) => getUndoReplacement(item));
  }

  async open(itemId: string) {
    const item = this.store.get(itemId);
    if (!item) {
      return;
    }

    this.activeItemId = item.id;
    await this.openDiff(item);
  }

  sync(items: ReviewQueueItem[], removedItemIds: string[] = []) {
    const previousItemIds = this.queuedItemIds;
    const activeItemId = this.activeItemId;
    const nextItemIds = items.map((item) => item.id);

    this.queuedItemIds = nextItemIds;

    if (activeItemId && !nextItemIds.includes(activeItemId)) {
      this.activeItemId = undefined;
    }

    if (removedItemIds.length === 0) {
      return;
    }

    const shouldAdvance = removedItemIds.length === 1
      && activeItemId
      && removedItemIds.includes(activeItemId)
      && this.shouldCloseTabForItem(activeItemId).isPreview;
    const nextItemId = shouldAdvance ? findNextItemId(previousItemIds, nextItemIds, activeItemId) : undefined;

    void this.reconcileRemovedDiffTabs(removedItemIds, activeItemId, nextItemId);
  }

  private async openDiff(item: ReviewQueueItem) {
    const { beforeUri, currentUri } = createReviewDiffTargets(this.documentProvider, item);
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      currentUri,
      toTabTitle(item.displayPath),
      {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      },
    );
    await setReviewDocumentLanguage(currentUri, item.languageId);
  }

  private prepareRemovalStates(itemIds: string[], getReplacement?: (item: ReviewQueueItem) => { uri?: string; preview?: boolean }) {
    const tabs = getReviewDiffTabs(this.documentProvider, itemIds);
    const previewStates = new Map(tabs.map(({ itemId, tab }) => [itemId, tab.isPreview]));

    for (const itemId of itemIds) {
      if (this.preparedRemovalStates.has(itemId)) {
        continue;
      }

      const item = this.store.get(itemId);
      const replacement = item && getReplacement ? getReplacement(item) : undefined;
      this.preparedRemovalStates.set(itemId, {
        isPreview: previewStates.get(itemId) ?? false,
        replacementUri: replacement?.uri,
        replacementPreview: replacement?.preview,
      });
    }
  }

  private async reconcileRemovedDiffTabs(itemIds: string[], activeItemId: string | undefined, nextItemId: string | undefined) {
    const tabs = getReviewDiffTabs(this.documentProvider, itemIds);
    const previewTabs = tabs.filter(({ itemId, tab }) => this.shouldCloseTabForItem(itemId, tab.isPreview).isPreview);
    const nonPreviewTabs = tabs.filter(({ itemId, tab }) => !this.shouldCloseTabForItem(itemId, tab.isPreview).isPreview);
    const activePreviewTabClosed = !!activeItemId && previewTabs.some(({ itemId }) => itemId === activeItemId);

    if (previewTabs.length > 0) {
      await vscode.window.tabGroups.close(previewTabs.map(({ tab }) => tab), true);
    }

    for (const { itemId } of nonPreviewTabs) {
      const replacement = this.shouldCloseTabForItem(itemId, false);
      await this.replaceRemovedDiffTab(itemId, replacement.replacementUri, replacement.replacementPreview ?? false);
    }

    for (const itemId of itemIds) {
      this.preparedRemovalStates.delete(itemId);
    }

    if (activePreviewTabClosed && nextItemId) {
      await this.open(nextItemId);
    }
  }

  private async replaceRemovedDiffTab(itemId: string, replacementUri: string | undefined, preview: boolean) {
    const currentTabs = getReviewDiffTabs(this.documentProvider, [itemId]);
    if (currentTabs.length === 0) {
      return;
    }

    const viewColumn = currentTabs[0]?.tab.group.viewColumn;

    if (replacementUri) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(replacementUri));
        await vscode.window.showTextDocument(document, {
          preview,
          preserveFocus: false,
          viewColumn,
        });
      } catch {}
    }

    const remainingTabs = getReviewDiffTabs(this.documentProvider, [itemId]).map(({ tab }) => tab);
    if (remainingTabs.length > 0) {
      try {
        await vscode.window.tabGroups.close(remainingTabs, true);
      } catch {}
    }
  }

  private shouldCloseTabForItem(itemId: string, fallbackPreviewState?: boolean) {
    return this.preparedRemovalStates.get(itemId) ?? {
      isPreview: fallbackPreviewState ?? false,
      replacementUri: undefined,
    };
  }
}

function toTabTitle(displayPath: string) {
  const normalized = displayPath.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function getReviewDiffTabs(documentProvider: ReviewDocumentProvider, itemIds: string[]) {
  const beforeUriToItemId = new Map(itemIds.map((itemId) => [documentProvider.createBeforeUri(itemId).toString(), itemId]));

  return vscode.window.tabGroups.all.flatMap((group) => {
    return group.tabs.flatMap((tab) => {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) {
        return [];
      }

      const itemId = beforeUriToItemId.get(tab.input.original.toString());
      if (!itemId) {
        return [];
      }

      return [{ itemId, tab }];
    });
  });
}

function findNextItemId(previousItemIds: string[], nextItemIds: string[], activeItemId: string) {
  const activeIndex = previousItemIds.indexOf(activeItemId);
  if (activeIndex === -1) {
    return undefined;
  }

  const nextItemIdSet = new Set(nextItemIds);
  for (let index = activeIndex + 1; index < previousItemIds.length; index += 1) {
    const candidate = previousItemIds[index];
    if (candidate && nextItemIdSet.has(candidate)) {
      return candidate;
    }
  }

  for (let index = 0; index < activeIndex; index += 1) {
    const candidate = previousItemIds[index];
    if (candidate && nextItemIdSet.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getKeepReplacementUri(item: ReviewQueueItem) {
  if (item.changeKind === "delete") {
    return undefined;
  }

  return item.targetUri;
}

function getKeepReplacement(item: ReviewQueueItem) {
  return {
    uri: getKeepReplacementUri(item),
    preview: false,
  };
}

function getUndoReplacement(item: ReviewQueueItem) {
  return {
    uri: getUndoReplacementUri(item),
    preview: false,
  };
}

function getUndoReplacementUri(item: ReviewQueueItem) {
  if (item.changeKind === "add") {
    return undefined;
  }

  if (item.changeKind === "move") {
    return item.sourceUri;
  }

  return item.targetUri;
}

async function setReviewDocumentLanguage(uri: vscode.Uri, languageId: string) {
  if (!languageId || languageId === "plaintext") {
    return;
  }

  const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
  if (!document || document.languageId === languageId) {
    return;
  }

  try {
    await vscode.languages.setTextDocumentLanguage(document, languageId);
  } catch {
    // Keep the diff available even when a language extension is missing or rejects the id.
  }
}
