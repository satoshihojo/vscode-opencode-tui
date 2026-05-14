import type { ReviewQueueStore } from "./review-queue-store";

type ReviewQueueManagerDeps = {
  openDiff(itemId: string): Promise<void>;
  readTargetState(targetUri: string): Promise<{ exists: boolean; text: string }>;
  writeText(targetUri: string, text: string): Promise<boolean>;
  deleteFile(targetUri: string): Promise<boolean>;
  saveTarget(targetUri: string): Promise<boolean>;
  showWarningMessage(message: string): void;
};

export class ReviewQueueManager {
  constructor(
    private readonly store: ReviewQueueStore,
    private readonly deps: ReviewQueueManagerDeps,
  ) {}

  async openDiff(itemId: string) {
    const item = this.store.get(itemId);
    if (!item) {
      return;
    }

    await this.deps.openDiff(itemId);
  }

  keep(itemId: string) {
    this.store.keep(itemId);
    return "kept" as const;
  }

  keepAll() {
    this.store.keepAll();
    return "kept-all" as const;
  }

  async undo(itemId: string) {
    return this.undoItem(itemId);
  }

  async undoAll() {
    const itemIds = this.store.list().map((item) => item.id);
    let undone = 0;

    for (const itemId of itemIds) {
      const result = await this.undoItem(itemId);
      if (result === "undone") {
        undone += 1;
      }
    }

    return undone;
  }

  private async undoItem(itemId: string) {
    const item = this.store.get(itemId);
    if (!item) {
      return "missing" as const;
    }

    const liveTarget = await this.deps.readTargetState(item.targetUri);
    if (hasLiveTargetChanged(liveTarget, item)) {
      this.deps.showWarningMessage(`Cannot undo ${item.displayPath} because it changed since it was queued.`);
      return "conflict" as const;
    }

    if (item.changeKind === "move" && item.sourceUri) {
      const liveSource = await this.deps.readTargetState(item.sourceUri);
      if (liveSource.exists) {
        this.deps.showWarningMessage(`Cannot undo ${item.displayPath} because the original path now exists.`);
        return "conflict" as const;
      }
    }

    const restored = await this.restoreItem(item);
    if (!restored) {
      this.deps.showWarningMessage(`Failed to restore ${item.displayPath}. The review item remains queued.`);
      return "failed" as const;
    }

    const saveTargetUri = this.getSaveTargetUri(item);
    if (saveTargetUri && item.targetKind !== "scratch" && !item.wasDirtyBeforeApply) {
      const saved = await this.deps.saveTarget(saveTargetUri);
      if (!saved) {
        if (item.changeKind === "move") {
          this.store.updateCurrentText(itemId, item.originalText, false, true);
          this.deps.showWarningMessage(`Restored ${item.displayPath} in memory but failed to save the original file. The review item remains queued.`);
          return "failed" as const;
        }

        this.store.updateCurrentText(itemId, item.originalText, false, true);
        this.deps.showWarningMessage(`Restored ${item.displayPath} in memory but failed to save it. The review item remains queued.`);
        return "failed" as const;
      }
    }

    this.store.keep(itemId);
    return "undone" as const;
  }

  private async restoreItem(item: NonNullable<ReturnType<ReviewQueueStore["get"]>>) {
    switch (item.changeKind) {
      case "add":
        return this.deps.deleteFile(item.targetUri);
      case "delete":
      case "update":
        return this.deps.writeText(item.targetUri, item.originalText);
      case "move": {
        if (!item.sourceUri) {
          return false;
        }

        const restoredSource = await this.deps.writeText(item.sourceUri, item.originalText);
        if (!restoredSource) {
          return false;
        }

        const deletedTarget = await this.deps.deleteFile(item.targetUri);
        if (deletedTarget) {
          return true;
        }

        await this.deps.deleteFile(item.sourceUri);
        return false;
      }
    }
  }

  private getSaveTargetUri(item: NonNullable<ReturnType<ReviewQueueStore["get"]>>) {
    if (item.changeKind === "add") {
      return undefined;
    }

    if (item.changeKind === "move") {
      return item.sourceUri;
    }

    return item.targetUri;
  }
}

function hasLiveTargetChanged(
  liveTarget: { exists: boolean; text: string },
  item: NonNullable<ReturnType<ReviewQueueStore["get"]>>,
) {
  if (liveTarget.exists !== item.currentExists) {
    return true;
  }

  if (!liveTarget.exists) {
    return false;
  }

  return normalizeLineEndings(liveTarget.text) !== normalizeLineEndings(item.currentText);
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}
