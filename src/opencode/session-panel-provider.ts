import * as vscode from "vscode";
import {
  handleOpenCodeSessionPanelMessage,
  type OpenCodeSessionPanelActions,
  type OpenCodeSessionPanelMessage,
} from "./session-panel-message";
import { renderOpenCodeSessionPanelHtml } from "./session-panel-html";
import {
  clearOpenCodeSessionTabSelection,
  closeOpenCodeSessionTab,
  registerOpenCodeSessionTab,
  selectOpenCodeSessionTab,
  updateOpenCodeSessionTabStatus,
  updateOpenCodeSessionTabTitle,
  type OpenCodeSessionTabState,
  type OpenCodeSessionTabStatus,
  type RegisterOpenCodeSessionTabInput,
} from "./session-tab-status-registry";

export const OPENCODE_SESSION_PANEL_VIEW_ID = "opencodeEdit.sessionsPanel";

export class OpenCodeSessionPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private state: OpenCodeSessionTabState = { tabsByRestoreId: {}, order: [] };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: OpenCodeSessionPanelActions = {},
  ) {}

  dispose() {
    vscode.Disposable.from(...this.disposables).dispose();
    this.view = undefined;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.disposables.push(view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    }));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.disposables.push(view.webview.onDidReceiveMessage((message: OpenCodeSessionPanelMessage) => {
      this.handleMessage(message);
    }));
    this.render();
  }

  reveal() {
    this.view?.show?.(true);
  }

  registerSession(input: RegisterOpenCodeSessionTabInput) {
    this.updateState(registerOpenCodeSessionTab(this.state, input));
  }

  updateTitle(restoreId: string, title: string) {
    this.updateState(updateOpenCodeSessionTabTitle(this.state, restoreId, title));
  }

  updateStatus(restoreId: string, status: OpenCodeSessionTabStatus) {
    this.updateState(updateOpenCodeSessionTabStatus(this.state, restoreId, status));
  }

  selectSession(restoreId: string) {
    this.updateState(selectOpenCodeSessionTab(this.state, restoreId));
  }

  clearSelection() {
    this.updateState(clearOpenCodeSessionTabSelection(this.state));
  }

  closeSession(restoreId: string) {
    this.updateState(closeOpenCodeSessionTab(this.state, restoreId));
  }

  getState() {
    return this.state;
  }

  replaceState(state: OpenCodeSessionTabState) {
    this.updateState(state);
  }

  private handleMessage(message: OpenCodeSessionPanelMessage) {
    this.updateState(handleOpenCodeSessionPanelMessage(this.state, message, this.actions));
  }

  private updateState(nextState: OpenCodeSessionTabState) {
    if (nextState === this.state) {
      return;
    }

    this.state = nextState;
    void vscode.commands.executeCommand("setContext", "opencodeEdit.hasOpenCodeSessions", this.state.order.length > 0);
    this.render();
  }

  private render() {
    if (!this.view) {
      return;
    }

    try {
      this.view.webview.html = renderOpenCodeSessionPanelHtml(this.state);
    } catch (error) {
      if (error instanceof Error && error.message.includes("disposed")) {
        this.view = undefined;
        return;
      }
      throw error;
    }
  }
}
