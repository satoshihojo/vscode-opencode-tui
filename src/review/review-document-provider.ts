import * as vscode from "vscode";
import type { ReviewQueueStore } from "./review-queue-store";

export const REVIEW_BEFORE_DOCUMENT_SCHEME = "opencode-review-before";
export const REVIEW_CURRENT_DOCUMENT_SCHEME = "opencode-review-current";

export class ReviewDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  constructor(private readonly store: ReviewQueueStore) {}

  readonly onDidChange = this.didChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri) {
    const item = this.store.get(decodeReviewItemId(uri));
    if (!item) {
      return "";
    }

    if (uri.scheme === REVIEW_CURRENT_DOCUMENT_SCHEME) {
      return item.currentExists ? item.currentText : "";
    }

    return item.originalText;
  }

  createBeforeUri(itemId: string) {
    return createReviewDocumentUri(REVIEW_BEFORE_DOCUMENT_SCHEME, itemId);
  }

  createCurrentUri(itemId: string) {
    return createReviewDocumentUri(REVIEW_CURRENT_DOCUMENT_SCHEME, itemId);
  }

  notifyChanged(itemIds: string[]) {
    for (const itemId of itemIds) {
      this.didChangeEmitter.fire(this.createBeforeUri(itemId));
      this.didChangeEmitter.fire(this.createCurrentUri(itemId));
    }
  }
}

function createReviewDocumentUri(scheme: string, itemId: string) {
  return vscode.Uri.from({
    scheme,
    path: `/${encodeReviewItemId(itemId)}`,
  });
}

function encodeReviewItemId(itemId: string) {
  return Buffer.from(itemId, "utf8").toString("base64url");
}

function decodeReviewItemId(uri: vscode.Uri) {
  const encoded = uri.path.replace(/^\//, "");
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return decodeURIComponent(encoded);
  }
}
