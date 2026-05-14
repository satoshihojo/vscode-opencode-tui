import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewQueueStore } from "../../src/review/review-queue-store";
import { ReviewQueueManager } from "../../src/review/review-queue-manager";

describe("ReviewQueueManager", () => {
  it("opens a diff for a queued item", async () => {
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

    let openedItemId = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async (itemId) => {
        openedItemId = itemId;
      },
      readTargetState: async () => ({ exists: true, text: "const value = 2;\n" }),
      writeText: async () => true,
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    await manager.openDiff("file:///workspace/src/example.ts");

    assert.equal(openedItemId, "file:///workspace/src/example.ts");
  });

  it("undoes a queued item when the live text still matches the queued snapshot", async () => {
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

    let restoredText = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 2;\n" }),
      writeText: async (_uri, text) => {
        restoredText = text;
        return true;
      },
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "undone");
    assert.equal(restoredText, "const value = 1;\n");
    assert.equal(store.list().length, 0);
  });

  it("refuses to undo when the live text no longer matches the queued snapshot", async () => {
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

    let warningMessage = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 99;\n" }),
      writeText: async () => true,
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: (message) => {
        warningMessage = message;
      },
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "conflict");
    assert.match(warningMessage, /changed since it was queued/i);
    assert.equal(store.list().length, 1);
  });

  it("allows undo when only Windows line endings differ from the queued snapshot", async () => {
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

    let restoredText = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 2;\r\n" }),
      writeText: async (_uri, text) => {
        restoredText = text;
        return true;
      },
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "undone");
    assert.equal(restoredText, "const value = 1;\n");
    assert.equal(store.list().length, 0);
  });

  it("keeps the queued item when revert application fails", async () => {
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

    let warningMessage = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 2;\n" }),
      writeText: async () => false,
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: (message) => {
        warningMessage = message;
      },
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "failed");
    assert.match(warningMessage, /failed to restore/i);
    assert.equal(store.list().length, 1);
  });

  it("does not save when the file was already dirty before the queued apply", async () => {
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
      saved: false,
      wasDirtyBeforeApply: true,
    });

    let saveCalls = 0;
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 2;\n" }),
      writeText: async () => true,
      deleteFile: async () => true,
      saveTarget: async () => {
        saveCalls += 1;
        return true;
      },
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "undone");
    assert.equal(saveCalls, 0);
  });

  it("updates the queued current snapshot when restore succeeds but save fails", async () => {
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

    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "const value = 2;\n" }),
      writeText: async () => true,
      deleteFile: async () => true,
      saveTarget: async () => false,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/example.ts");

    assert.equal(result, "failed");
    assert.equal(store.get("file:///workspace/src/example.ts")?.currentText, "const value = 1;\n");
    assert.equal(store.get("file:///workspace/src/example.ts")?.saved, false);
  });

  it("undoes a queued add by deleting the created file", async () => {
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

    let deletedUri = "";
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: true, text: "export const value = 1;\n" }),
      writeText: async () => true,
      deleteFile: async (targetUri) => {
        deletedUri = targetUri;
        return true;
      },
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/new.ts");

    assert.equal(result, "undone");
    assert.equal(deletedUri, "file:///workspace/src/new.ts");
  });

  it("undoes a queued delete by recreating the file", async () => {
    const store = new ReviewQueueStore();
    store.upsert({
      targetUri: "file:///workspace/src/deleted.ts",
      displayPath: "src/deleted.ts",
      changeKind: "delete",
      originalText: "export const value = 1;\n",
      currentText: "",
      currentExists: false,
      languageId: "typescript",
      targetKind: "existing",
      saved: false,
      wasDirtyBeforeApply: false,
    });

    let written: { uri: string; text: string } | undefined;
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async () => ({ exists: false, text: "" }),
      writeText: async (targetUri, text) => {
        written = { uri: targetUri, text };
        return true;
      },
      deleteFile: async () => true,
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/deleted.ts");

    assert.equal(result, "undone");
    assert.deepEqual(written, {
      uri: "file:///workspace/src/deleted.ts",
      text: "export const value = 1;\n",
    });
  });

  it("undoes a queued move by restoring the source path and deleting the destination", async () => {
    const store = new ReviewQueueStore();
    store.upsert({
      targetUri: "file:///workspace/src/renamed.ts",
      displayPath: "src/renamed.ts",
      changeKind: "move",
      originalText: "export const value = 1;\n",
      currentText: "export const value = 2;\n",
      currentExists: true,
      sourceUri: "file:///workspace/src/original.ts",
      languageId: "typescript",
      targetKind: "existing",
      saved: true,
      wasDirtyBeforeApply: false,
    });

    const writes: Array<{ uri: string; text: string }> = [];
    const deletes: string[] = [];
    const manager = new ReviewQueueManager(store, {
      openDiff: async () => {},
      readTargetState: async (targetUri) => {
        if (targetUri === "file:///workspace/src/renamed.ts") {
          return { exists: true, text: "export const value = 2;\n" };
        }

        return { exists: false, text: "" };
      },
      writeText: async (targetUri, text) => {
        writes.push({ uri: targetUri, text });
        return true;
      },
      deleteFile: async (targetUri) => {
        deletes.push(targetUri);
        return true;
      },
      saveTarget: async () => true,
      showWarningMessage: () => {},
    });

    const result = await manager.undo("file:///workspace/src/renamed.ts");

    assert.equal(result, "undone");
    assert.deepEqual(writes, [{
      uri: "file:///workspace/src/original.ts",
      text: "export const value = 1;\n",
    }]);
    assert.deepEqual(deletes, ["file:///workspace/src/renamed.ts"]);
  });
});
