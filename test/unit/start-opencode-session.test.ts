import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStartOpenCodeSessionCommand } from "../../src/commands/start-opencode-session";

describe("createStartOpenCodeSessionCommand", () => {
  it("starts a session without surfacing a status message", async () => {
    let startCount = 0;
    let layoutCount = 0;

    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {
          startCount += 1;
        },
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {
          layoutCount += 1;
        },
        showErrorMessage: (value) => {
          throw new Error(value);
        },
      },
    );

    await command();

    assert.equal(layoutCount, 1);
    assert.equal(startCount, 1);
  });

  it("does not start a session when waitUntilReady fails", async () => {
    let startCount = 0;
    let layoutCount = 0;
    let errorMessage = "";

    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {
          startCount += 1;
        },
        waitUntilReady: async () => {
          throw new Error("bridge unavailable");
        },
      },
      {
        prepareLayout: async () => {
          layoutCount += 1;
        },
        showErrorMessage: (value) => {
          errorMessage = value;
        },
      },
    );

    await command();

    assert.equal(layoutCount, 0);
    assert.equal(startCount, 0);
    assert.equal(errorMessage, "bridge unavailable");
  });

  it("does not start a session when layout preparation fails", async () => {
    let startCount = 0;
    let waitCount = 0;
    let errorMessage = "";

    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {
          startCount += 1;
        },
        waitUntilReady: async () => {
          waitCount += 1;
        },
      },
      {
        prepareLayout: async () => {
          throw new Error("layout unavailable");
        },
        showErrorMessage: (value) => {
          errorMessage = value;
        },
      },
    );

    await command();

    assert.equal(waitCount, 1);
    assert.equal(startCount, 0);
    assert.equal(errorMessage, "layout unavailable");
  });

  it("shows current workspace sessions before outside-of-workspace sessions", async () => {
    const quickPick = createFakeQuickPick();
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: () => quickPick,
        listSessions: () => [
          { id: "ses_other", title: "Other", directory: "/other", updated: 1712400900000 },
          { id: "ses_current", title: "Current", directory: "/workspace", updated: 1712401200000 },
          { id: "ses_missing", title: "Missing", directory: "/missing", updated: 1712400600000 },
        ],
        listArchivedSessions: () => [{ id: "ses_archived", title: "Archived", directory: "/archive", timeArchived: 123 }],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: (path) => path !== "/missing",
      },
    );

    await command();

    assert.deepEqual(quickPick.items.map((item) => item.label), [
      "$(plus) New Session",
      "$(list-unordered) All Sessions...",
      "$(archive) Archived Sessions...",
      "Current Workspace",
      "Current",
      "Outside of Workspace",
      "Other",
      "Missing Directories",
      "$(warning) Missing",
    ]);
    assert.match(quickPick.items.find((item) => item.label === "Current")?.description ?? "", /^ses_current  workspace  (?:11:00|20:00) 2024-04-06$/);
    assert.match(quickPick.items.find((item) => item.label === "Other")?.description ?? "", /^ses_other  other  (?:10:55|19:55) 2024-04-06$/);
    assert.match(quickPick.items.find((item) => item.label === "$(warning) Missing")?.description ?? "", /^ses_missing  missing  (?:10:50|19:50) 2024-04-06$/);
  });

  it("shows all sessions with separate archived partition and allows opening or forking them", async () => {
    const mainQuickPick = createFakeQuickPick();
    const allQuickPick = createFakeQuickPick();
    const starts: unknown[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: (options?: unknown) => { starts.push(options); },
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, allQuickPick),
        listSessions: () => [{ id: "ses_latest", title: "Shared", directory: "/workspace" }],
        listAllSessions: () => [
          { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 20 },
          { id: "ses_older", title: "Shared", directory: "/workspace", updated: 10 },
          { id: "ses_child", title: "Child", directory: "/workspace", parentId: "ses_latest", updated: 15 },
          { id: "ses_missing", title: "Missing", directory: "/missing", updated: 14 },
          { id: "ses_archived", title: "Archived", directory: "/archive", timeArchived: 30, updated: 12 },
          { id: "ses_archived_missing", title: "Archived Missing", directory: "/gone", timeArchived: 31, updated: 11 },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: (path) => path !== "/missing" && path !== "/gone",
      },
    );

    await command();
    await mainQuickPick.acceptLabel("$(list-unordered) All Sessions...");

    assert.deepEqual(allQuickPick.items.map((item) => item.label), [
      "Current Workspace",
      "Shared",
      "Shared",
      "Child",
      "Missing Directories",
      "$(warning) Missing",
      "Archived Sessions",
      "Archived",
      "Archived Missing",
    ]);
    assert.deepEqual(allQuickPick.items.find((item) => item.label === "Archived")?.buttons?.map((button) => button.tooltip), [
      "fork",
      "delete",
      "unarchive",
    ]);

    await allQuickPick.acceptLabel("Archived");
    await allQuickPick.triggerButton("Child", "fork");

    assert.deepEqual(starts, [
      { sessionId: "ses_archived", cwd: "/archive", sessionLabel: "Archived", updated: 12 },
      { sessionId: "ses_child", fork: true, cwd: "/workspace", sessionLabel: "Child", updated: 15 },
    ]);
  });

  it("dedupes duplicate session titles in the main picker, keeping only the latest session", async () => {
    const quickPick = createFakeQuickPick();
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: () => quickPick,
        listSessions: () => [
          { id: "ses_latest", title: "Shared", directory: "/workspace", updated: 1712401200000 },
          { id: "ses_older", title: "Shared", directory: "/workspace", updated: 1712400900000 },
          { id: "ses_other", title: "Other", directory: "/other", updated: 1712400600000 },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: () => true,
      },
    );

    await command();

    assert.deepEqual(quickPick.items.map((item) => item.label), [
      "$(plus) New Session",
      "$(list-unordered) All Sessions...",
      "$(archive) Archived Sessions...",
      "Current Workspace",
      "Shared",
      "Outside of Workspace",
      "Other",
    ]);
    assert.equal(quickPick.items.filter((item) => item.label === "Shared").length, 1);
    assert.match(quickPick.items.find((item) => item.label === "Shared")?.description ?? "", /^ses_latest  workspace  (?:11:00|20:00) 2024-04-06$/);
  });

  it("asks for a workspace folder before starting a new session in multi-root workspaces", async () => {
    const quickPick = createFakeQuickPick();
    const starts: unknown[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: (options?: unknown) => { starts.push(options); },
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: () => quickPick,
        listSessions: () => [],
        getWorkspaceFolders: () => [{ name: "a", uri: "/a" }, { name: "b", uri: "/b" }],
        showWorkspaceFolderPick: async () => ({ name: "b", uri: "/b" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
      },
    );

    await command();
    await quickPick.acceptLabel("$(plus) New Session");

    assert.deepEqual(starts, [{ cwd: "/b", terminalName: "new session" }]);
  });

  it("forks an existing session from its item button", async () => {
    const quickPick = createFakeQuickPick();
    const starts: unknown[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: (options?: unknown) => { starts.push(options); },
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: () => quickPick,
        listSessions: () => [{ id: "ses_abc", title: "Current", directory: "/workspace" }],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: () => true,
      },
    );

    await command();
    await quickPick.triggerButton("Current", "fork");

    assert.deepEqual(starts, [{ sessionId: "ses_abc", fork: true, cwd: "/workspace", sessionLabel: "Current" }]);
  });

  it("opens a preselected multi-select delete picker from a row button", async () => {
    const mainQuickPick = createFakeQuickPick();
    const deleteQuickPick = createFakeQuickPick();
    const deletedBatches: Array<{ sessionIds: string[]; cwd?: string }> = [];
    const informationMessages: string[] = [];
    let singleDeleteCalls = 0;
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, deleteQuickPick),
        listSessions: () => [{ id: "ses_parent", title: "Parent", directory: "/workspace" }],
        listAllSessions: () => [
          { id: "ses_parent", title: "Parent", directory: "/workspace" },
          { id: "ses_child", title: "Child", directory: "/workspace", parentId: "ses_parent" },
          { id: "ses_archived", title: "Archived", directory: "/archive", timeArchived: 123 },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        showInformationMessage: (message) => { informationMessages.push(message); },
        deleteSession: () => { singleDeleteCalls += 1; },
        deleteSessions: (sessionIds, cwd) => { deletedBatches.push({ sessionIds: [...sessionIds], cwd }); },
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.triggerButton("Parent", "delete");

    assert.equal(deleteQuickPick.canSelectMany, true);
    assert.deepEqual(deleteQuickPick.selectedItems.map((item) => item.label), ["Parent"]);
    assert.equal(deleteQuickPick.items[0]?.label, "Parent");
    assert.deepEqual(deleteQuickPick.items.map((item) => item.label), [
      "Parent",
      "Current Workspace",
      "Child",
      "Outside of Workspace",
      "Archived",
    ]);

    await deleteQuickPick.acceptLabels(["Parent", "Child"]);

    assert.deepEqual(deletedBatches, [
      { sessionIds: ["ses_parent", "ses_child"], cwd: undefined },
    ]);
    assert.equal(singleDeleteCalls, 0);
    assert.deepEqual(informationMessages, ["Deleted 2 OpenCode sessions"]);
  });

  it("falls back to deleting selected sessions one by one when bulk delete is unavailable", async () => {
    const mainQuickPick = createFakeQuickPick();
    const deleteQuickPick = createFakeQuickPick();
    const deleted: Array<{ sessionId: string; cwd?: string }> = [];
    const informationMessages: string[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, deleteQuickPick),
        listSessions: () => [{ id: "ses_parent", title: "Parent", directory: "/workspace" }],
        listAllSessions: () => [
          { id: "ses_parent", title: "Parent", directory: "/workspace" },
          { id: "ses_child", title: "Child", directory: "/workspace", parentId: "ses_parent" },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        showInformationMessage: (message) => { informationMessages.push(message); },
        deleteSession: (sessionId, cwd) => { deleted.push({ sessionId, cwd }); },
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.triggerButton("Parent", "delete");
    await deleteQuickPick.acceptLabels(["Parent", "Child"]);

    assert.deepEqual(deleted, [
      { sessionId: "ses_parent", cwd: undefined },
      { sessionId: "ses_child", cwd: undefined },
    ]);
    assert.deepEqual(informationMessages, ["Deleted 2 OpenCode sessions"]);
  });

  it("opens archive and unarchive management pickers from row buttons with preselection", async () => {
    const mainQuickPick = createFakeQuickPick();
    const archiveQuickPick = createFakeQuickPick();
    const archivedQuickPick = createFakeQuickPick();
    const unarchiveQuickPick = createFakeQuickPick();
    const archivedBatches: string[][] = [];
    const unarchivedBatches: string[][] = [];
    const informationMessages: string[] = [];
    let singleArchiveCalls = 0;
    let singleUnarchiveCalls = 0;
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, archiveQuickPick, archivedQuickPick, unarchiveQuickPick),
        listSessions: () => [{ id: "ses_abc", title: "Current", directory: "/workspace" }],
        listAllSessions: () => [{ id: "ses_abc", title: "Current", directory: "/workspace" }],
        listArchivedSessions: () => [{ id: "ses_archived", title: "Archived", directory: "/workspace", timeArchived: 123 }],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWarningMessage: async () => undefined,
        showInformationMessage: (message) => { informationMessages.push(message); },
        deleteSession: () => {},
        archiveSession: () => { singleArchiveCalls += 1; },
        archiveSessions: (sessionIds) => { archivedBatches.push([...sessionIds]); },
        unarchiveSession: () => { singleUnarchiveCalls += 1; },
        unarchiveSessions: (sessionIds) => { unarchivedBatches.push([...sessionIds]); },
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.triggerButton("Current", "archive");
    assert.equal(archiveQuickPick.canSelectMany, true);
    assert.deepEqual(archiveQuickPick.selectedItems.map((item) => item.label), ["Current"]);
    await archiveQuickPick.acceptLabels(["Current"]);

    await mainQuickPick.acceptLabel("$(archive) Archived Sessions...");
    await archivedQuickPick.triggerButton("Archived", "unarchive");
    assert.equal(unarchiveQuickPick.canSelectMany, true);
    assert.deepEqual(unarchiveQuickPick.selectedItems.map((item) => item.label), ["Archived"]);
    await unarchiveQuickPick.acceptLabels(["Archived"]);

    assert.deepEqual(archivedBatches, [["ses_abc"]]);
    assert.deepEqual(unarchivedBatches, [["ses_archived"]]);
    assert.equal(singleArchiveCalls, 0);
    assert.equal(singleUnarchiveCalls, 0);
    assert.deepEqual(informationMessages, ["Archived 1 OpenCode session", "Unarchived 1 OpenCode session"]);
  });

  it("surfaces bulk archive failures without showing a success notification", async () => {
    const mainQuickPick = createFakeQuickPick();
    const archiveQuickPick = createFakeQuickPick();
    const errorMessages: string[] = [];
    const informationMessages: string[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { errorMessages.push(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, archiveQuickPick),
        listSessions: () => [{ id: "ses_abc", title: "Current", directory: "/workspace" }],
        listAllSessions: () => [{ id: "ses_abc", title: "Current", directory: "/workspace" }],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWarningMessage: async () => undefined,
        showInformationMessage: (message) => { informationMessages.push(message); },
        deleteSession: () => {},
        archiveSessions: async () => {
          throw new Error("boom");
        },
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.triggerButton("Current", "archive");
    await archiveQuickPick.acceptLabels(["Current"]);

    assert.deepEqual(errorMessages, ["boom"]);
    assert.deepEqual(informationMessages, []);
    assert.equal(archiveQuickPick.busy, false);
  });

  it("includes child sessions in the archive management picker", async () => {
    const mainQuickPick = createFakeQuickPick();
    const archiveQuickPick = createFakeQuickPick();
    const archived: string[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, archiveQuickPick),
        listSessions: () => [{ id: "ses_parent", title: "Parent", directory: "/workspace" }],
        listAllSessions: () => [
          { id: "ses_parent", title: "Parent", directory: "/workspace" },
          { id: "ses_child", title: "Child", directory: "/workspace", parentId: "ses_parent" },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: (sessionId) => { archived.push(sessionId); },
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.triggerButton("Parent", "archive");

    assert.equal(archiveQuickPick.items[0]?.label, "Parent");
    assert.deepEqual(archiveQuickPick.items.map((item) => item.label), [
      "Parent",
      "Current Workspace",
      "Child",
    ]);

    await archiveQuickPick.acceptLabels(["Child"]);

    assert.deepEqual(archived, ["ses_child"]);
  });

  it("shows archived sessions with the same row buttons", async () => {
    const mainQuickPick = createFakeQuickPick();
    const archivedQuickPick = createFakeQuickPick();
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: () => {},
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: createFakeQuickPickFactory(mainQuickPick, archivedQuickPick),
        listSessions: () => [],
        listArchivedSessions: () => [
          { id: "ses_current_archived", title: "Current Archived", directory: "/workspace", timeArchived: 1 },
          { id: "ses_other_archived", title: "Other Archived", directory: "/other", timeArchived: 2 },
        ],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async () => undefined,
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: () => true,
      },
    );

    await command();
    await mainQuickPick.acceptLabel("$(archive) Archived Sessions...");

    assert.deepEqual(archivedQuickPick.items.map((item) => item.label), [
      "Current Workspace",
      "Current Archived",
      "Outside of Workspace",
      "Other Archived",
    ]);
    assert.deepEqual(archivedQuickPick.items.find((item) => item.label === "Current Archived")?.buttons?.map((button) => button.tooltip), [
      "fork",
      "delete",
      "unarchive",
    ]);
  });

  it("warns about missing-directory sessions but still opens them", async () => {
    const quickPick = createFakeQuickPick();
    const starts: unknown[] = [];
    const warnings: string[] = [];
    const command = createStartOpenCodeSessionCommand(
      {
        startSession: (options?: unknown) => { starts.push(options); },
        waitUntilReady: async () => {},
      },
      {
        prepareLayout: async () => {},
        showErrorMessage: (value) => { throw new Error(value); },
        createQuickPick: () => quickPick,
        listSessions: () => [{ id: "ses_missing", title: "Missing", directory: "/missing" }],
        getWorkspaceFolders: () => [{ name: "workspace", uri: "/workspace" }],
        showWorkspaceFolderPick: async () => ({ name: "workspace", uri: "/workspace" }),
        showWarningMessage: async (message) => { warnings.push(message); return undefined; },
        deleteSession: () => {},
        archiveSession: () => {},
        unarchiveSession: () => {},
        pathExists: (path) => path !== "/missing",
      },
    );

    await command();
    await quickPick.acceptLabel("$(warning) Missing");

    assert.ok(starts.length >= 1, "should start at least one session");
    assert.ok(warnings.some(w => /directory/.test(w) || /accessible/.test(w)), "should show a warning about the directory");
  });
});

