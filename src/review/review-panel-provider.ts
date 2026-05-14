import * as vscode from "vscode";
import type { ReviewDiffController } from "./review-diff-controller";
import type { ReviewQueueManager } from "./review-queue-manager";
import type { ReviewPanelState } from "./review-panel-state";
import type { ReviewQueueStore } from "./review-queue-store";
import { renderReviewPanelHtml } from "./review-panel-html";

export const REVIEW_PANEL_VIEW_ID = "opencodeEdit.reviewPanel";

type ReviewPanelButtonStyle = {
  backgroundColor: string;
  borderColor: string;
  color: string;
  backgroundImage: string;
  boxShadow: string;
};

export type ReviewPanelButtonStyles = {
  toolbarKeep: ReviewPanelButtonStyle | null;
  toolbarUndo: ReviewPanelButtonStyle | null;
  itemKeep: ReviewPanelButtonStyle | null;
  itemUndo: ReviewPanelButtonStyle | null;
};

type PendingButtonStyleRequest = {
  resolve(styles: ReviewPanelButtonStyles): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ReviewPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingButtonStyleRequests = new Map<string, PendingButtonStyleRequest>();
  private sessionTitlesById: Record<string, string> = {};
  private sessionCanonicalIdsById: Record<string, string> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ReviewQueueStore,
    private readonly manager: ReviewQueueManager,
    private readonly diffController?: Pick<ReviewDiffController, "prepareForKeep" | "prepareForUndo">,
  ) {}

  dispose() {
    vscode.Disposable.from(...this.disposables).dispose();
    for (const request of this.pendingButtonStyleRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Review panel disposed before button styles were returned."));
    }
    this.pendingButtonStyleRequests.clear();
    this.view = undefined;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.disposables.push(view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    }));
    this.configureWebview(view.webview);
    this.render();
  }

  updateVisibility() {
    void vscode.commands.executeCommand("setContext", "opencodeEdit.hasPendingChanges", this.store.list().length > 0);
  }

  reveal() {
    this.view?.show?.(true);
  }

  async getButtonStyles() {
    if (!this.view) {
      throw new Error("Review panel is not available.");
    }

    const requestId = `button-styles-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const styles = new Promise<ReviewPanelButtonStyles>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingButtonStyleRequests.delete(requestId);
        reject(new Error("Timed out waiting for review panel button styles."));
      }, 2000);

      this.pendingButtonStyleRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      });
    });

    const posted = await this.view.webview.postMessage({
      type: "debug-read-button-styles",
      requestId,
    });

    if (!posted) {
      const pending = this.pendingButtonStyleRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingButtonStyleRequests.delete(requestId);
      }
      throw new Error("Review panel did not accept the button style request.");
    }

    return styles;
  }

  getState(): ReviewPanelState {
    return {
      sessionTitlesById: this.sessionTitlesById,
      sessionCanonicalIdsById: this.sessionCanonicalIdsById,
      items: this.store.list().map((item) => ({
        id: item.id,
        displayPath: item.displayPath,
        targetUri: item.targetUri,
        saved: item.saved,
        revision: item.revision,
        targetKind: item.targetKind,
        changeKind: item.changeKind,
        originalText: item.originalText,
        currentText: item.currentText,
        currentExists: item.currentExists,
        languageId: item.languageId,
        sourceUri: item.sourceUri,
        sourceSessionIds: item.sourceSessionIds,
        stats: item.stats,
      })),
    };
  }

  setSessionMetadata(sessionTitlesById: Record<string, string>, sessionCanonicalIdsById: Record<string, string>) {
    this.sessionTitlesById = { ...sessionTitlesById };
    this.sessionCanonicalIdsById = { ...sessionCanonicalIdsById };
  }

  getHtml() {
    return renderReviewPanelHtml(this.getState());
  }

  render() {
    this.updateVisibility();

    if (!this.view) {
      return;
    }

    const html = this.getHtml();
    this.renderWebviewView(html);
  }

  private configureWebview(webview: vscode.Webview) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.disposables.push(webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }));
  }

  private renderWebviewView(html: string) {
    if (!this.view) {
      return;
    }

    try {
      this.view.webview.html = html;
    } catch (error) {
      if (error instanceof Error && error.message.includes("disposed")) {
        this.view = undefined;
        return;
      }

      throw error;
    }
  }

  private async handleMessage(message: { type?: string; itemId?: string; requestId?: string; styles?: ReviewPanelButtonStyles }) {
    switch (message.type) {
      case "open-diff":
        if (message.itemId) {
          await this.manager.openDiff(message.itemId);
        }
        return;
      case "keep":
        if (message.itemId) {
          this.diffController?.prepareForKeep([message.itemId]);
          this.manager.keep(message.itemId);
        }
        break;
      case "undo":
        if (message.itemId) {
          this.diffController?.prepareForUndo([message.itemId]);
          await this.manager.undo(message.itemId);
        }
        break;
      case "keep-all":
        this.diffController?.prepareForKeep(this.store.list().map((item) => item.id));
        this.manager.keepAll();
        break;
      case "undo-all":
        this.diffController?.prepareForUndo(this.store.list().map((item) => item.id));
        await this.manager.undoAll();
        break;
      case "debug-button-styles": {
        const pending = message.requestId ? this.pendingButtonStyleRequests.get(message.requestId) : undefined;
        if (!pending || !message.styles) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingButtonStyleRequests.delete(message.requestId!);
        pending.resolve(message.styles);
        return;
      }
      default:
        return;
    }

    this.render();
  }
}
