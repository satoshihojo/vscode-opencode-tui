import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderOpenCodeSessionPanelHtml } from "../../src/opencode/session-panel-html";

describe("OpenCode session panel HTML", () => {
  it("renders session tabs as review-style rows with status, metadata, and open action", () => {
    const empty = renderOpenCodeSessionPanelHtml({ tabsByRestoreId: {}, order: [] });
    assert.match(empty, /Open Session\.\.\./);
    assert.match(empty, /data-action="open-session"/);
    assert.match(empty, /No active OpenCode session tabs/);
    assert.match(empty, /grid-template-columns: max-content minmax\(0, 1fr\)/);
    assert.match(empty, /\.current-marker \{[\s\S]*opacity: 0;[\s\S]*width: 12px;/);
    assert.match(empty, /\.open-token \{[\s\S]*background: transparent;[\s\S]*font-size: 19px;/);
    assert.match(empty, /\.open-session-item \.session-title \{[\s\S]*font-weight: 400;/);
    assert.doesNotMatch(empty, /\.item\.selected \{/);

    const html = renderOpenCodeSessionPanelHtml({
      selectedRestoreId: "restore-1",
      order: ["restore-1", "restore-2", "restore-3"],
      tabsByRestoreId: {
        "restore-1": {
          restoreId: "restore-1",
          title: "Visible Session",
          sessionId: "ses_visible",
          cwd: "/workspace",
          updated: 1712401200000,
          status: "running",
          hidden: false,
          unread: false,
        },
        "restore-2": {
          restoreId: "restore-2",
          title: "Hidden <Session>",
          status: "permission",
          hidden: true,
          unread: true,
        },
        "restore-3": {
          restoreId: "restore-3",
          title: "Ready Session",
          status: "normal",
          hidden: false,
          unread: false,
        },
      },
    });

    assert.match(html, /data-restore-id="restore-1"/);
    assert.match(html, /status-normal/);
    assert.match(html, /status-running/);
    assert.match(html, /status-permission/);
    assert.match(html, /\.status-running \.status-token \{[\s\S]*background: #4bd26a;/);
    assert.match(html, /\.status-permission \.status-token \{[\s\S]*background: #d98a2b;/);
    assert.match(html, /\.status-normal \.status-token,[\s\S]*background: transparent;/);
    assert.match(html, /data-action="close"/);
    assert.match(html, /data-action="select"/);
    assert.match(html, /aria-current="true"/);
    assert.match(html, /➣/);
    assert.match(html, /<span class="status-token" aria-label="Running"><\/span>/);
    assert.match(html, /<span class="status-token" aria-label="Waiting for permission"><\/span>/);
    assert.doesNotMatch(html, /data-action="select-dropdown"/);
    assert.doesNotMatch(html, /role="tab"/);
    assert.match(html, /ses_visible/);
    assert.match(html, /<span class="session-meta">\s*<span class="session-meta-part">ses_visible<\/span>\s*<span class="session-meta-part">workspace<\/span>\s*<span class="session-meta-part">(?:11:00|20:00) 2024-04-06<\/span>\s*<\/span>/);
    assert.match(html, /title="running - \/workspace"/);
    assert.match(html, /Hidden &lt;Session&gt;/);
    assert.match(html, /class="item status-permission hidden unread"/);
    assert.match(html, /\.item\.unread \.session-title \{[\s\S]*font-weight: 700;/);
    assert.match(html, /aria-label="Close Visible Session">×<\/button>/);
    assert.doesNotMatch(html, /Unread status updates/);
  });

  it("renders no current marker when selection was cleared", () => {
    const html = renderOpenCodeSessionPanelHtml({
      order: ["restore-1", "restore-2"],
      tabsByRestoreId: {
        "restore-1": {
          restoreId: "restore-1",
          title: "One",
          status: "normal",
          hidden: false,
          unread: false,
        },
        "restore-2": {
          restoreId: "restore-2",
          title: "Two",
          status: "running",
          hidden: false,
          unread: false,
        },
      },
    });

    assert.doesNotMatch(html, /data-action="select"[^>]*aria-current="true"/);
  });
});
