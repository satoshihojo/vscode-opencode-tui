import type { OpenCodeSessionTab, OpenCodeSessionTabState, OpenCodeSessionTabStatus } from "./session-tab-status-registry";
import { formatSessionUpdatedLabel, readSessionDirectoryLabel } from "./session-display";

export function renderOpenCodeSessionPanelHtml(state: OpenCodeSessionTabState) {
  const tabs = state.order.flatMap((restoreId) => state.tabsByRestoreId[restoreId] ? [state.tabsByRestoreId[restoreId]] : []);
  const selectedRestoreId = state.selectedRestoreId;
  const rowsMarkup = [renderOpenSessionRow(), ...tabs.map((tab) => renderSessionRow(tab, tab.restoreId === selectedRestoreId))].join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 0;
    }
    button {
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid transparent;
      border-radius: 2px;
      box-shadow: none;
      cursor: pointer;
      font: inherit;
      line-height: 14px;
    }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .list {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .item {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: grid;
      gap: 6px;
      grid-template-columns: max-content minmax(0, 1fr);
      min-height: 20px;
      min-width: 0;
      overflow: hidden;
      padding: 1px 8px;
    }
    .item:hover { background: var(--vscode-list-hoverBackground); }
    .item.hidden { opacity: 0.86; }
    .session-button {
      all: unset;
      align-items: center;
      cursor: pointer;
      display: flex;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
    }
    .session-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .current-marker {
      color: var(--vscode-foreground);
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 12px;
      justify-content: center;
      opacity: 0;
      width: 12px;
    }
    .session-button[aria-current="true"] .current-marker {
      opacity: 1;
    }
    .status-spacer {
      display: inline-flex;
      flex: 0 0 auto;
      width: 8px;
    }
    .session-title {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item.unread .session-title {
      color: var(--vscode-foreground);
      font-weight: 700;
    }
    .session-button:hover .session-title { color: var(--vscode-textLink-foreground); }
    .session-meta {
      align-items: center;
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      font-size: 11px;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
    }
    .session-meta-part {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-token {
      align-items: center;
      border-radius: 50%;
      display: inline-flex;
      flex: 0 0 auto;
      height: 8px;
      justify-content: center;
      width: 8px;
    }
    .status-normal .status-token,
    .status-idle .status-token { background: transparent; }
    .status-running .status-token { background: #4bd26a; }
    .status-permission .status-token { background: #d98a2b; }
    .status-error .status-token { background: var(--vscode-errorForeground); }
    .open-token {
      background: transparent;
      border-radius: 0;
      color: var(--vscode-foreground);
      font-size: 19px;
      font-weight: 400;
      height: 18px;
      line-height: 18px;
      justify-content: center;
      width: 8px;
    }
    .close-button {
      align-items: center;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      font-size: 13px;
      justify-content: center;
      min-height: 18px;
      min-width: 18px;
      padding: 0;
      white-space: nowrap;
    }
    .close-button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .close-spacer {
      display: inline-block;
      min-height: 18px;
      min-width: 18px;
    }
    .open-session-item .session-title { color: var(--vscode-foreground); font-weight: 400; }
    .empty-note {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 8px;
    }
  </style>
</head>
<body>
  <main class="list" aria-label="OpenCode session tabs">
    ${rowsMarkup}
    ${tabs.length === 0 ? `<div class="empty-note" role="status">No active OpenCode session tabs.</div>` : ""}
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionTarget = target.closest('[data-action]');
      if (!actionTarget) return;
      const restoreId = actionTarget.getAttribute('data-restore-id') || actionTarget.closest('[data-restore-id]')?.getAttribute('data-restore-id');
      vscode.postMessage({ type: actionTarget.getAttribute('data-action'), restoreId });
    });
  </script>
</body>
</html>`;
}

function renderOpenSessionRow() {
  return `<article class="item open-session-item">
    <span class="close-spacer" aria-hidden="true"></span>
    <button class="session-button" data-action="open-session" aria-label="Open OpenCode session manager">
      <span class="current-marker" aria-hidden="true"></span>
      <span class="status-token open-token" aria-hidden="true">+</span>
      <span class="session-title">Open Session...</span>
      <span class="session-meta">Create, resume, archive, or delete sessions</span>
    </button>
  </article>`;
}

function renderSessionRow(tab: OpenCodeSessionTab, selected: boolean) {
  const classes = ["item", toStatusClass(tab.status), tab.hidden ? "hidden" : "", tab.unread ? "unread" : ""].filter(Boolean).join(" ");
  const currentAttribute = selected ? ` aria-current="true"` : "";
  const tooltip = toStatusTooltip(tab.status, tab.cwd);
  const meta = renderSessionMeta(tab);
  return `<article class="${classes}" data-restore-id="${escapeHtml(tab.restoreId)}">
    <button class="close-button" data-action="close" data-restore-id="${escapeHtml(tab.restoreId)}" aria-label="Close ${escapeHtml(tab.title)}">×</button>
    <button class="session-button" data-action="select" data-restore-id="${escapeHtml(tab.restoreId)}" aria-label="Select ${escapeHtml(tab.title)}"${currentAttribute} title="${escapeHtml(tooltip)}">
      ${rendersStatusDot(tab.status)
    ? `<span class="status-token" aria-label="${escapeHtml(toStatusLabel(tab.status))}">${escapeHtml(toStatusToken(tab.status))}</span>`
    : `<span class="status-spacer" aria-hidden="true"></span>`}
      <span class="current-marker" aria-hidden="true">➣</span>
      <span class="session-title">${escapeHtml(tab.title)}</span>
      ${meta}
    </button>
  </article>`;
}

function renderSessionMeta(tab: OpenCodeSessionTab) {
  const parts = [
    tab.sessionId?.trim()
      ? `<span class="session-meta-part">${escapeHtml(tab.sessionId.trim())}</span>`
      : "",
    readSessionDirectoryLabel(tab.cwd)
      ? `<span class="session-meta-part">${escapeHtml(readSessionDirectoryLabel(tab.cwd) ?? "")}</span>`
      : "",
    formatSessionUpdatedLabel(tab.updated)
      ? `<span class="session-meta-part">${escapeHtml(formatSessionUpdatedLabel(tab.updated) ?? "")}</span>`
      : "",
  ].filter(Boolean);

  if (parts.length === 0) {
    return `<span class="session-meta"><span class="session-meta-part">${escapeHtml(tab.restoreId)}</span></span>`;
  }

  return `<span class="session-meta">${parts.join("")}</span>`;
}

function toStatusClass(status: OpenCodeSessionTabStatus) {
  return `status-${status}`;
}

function toStatusToken(status: OpenCodeSessionTabStatus) {
  void status;
  return "";
}

function rendersStatusDot(status: OpenCodeSessionTabStatus) {
  return status === "running" || status === "permission" || status === "error";
}

function toStatusLabel(status: OpenCodeSessionTabStatus) {
  switch (status) {
    case "running": return "Running";
    case "idle": return "Idle";
    case "permission": return "Waiting for permission";
    case "error": return "Error";
    default: return "Ready";
  }
}

function toStatusTooltip(status: OpenCodeSessionTabStatus, cwd?: string) {
  const pathLabel = cwd?.trim() || "unknown path";
  switch (status) {
    case "running": return `running - ${pathLabel}`;
    case "idle": return `idle - ${pathLabel}`;
    case "permission": return `permission - ${pathLabel}`;
    case "error": return `error - ${pathLabel}`;
    default: return `ready - ${pathLabel}`;
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
