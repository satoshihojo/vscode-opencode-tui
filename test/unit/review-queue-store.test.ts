import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewQueueStore } from "../../src/review/review-queue-store";

describe("ReviewQueueStore", () => {
  it("queues a new review item", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 1;\n",
      currentText: "const value = 2;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    const items = store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.targetUri, "file:///workspace/src/example.ts");
    assert.equal(items[0]?.saved, true);
    assert.deepEqual(items[0]?.stats, { additions: 1, deletions: 1 });
  });

  it("merges repeated changes for the same file and preserves the original snapshot", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 1;\n",
      currentText: "const value = 2;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 2;\n",
      currentText: "const value = 3;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: true,
    });

    const item = store.get("file:///workspace/src/example.ts");
    assert.equal(item?.originalText, "const value = 1;\n");
    assert.equal(item?.currentText, "const value = 3;\n");
    assert.equal(item?.wasDirtyBeforeApply, false);
    assert.equal(item?.revision, 2);
    assert.deepEqual(item?.stats, { additions: 1, deletions: 1 });
  });

  it("tracks source session ids once per changed file", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 1;\n",
      currentText: "const value = 2;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
      sourceSessionId: "ses_alpha",
    });

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 2;\n",
      currentText: "const value = 3;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
      sourceSessionId: "ses_beta",
    });

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 3;\n",
      currentText: "const value = 4;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
      sourceSessionId: "ses_alpha",
    });

    assert.deepEqual(store.get("file:///workspace/src/example.ts")?.sourceSessionIds, ["ses_alpha", "ses_beta"]);
  });

  it("removes items with keep and keepAll", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/a.ts",
      displayPath: "src/a.ts",
      changeKind: "update",
      originalText: "a\n",
      currentText: "aa\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });
    store.upsert({
      targetUri: "file:///workspace/src/b.ts",
      displayPath: "src/b.ts",
      changeKind: "update",
      originalText: "b\n",
      currentText: "bb\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    store.keep("file:///workspace/src/a.ts");
    assert.equal(store.list().length, 1);

    store.keepAll();
    assert.equal(store.list().length, 0);
  });

  it("updates the current snapshot without dropping the queue item", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/example.ts",
      displayPath: "src/example.ts",
      changeKind: "update",
      originalText: "const value = 1;\n",
      currentText: "const value = 2;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    store.updateCurrentText("file:///workspace/src/example.ts", "const value = 1;\n", false);

    const item = store.get("file:///workspace/src/example.ts");
    assert.equal(item?.currentText, "const value = 1;\n");
    assert.equal(item?.saved, false);
    assert.deepEqual(item?.stats, { additions: 0, deletions: 0 });
  });

  it("hydrates from persisted items", () => {
    const store = new ReviewQueueStore([
      {
        id: "file:///workspace/src/example.ts",
        targetUri: "file:///workspace/src/example.ts",
        displayPath: "src/example.ts",
        changeKind: "update",
        originalText: "const value = 1;\n",
        currentText: "const value = 2;\n",
        currentExists: true,
        languageId: "typescript",
        targetKind: "existing",
        saved: true,
        wasDirtyBeforeApply: false,
        revision: 1,
        sourceSessionIds: [],
        stats: { additions: 1, deletions: 1 },
      },
    ]);

    assert.equal(store.list().length, 1);
    assert.equal(store.get("file:///workspace/src/example.ts")?.displayPath, "src/example.ts");
  });

  it("drops a queued add when the file is deleted before keep", () => {
    const store = new ReviewQueueStore();

    store.upsert({
      targetUri: "file:///workspace/src/new.ts",
      displayPath: "src/new.ts",
      changeKind: "add",
      originalText: "",
      currentText: "export const value = 1;\n",
      currentExists: true,
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    const result = store.upsert({
      targetUri: "file:///workspace/src/new.ts",
      displayPath: "src/new.ts",
      changeKind: "delete",
      originalText: "export const value = 1;\n",
      currentText: "",
      currentExists: false,
      languageId: "typescript",
      targetKind: "existing",
      saved: false,
      wasDirtyBeforeApply: false,
    });

    assert.equal(result, undefined);
    assert.equal(store.list().length, 0);
  });
});
