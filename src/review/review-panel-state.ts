import type { ReviewQueueItem } from "./review-queue-store";

export type ReviewPanelState = {
  sessionTitlesById: Record<string, string>;
  sessionCanonicalIdsById: Record<string, string>;
  items: Array<
    Pick<
      ReviewQueueItem,
      | "id"
      | "displayPath"
      | "targetUri"
      | "saved"
      | "revision"
      | "targetKind"
      | "changeKind"
      | "originalText"
      | "currentText"
      | "currentExists"
      | "languageId"
      | "sourceUri"
      | "sourceSessionIds"
      | "stats"
    >
  >;
};
