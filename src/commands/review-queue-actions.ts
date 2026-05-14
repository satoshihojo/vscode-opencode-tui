import type { ReviewPanelProvider } from "../review/review-panel-provider";
import type { ReviewDiffController } from "../review/review-diff-controller";
import type { ReviewQueueManager } from "../review/review-queue-manager";

export function createOpenReviewDiffCommand(manager: Pick<ReviewQueueManager, "openDiff">) {
  return async (itemId: string) => {
    await manager.openDiff(itemId);
  };
}

export function createKeepReviewItemCommand(
  manager: Pick<ReviewQueueManager, "keep">,
  panel: Pick<ReviewPanelProvider, "render">,
  diffController?: Pick<ReviewDiffController, "prepareForKeep">,
) {
  return async (itemId: string) => {
    diffController?.prepareForKeep([itemId]);
    manager.keep(itemId);
    panel.render();
  };
}

export function createUndoReviewItemCommand(
  manager: Pick<ReviewQueueManager, "undo">,
  panel: Pick<ReviewPanelProvider, "render">,
  diffController?: Pick<ReviewDiffController, "prepareForUndo">,
) {
  return async (itemId: string) => {
    diffController?.prepareForUndo([itemId]);
    await manager.undo(itemId);
    panel.render();
  };
}

export function createKeepAllReviewItemsCommand(
  manager: Pick<ReviewQueueManager, "keepAll">,
  panel: Pick<ReviewPanelProvider, "render">,
  diffController?: Pick<ReviewDiffController, "prepareForKeep">,
  listItems?: () => Array<{ id: string }>,
) {
  return async () => {
    diffController?.prepareForKeep(listItems?.().map((item) => item.id) ?? []);
    manager.keepAll();
    panel.render();
  };
}

export function createUndoAllReviewItemsCommand(
  manager: Pick<ReviewQueueManager, "undoAll">,
  panel: Pick<ReviewPanelProvider, "render">,
  diffController?: Pick<ReviewDiffController, "prepareForUndo">,
  listItems?: () => Array<{ id: string }>,
) {
  return async () => {
    diffController?.prepareForUndo(listItems?.().map((item) => item.id) ?? []);
    await manager.undoAll();
    panel.render();
  };
}
