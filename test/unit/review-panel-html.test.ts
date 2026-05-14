import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderReviewPanelHtml } from "../../src/review/review-panel-html";

describe("renderReviewPanelHtml", () => {
  it("renders keep/undo controls for each file and global actions", () => {
    const html = renderReviewPanelHtml({
      sessionTitlesById: {},
      sessionCanonicalIdsById: {},
      items: [
        {
          id: "file:///workspace/src/example.ts",
          displayPath: "src/example.ts",
          targetUri: "file:///workspace/src/example.ts",
          saved: true,
          revision: 2,
          targetKind: "existing",
          changeKind: "update",
          originalText: "export const value = 1;\n",
          currentText: "export const value = 2;\nexport const next = 3;\n",
          currentExists: true,
          languageId: "typescript",
          sourceSessionIds: [],
          stats: { additions: 2, deletions: 1 },
        },
      ],
    });

    assert.match(html, /Keep All/);
    assert.match(html, /Undo All/);
    assert.match(html, />1 file changed<\/span>/);
    assert.doesNotMatch(html, /summary-count/);
    assert.match(html, /src\/example\.ts/);
    assert.match(html, /data-action="keep"/);
    assert.match(html, /data-action="undo"/);
    assert.match(html, /data-action="open-diff"/);
    assert.match(html, /\+2/);
    assert.match(html, /-1/);
    assert.doesNotMatch(html, /Modified/);
    assert.doesNotMatch(html, /Saved/);
    assert.doesNotMatch(html, /rev2/);
    assert.match(html, /grid-template-columns: max-content minmax\(0, max-content\) minmax\(0, 1fr\)/);
    assert.match(html, /<div class="actions"[\s\S]*<button class="file-button"/);
    assert.match(html, /<span class="file-directory">src<\/span>[\s\S]*<div class="item-meta"/);
    assert.match(html, /\.file-button \{[\s\S]*align-items: center;[\s\S]*overflow: hidden;[\s\S]*white-space: nowrap;/);
    assert.match(html, /\.actions \{[\s\S]*justify-content: flex-start;[\s\S]*white-space: nowrap;/);
    assert.match(html, /\.item-meta \{[\s\S]*justify-content: flex-start;[\s\S]*white-space: nowrap;/);
    assert.match(html, /<button class="toolbar-button keep" data-action="keep-all"/);
    assert.match(html, /--opencode-keep-button-background: #0e639c;/);
    assert.match(html, /\.toolbar-button\.keep,[\s\S]*\.action-button\.keep \{[\s\S]*background: var\(--opencode-keep-button-background\);/);
    assert.match(html, /button\.toolbar-button\.keep,[\s\S]*\.actions \.action-button\.keep \{[\s\S]*border-color: var\(--opencode-keep-button-background\) !important;/);
    assert.match(html, /const item = target\.closest\('\.item\[data-item-id\]'\);[\s\S]*type: 'open-diff'/);
  });

  it("renders an empty state when no pending changes exist", () => {
    const html = renderReviewPanelHtml({ sessionTitlesById: {}, sessionCanonicalIdsById: {}, items: [] });

    assert.match(html, /No pending changes/);
    assert.doesNotMatch(html, /Keep All/);
    assert.doesNotMatch(html, /Undo All/);
    assert.doesNotMatch(html, /Pending Changes/);
    assert.doesNotMatch(html, /Review<\/span>/);
  });

  it("groups changed files by source session and marks shared files", () => {
    const html = renderReviewPanelHtml({
      sessionTitlesById: {
        ses_alpha: "Parent implementation session",
        ses_beta: "Queue diff fixes",
      },
      sessionCanonicalIdsById: {},
      items: [
        {
          id: "file:///workspace/src/shared.ts",
          displayPath: "src/shared.ts",
          targetUri: "file:///workspace/src/shared.ts",
          saved: true,
          revision: 2,
          targetKind: "existing",
          changeKind: "update",
          originalText: "export const value = 1;\n",
          currentText: "export const value = 2;\n",
          currentExists: true,
          languageId: "typescript",
          sourceSessionIds: ["ses_alpha", "ses_beta"],
          stats: { additions: 1, deletions: 1 },
        },
        {
          id: "file:///workspace/src/solo.ts",
          displayPath: "src/solo.ts",
          targetUri: "file:///workspace/src/solo.ts",
          saved: true,
          revision: 1,
          targetKind: "existing",
          changeKind: "update",
          originalText: "export const solo = 1;\n",
          currentText: "export const solo = 2;\n",
          currentExists: true,
          languageId: "typescript",
          sourceSessionIds: ["ses_beta"],
          stats: { additions: 1, deletions: 1 },
        },
      ],
    });

    assert.match(html, /<details class="session-group" data-session-id="multiple" open>/);
    assert.match(html, /<details class="session-group" data-session-id="ses_beta" open>/);
    assert.match(html, /Multiple sessions/);
    assert.match(html, /Queue diff fixes/);
    assert.doesNotMatch(html, />2 files</);
    assert.match(html, /background: transparent;/);
    assert.match(html, /font-weight: 400;/);
    assert.match(html, /color: var\(--vscode-descriptionForeground\);/);
    assert.match(html, /class="session-conflict" title="Changed by multiple OpenCode sessions: Parent implementation session, Queue diff fixes"/);
    assert.match(html, /aria-label="Changed by multiple OpenCode sessions: Parent implementation session, Queue diff fixes"/);
    assert.equal((html.match(/<article class="item change-update multi-session" data-item-id="file:\/\/\/workspace\/src\/shared\.ts">/g) ?? []).length, 1);
  });

  it("collapses parent and child sessions into the parent group without a conflict badge", () => {
    const html = renderReviewPanelHtml({
      sessionTitlesById: {
        ses_parent: "Opencode plugin implementation with git setup",
      },
      sessionCanonicalIdsById: {
        ses_parent: "ses_parent",
        ses_child: "ses_parent",
      },
      items: [
        {
          id: "file:///workspace/src/shared.ts",
          displayPath: "src/shared.ts",
          targetUri: "file:///workspace/src/shared.ts",
          saved: true,
          revision: 2,
          targetKind: "existing",
          changeKind: "update",
          originalText: "export const value = 1;\n",
          currentText: "export const value = 2;\n",
          currentExists: true,
          languageId: "typescript",
          sourceSessionIds: ["ses_parent", "ses_child"],
          stats: { additions: 1, deletions: 1 },
        },
      ],
    });

    assert.match(html, /<details class="session-group" data-session-id="ses_parent" open>/);
    assert.match(html, /Opencode plugin implementation with git setup/);
    assert.doesNotMatch(html, /Multiple sessions/);
    assert.doesNotMatch(html, /<span class="session-conflict"/);
    assert.match(html, /<article class="item change-update" data-item-id="file:\/\/\/workspace\/src\/shared\.ts">/);
    assert.doesNotMatch(html, /<article class="item change-update multi-session" data-item-id="file:\/\/\/workspace\/src\/shared\.ts">/);
  });
});
