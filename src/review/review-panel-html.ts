import type { ReviewQueueItem } from "./review-queue-store";
import { normalizeSourceSessionIds } from "./review-session-metadata";

type RenderInput = {
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

export function renderReviewPanelHtml(input: RenderInput) {
  const viewItems = input.items.map((item) => toViewItem(item, input.sessionCanonicalIdsById));
  const changeCountLabel = viewItems.length === 1 ? "1 file changed" : `${viewItems.length} files changed`;
  const totals = viewItems.reduce(
    (accumulator, item) => ({
      additions: accumulator.additions + item.stats.additions,
      deletions: accumulator.deletions + item.stats.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const totalsLabel = `${totals.additions} additions and ${totals.deletions} deletions`;

  const sessionGroups = groupItemsBySession(viewItems, input.sessionTitlesById);
  const itemsMarkup =
    viewItems.length === 0
      ? `
        <div class="empty" role="status">
          <div class="empty-icon" aria-hidden="true">OK</div>
          <div class="empty-title">No pending changes</div>
        </div>`
      : sessionGroups
          .map((group) => `
          <details class="session-group" data-session-id="${escapeHtml(group.sessionId)}" open>
            <summary class="session-heading">
              <span class="session-title">${escapeHtml(group.label)}</span>
            </summary>
            <div class="session-items">
            ${group.items
              .map(
                (item) => {
                  const conflictLabel = toConflictLabel(item.sourceSessionIds, input.sessionTitlesById);
                  return `
            <article class="item change-${item.changeKind}${conflictLabel ? " multi-session" : ""}" data-item-id="${escapeHtml(item.id)}">
              <div class="actions" aria-label="Review actions for ${escapeHtml(item.displayPath)}">
                <button class="action-button keep" data-action="keep" data-item-id="${escapeHtml(item.id)}">Keep</button>
                <button class="action-button undo" data-action="undo" data-item-id="${escapeHtml(item.id)}">Undo</button>
              </div>
              <button class="file-button" data-action="open-diff" data-item-id="${escapeHtml(item.id)}" aria-label="Open diff for ${escapeHtml(item.displayPath)}">
                <span class="change-token" aria-hidden="true">${escapeHtml(item.token)}</span>
                <span class="file-name">${escapeHtml(item.fileName)}</span>
                <span class="file-directory">${escapeHtml(item.directory || "./")}</span>
              </button>
              <div class="item-meta" aria-label="${escapeHtml(toStatsLabel(item.stats))}">
                ${conflictLabel ? `<span class="session-conflict" title="${escapeHtml(conflictLabel)}" aria-label="${escapeHtml(conflictLabel)}">!</span>` : ""}
                <span class="stat additions">+${item.stats.additions}</span>
                <span class="stat deletions">-${item.stats.deletions}</span>
              </div>
            </article>`;
                },
              )
              .join("")}
            </div>
          </details>`)
          .join("");
  const hasItems = viewItems.length > 0;
  const toolbarMarkup = hasItems
    ? `<div class="toolbar">
    <div class="summary" aria-label="${escapeHtml(changeCountLabel)}">
      <span class="summary-title">${escapeHtml(changeCountLabel)}</span>
      <span class="summary-stats" aria-label="${escapeHtml(totalsLabel)}">
        <span class="stat additions">+${totals.additions}</span>
        <span class="stat deletions">-${totals.deletions}</span>
      </span>
    </div>
    <div class="bulk-actions">
      <button class="toolbar-button keep" data-action="keep-all">Keep All</button>
      <button class="toolbar-button" data-action="undo-all">Undo All</button>
    </div>
  </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    :root {
      --opencode-keep-button-background: #0e639c;
      --opencode-keep-button-hover-background: #1177bb;
      --opencode-keep-button-foreground: #ffffff;
    }
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
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font: inherit;
      background-image: none;
      line-height: 14px;
    }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    button:disabled {
      cursor: default;
      opacity: 0.45;
    }
    .toolbar {
      align-items: center;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      justify-content: flex-start;
      min-height: 28px;
      padding: 3px 8px;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .summary {
      align-items: center;
      display: flex;
      gap: 8px;
      min-width: 0;
      order: 2;
    }
    .summary-title {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .summary-stats {
      display: flex;
      gap: 6px;
      justify-content: flex-start;
    }
    .bulk-actions,
    .actions {
      align-items: center;
      display: flex;
      gap: 4px;
      justify-content: flex-start;
      white-space: nowrap;
    }
    .bulk-actions {
      order: 1;
    }
    .toolbar-button,
    .action-button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 11px;
      padding: 1px 6px;
    }
    .toolbar-button.keep,
    .action-button.keep {
      background: var(--opencode-keep-button-background);
      background-color: var(--opencode-keep-button-background);
      border-color: var(--opencode-keep-button-background);
      color: var(--opencode-keep-button-foreground);
    }
    button.toolbar-button.keep,
    button.action-button.keep,
    .bulk-actions .toolbar-button.keep,
    .actions .action-button.keep {
      background: var(--opencode-keep-button-background) !important;
      background-color: var(--opencode-keep-button-background) !important;
      border-color: var(--opencode-keep-button-background) !important;
      color: var(--opencode-keep-button-foreground) !important;
    }
    .toolbar-button:hover:not(:disabled),
    .action-button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .toolbar-button.keep:hover:not(:disabled),
    .action-button.keep:hover:not(:disabled) {
      background: var(--opencode-keep-button-hover-background);
      background-color: var(--opencode-keep-button-hover-background);
      border-color: var(--opencode-keep-button-hover-background);
    }
    button.toolbar-button.keep:hover:not(:disabled),
    button.action-button.keep:hover:not(:disabled),
    .bulk-actions .toolbar-button.keep:hover:not(:disabled),
    .actions .action-button.keep:hover:not(:disabled) {
      background: var(--opencode-keep-button-hover-background) !important;
      background-color: var(--opencode-keep-button-hover-background) !important;
      border-color: var(--opencode-keep-button-hover-background) !important;
    }
    .list {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .session-group {
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .session-group summary {
      list-style: none;
    }
    .session-group summary::-webkit-details-marker {
      display: none;
    }
    .session-heading {
      align-items: center;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      display: flex;
      gap: 6px;
      min-width: 0;
      padding: 3px 8px;
    }
    .session-heading::before {
      color: var(--vscode-descriptionForeground);
      content: '▾';
      flex: 0 0 auto;
      font-size: 10px;
      line-height: 1;
    }
    .session-group:not([open]) .session-heading::before {
      content: '▸';
    }
    .session-title {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 400;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-items {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .item {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: grid;
      gap: 6px;
      grid-template-columns: max-content minmax(0, max-content) minmax(0, 1fr);
      min-height: 18px;
      min-width: 0;
      overflow: hidden;
      padding: 1px 8px;
    }
    .item.multi-session {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 7%, transparent);
    }
    .item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .change-token {
      align-items: center;
      border-radius: 3px;
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 10px;
      font-weight: 700;
      height: 14px;
      justify-content: center;
      width: 14px;
    }
    .change-add .change-token {
      background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 18%, transparent);
      color: var(--vscode-gitDecoration-addedResourceForeground);
    }
    .change-update .change-token {
      background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground) 18%, transparent);
      color: var(--vscode-gitDecoration-modifiedResourceForeground);
    }
    .change-delete .change-token {
      background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 18%, transparent);
      color: var(--vscode-gitDecoration-deletedResourceForeground);
    }
    .change-move .change-token {
      background: color-mix(in srgb, var(--vscode-gitDecoration-renamedResourceForeground) 18%, transparent);
      color: var(--vscode-gitDecoration-renamedResourceForeground);
    }
    .file-button {
      all: unset;
      align-items: center;
      cursor: pointer;
      display: flex;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
    }
    .file-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .file-name {
      color: var(--vscode-foreground);
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-button:hover .file-name {
      color: var(--vscode-textLink-foreground);
    }
    .file-directory,
    .muted,
    .empty-copy {
      color: var(--vscode-descriptionForeground);
    }
    .file-directory {
      font-size: 11px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item-meta {
      align-items: center;
      display: flex;
      flex-wrap: nowrap;
      gap: 4px;
      justify-content: flex-start;
      overflow: visible;
      white-space: nowrap;
    }
    .stat {
      border-radius: 3px;
      font-size: 11px;
      line-height: 14px;
      padding: 0 4px;
      white-space: nowrap;
    }
    .stat {
      font-family: var(--vscode-editor-font-family);
    }
    .session-conflict {
      align-items: center;
      border-radius: 50%;
      color: var(--vscode-editorWarning-foreground);
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      height: 14px;
      justify-content: center;
      width: 14px;
    }
    .additions {
      color: var(--vscode-gitDecoration-addedResourceForeground);
    }
    .deletions {
      color: var(--vscode-gitDecoration-deletedResourceForeground);
    }
    .empty {
      align-items: center;
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 28px 16px;
      text-align: center;
    }
    .empty-icon {
      align-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 50%;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      width: 28px;
    }
    .empty-title {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
  </style>
</head>
<body>
  ${toolbarMarkup}
  <div class="list">${itemsMarkup}</div>
  <script>
    const vscode = acquireVsCodeApi();
    function readButtonStyle(selector) {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) {
        return null;
      }

      const computedStyle = getComputedStyle(button);
      return {
        backgroundColor: computedStyle.backgroundColor,
        borderColor: computedStyle.borderColor,
        color: computedStyle.color,
        backgroundImage: computedStyle.backgroundImage,
        boxShadow: computedStyle.boxShadow,
      };
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'debug-read-button-styles') {
        return;
      }

      vscode.postMessage({
        type: 'debug-button-styles',
        requestId: message.requestId,
        styles: {
          toolbarKeep: readButtonStyle('.toolbar-button.keep'),
          toolbarUndo: readButtonStyle('.bulk-actions .toolbar-button:not(.keep)'),
          itemKeep: readButtonStyle('.action-button.keep'),
          itemUndo: readButtonStyle('.action-button.undo'),
        },
      });
    });

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest('button[data-action]');
      if (button instanceof HTMLButtonElement) {
        if (button.disabled) {
          return;
        }

        const action = button.dataset.action;
        if (!action) {
          return;
        }

        vscode.postMessage({
          type: action,
          itemId: button.dataset.itemId,
        });
        return;
      }

      const item = target.closest('.item[data-item-id]');
      if (!(item instanceof HTMLElement)) {
        return;
      }

      vscode.postMessage({
        type: 'open-diff',
        itemId: item.dataset.itemId,
      });
    });
  </script>
</body>
</html>`;
}

function toViewItem(item: RenderInput["items"][number], sessionCanonicalIdsById: Record<string, string>) {
  const pathParts = splitDisplayPath(item.displayPath);
  const normalizedSourceSessionIds = normalizeSourceSessionIds(item.sourceSessionIds, sessionCanonicalIdsById);
  return {
    ...item,
    sourceSessionIds: normalizedSourceSessionIds,
    ...pathParts,
    token: toChangeToken(item.changeKind),
  };
}

function groupItemsBySession<T extends { sourceSessionIds: string[] }>(items: T[], sessionTitlesById: Record<string, string>) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const sessionId = item.sourceSessionIds.length > 1 ? "multiple" : item.sourceSessionIds[0] ?? "unknown";
    groups.set(sessionId, [...groups.get(sessionId) ?? [], item]);
  }

  return [...groups.entries()].map(([sessionId, sessionItems]) => ({
    sessionId,
    label: toSessionGroupLabel(sessionId, sessionTitlesById),
    items: sessionItems,
  }));
}

function toSessionGroupLabel(sessionId: string, sessionTitlesById: Record<string, string>) {
  if (sessionId === "multiple") {
    return "Multiple sessions";
  }
  if (sessionId === "unknown") {
    return "Unknown session";
  }

  return sessionTitlesById[sessionId]?.trim() || `Session ${sessionId}`;
}

function toConflictLabel(sourceSessionIds: string[], sessionTitlesById: Record<string, string>) {
  return sourceSessionIds.length > 1
    ? `Changed by multiple OpenCode sessions: ${sourceSessionIds.map((sessionId) => sessionTitlesById[sessionId]?.trim() || `Session ${sessionId}`).join(", ")}`
    : undefined;
}

function splitDisplayPath(displayPath: string) {
  const normalized = displayPath.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return {
      fileName: normalized,
      directory: "",
    };
  }

  return {
    fileName: normalized.slice(lastSlash + 1),
    directory: normalized.slice(0, lastSlash),
  };
}

function toStatsLabel(stats: { additions: number; deletions: number }) {
  return `${stats.additions} additions and ${stats.deletions} deletions`;
}

function toChangeToken(changeKind: ReviewQueueItem["changeKind"]) {
  switch (changeKind) {
    case "add":
      return "A";
    case "delete":
      return "D";
    case "move":
      return "R";
    case "update":
      return "M";
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