type FakeQuickPickItem = {
  label: string;
  kind?: number;
  description?: string;
  detail?: string;
  buttons?: Array<{ iconPath?: unknown; tooltip?: string }>;
  session?: { id: string };
};

function createFakeQuickPickFactory(...quickPicks: ReturnType<typeof createFakeQuickPick>[]) {
  let index = 0;
  return () => quickPicks[index++] ?? createFakeQuickPick();
}

function createFakeQuickPick() {
  let acceptHandler: (() => void) | undefined;
  let buttonHandler: ((event: { item: FakeQuickPickItem; button: { tooltip?: string } }) => void | Promise<void>) | undefined;
  const quickPick = {
    items: [] as FakeQuickPickItem[],
    selectedItems: [] as FakeQuickPickItem[],
    busy: false,
    canSelectMany: false,
    placeholder: "",
    title: "",
    show() {},
    hide() {},
    dispose() {},
    onDidAccept(handler: () => void) { acceptHandler = handler; return { dispose() {} }; },
    onDidTriggerItemButton(handler: (event: { item: FakeQuickPickItem; button: { tooltip?: string } }) => void | Promise<void>) {
      buttonHandler = handler;
      return { dispose() {} };
    },
    onDidHide() { return { dispose() {} }; },
    async acceptLabel(label: string) {
      const item = quickPick.items.find((candidate) => candidate.label === label);
      assert.ok(item, `missing item ${label}`);
      quickPick.selectedItems = [item];
      await Promise.resolve(acceptHandler?.());
      await new Promise((resolve) => setImmediate(resolve));
    },
    async acceptLabels(labels: string[]) {
      const items = labels.map((label) => {
        const item = quickPick.items.find((candidate) => candidate.label === label);
        assert.ok(item, `missing item ${label}`);
        return item;
      });
      quickPick.selectedItems = items;
      await Promise.resolve(acceptHandler?.());
      await new Promise((resolve) => setImmediate(resolve));
    },
    async triggerButton(label: string, tooltipIncludes: string) {
      const item = quickPick.items.find((candidate) => candidate.label === label);
      assert.ok(item, `missing item ${label}`);
      const button = item.buttons?.find((candidate) => candidate.tooltip?.includes(tooltipIncludes));
      assert.ok(button, `missing button ${tooltipIncludes}`);
      await Promise.resolve(buttonHandler?.({ item, button }));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return quickPick;
}
