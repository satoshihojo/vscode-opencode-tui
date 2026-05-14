import {
  selectOpenCodeSessionTab,
  type OpenCodeSessionTabState,
} from "./session-tab-status-registry";

export type OpenCodeSessionPanelActions = {
  openSessionPicker?(): void | Promise<void>;
  revealSession?(restoreId: string): void | Promise<void>;
  closeSession?(restoreId: string): void | Promise<void>;
  markSelected?(restoreId: string): void | Promise<void>;
};

export type OpenCodeSessionPanelMessage = {
  type?: string;
  restoreId?: string;
};

export function handleOpenCodeSessionPanelMessage(
  state: OpenCodeSessionTabState,
  message: OpenCodeSessionPanelMessage,
  actions: OpenCodeSessionPanelActions,
) {
  if (message.type === "open-session") {
    void Promise.resolve(actions.openSessionPicker?.()).then(undefined, () => undefined);
    return state;
  }

  if (!message.restoreId) {
    return state;
  }

  switch (message.type) {
    case "select":
    case "select-dropdown":
      void Promise.resolve(actions.markSelected?.(message.restoreId)).then(undefined, () => undefined);
      void Promise.resolve(actions.revealSession?.(message.restoreId)).then(undefined, () => undefined);
      return selectOpenCodeSessionTab(state, message.restoreId);
    case "close":
      void Promise.resolve(actions.closeSession?.(message.restoreId)).then(undefined, () => undefined);
      return state;
    default:
      return state;
  }
}
