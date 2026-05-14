import { diffLines } from "diff";

export type ReviewQueueTargetKind = "existing" | "scratch";

export type ReviewQueueChangeKind = "add" | "update" | "delete" | "move";

export type ReviewQueueItem = {
  id: string;
  targetUri: string;
  displayPath: string;
  changeKind: ReviewQueueChangeKind;
  originalText: string;
  currentText: string;
  currentExists: boolean;
  sourceUri?: string;
  sourceSessionIds: string[];
  languageId: string;
  targetKind: ReviewQueueTargetKind;
  saved: boolean;
  wasDirtyBeforeApply: boolean;
  revision: number;
  stats: ReviewQueueItemStats;
};

export type ReviewQueueItemStats = {
  additions: number;
  deletions: number;
};

export type UpsertReviewQueueItemInput = {
  targetUri: string;
  displayPath: string;
  changeKind: ReviewQueueChangeKind;
  originalText: string;
  currentText: string;
  currentExists: boolean;
  sourceUri?: string;
  sourceSessionId?: string;
  languageId: string;
  targetKind: ReviewQueueTargetKind;
  saved: boolean;
  wasDirtyBeforeApply: boolean;
};

export class ReviewQueueStore {
  private readonly items = new Map<string, ReviewQueueItem>();

  constructor(
    initialItems: ReviewQueueItem[] = [],
    private readonly onDidChange?: (items: ReviewQueueItem[]) => void,
  ) {
    for (const item of initialItems) {
      this.items.set(item.id, item);
    }
  }

  list() {
    return [...this.items.values()].sort((left, right) => left.displayPath.localeCompare(right.displayPath));
  }

  get(id: string) {
    return this.items.get(id);
  }

  upsert(input: UpsertReviewQueueItemInput) {
    const existing = this.items.get(input.targetUri);
    if (existing) {
      const nextChangeKind = mergeChangeKind(existing, input);
      if (!nextChangeKind) {
        this.items.delete(existing.id);
        this.notifyChange();
        return undefined;
      }

      const nextItem: ReviewQueueItem = {
        ...existing,
        displayPath: existing.displayPath,
        changeKind: nextChangeKind,
        currentText: input.currentText,
        currentExists: input.currentExists,
        sourceUri: existing.sourceUri ?? input.sourceUri,
        sourceSessionIds: mergeSourceSessionIds(existing.sourceSessionIds, input.sourceSessionId),
        languageId: input.languageId,
        saved: input.saved,
        wasDirtyBeforeApply: existing.wasDirtyBeforeApply,
        revision: existing.revision + 1,
        stats: calculateStats({
          changeKind: nextChangeKind,
          originalText: existing.originalText,
          currentText: input.currentText,
          currentExists: input.currentExists,
        }),
      };
      this.items.set(nextItem.id, nextItem);
      this.notifyChange();
      return nextItem;
    }

    const nextItem: ReviewQueueItem = {
      id: input.targetUri,
      targetUri: input.targetUri,
      displayPath: input.displayPath,
      changeKind: input.changeKind,
      originalText: input.originalText,
      currentText: input.currentText,
      currentExists: input.currentExists,
      sourceUri: input.sourceUri,
      sourceSessionIds: mergeSourceSessionIds([], input.sourceSessionId),
      languageId: input.languageId,
      targetKind: input.targetKind,
      saved: input.saved,
      wasDirtyBeforeApply: input.wasDirtyBeforeApply,
      revision: 1,
      stats: calculateStats(input),
    };
    this.items.set(nextItem.id, nextItem);
    this.notifyChange();
    return nextItem;
  }

  updateCurrentText(id: string, currentText: string, saved: boolean, currentExists?: boolean) {
    const existing = this.items.get(id);
    if (!existing) {
      return undefined;
    }

    const nextItem: ReviewQueueItem = {
      ...existing,
      currentText,
      currentExists: currentExists ?? existing.currentExists,
      saved,
      stats: calculateStats({
        changeKind: existing.changeKind,
        originalText: existing.originalText,
        currentText,
        currentExists: currentExists ?? existing.currentExists,
      }),
    };
    this.items.set(id, nextItem);
    this.notifyChange();
    return nextItem;
  }

  keep(id: string) {
    this.items.delete(id);
    this.notifyChange();
  }

  keepAll() {
    this.items.clear();
    this.notifyChange();
  }

  private notifyChange() {
    this.onDidChange?.(this.list());
  }
}

function mergeSourceSessionIds(existing: string[], nextSessionId: string | undefined) {
  const sessionIds = existing.filter((sessionId) => isValidSourceSessionId(sessionId));
  if (isValidSourceSessionId(nextSessionId) && !sessionIds.includes(nextSessionId)) {
    return [...sessionIds, nextSessionId];
  }

  return sessionIds;
}

function isValidSourceSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === "string" && /^ses[A-Za-z0-9_]+$/.test(sessionId) && sessionId.length <= 128;
}

function mergeChangeKind(existing: ReviewQueueItem, input: UpsertReviewQueueItemInput) {
  if (existing.changeKind === "add") {
    return input.currentExists ? "add" : undefined;
  }

  if (existing.changeKind === "move") {
    return "move";
  }

  if (existing.changeKind === "delete") {
    return input.currentExists ? "update" : "delete";
  }

  return input.currentExists ? "update" : "delete";
}

export function calculateStats(item: Pick<ReviewQueueItem, "changeKind" | "originalText" | "currentText" | "currentExists">): ReviewQueueItemStats {
  if (item.changeKind === "add") {
    return {
      additions: countContentLines(item.currentText),
      deletions: 0,
    };
  }

  if (item.changeKind === "delete" || !item.currentExists) {
    return {
      additions: 0,
      deletions: countContentLines(item.originalText),
    };
  }

  return diffLines(item.originalText, item.currentText).reduce(
    (accumulator, part) => ({
      additions: accumulator.additions + (part.added ? part.count ?? countContentLines(part.value) : 0),
      deletions: accumulator.deletions + (part.removed ? part.count ?? countContentLines(part.value) : 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function countContentLines(value: string) {
  if (value.length === 0) {
    return 0;
  }

  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}
