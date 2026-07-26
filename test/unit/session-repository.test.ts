import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeSessionRepository, runCommandAsync } from "../../src/opencode/session-repository";

type RecordedWrite = {
  databasePath: string;
  query: string;
  params: unknown[];
};

type RecordedExec = {
  databasePath: string;
  query: string;
};

type RecordedOpen = {
  databasePath: string;
  options: unknown;
};

function normalizeOpenCodeCommand(command: string, args: readonly string[]) {
  if (command !== "cmd.exe" || args[0] !== "/d" || args[1] !== "/s" || args[2] !== "/c") {
    return command;
  }

  const executable = args[3];
  if (typeof executable !== "string") {
    return command;
  }

  return executable.toLowerCase() === "opencode.cmd" ? "opencode" : executable;
}

function normalizeOpenCodeArgs(args: readonly string[]) {
  if (args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
    return [...args.slice(4)];
  }

  return [...args];
}

function isOpenCodeDbPathArgs(args: readonly string[]) {
  const normalizedArgs = normalizeOpenCodeArgs(args);
  return normalizedArgs[0] === "db" && normalizedArgs[1] === "path";
}

function normalizeRecordedCall(call: { command: string; args: string[]; cwd?: string }) {
  return {
    ...call,
    command: normalizeOpenCodeCommand(call.command, call.args),
    args: normalizeOpenCodeArgs(call.args),
  };
}

describe("OpenCodeSessionRepository", () => {
  it("parses opencode session list json", () => {
    const repository = new OpenCodeSessionRepository({
      run: (command, args, options) => {
        assert.equal(normalizeOpenCodeCommand(command, args), "opencode");
        assert.deepEqual(normalizeOpenCodeArgs(args), ["db", "select id, project_id, parent_id, title, directory, time_created, time_updated, time_archived from session where time_archived is null and parent_id is null order by time_updated desc limit 100", "--format", "json"]);
        assert.equal(options.cwd, "/workspace");
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "ses_1", title: "First", directory: "/workspace", time_updated: 10, parent_id: "ses_parent", time_archived: null },
            { id: "bad", title: 123, directory: null },
          ]),
          stderr: "",
        };
      },
    });

    const sessions = repository.listSessions("/workspace");

    assert.deepEqual(sessions, [
      { id: "ses_1", title: "First", directory: "/workspace", updated: 10, parentId: "ses_parent" },
    ]);
  });

  it("lists all and archived sessions through opencode db", () => {
    const calls: string[][] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "ses_active", title: "Active", directory: "/workspace", time_updated: 20, time_archived: null },
            { id: "ses_archived", title: "Archived", directory: "/workspace", time_updated: 10, time_archived: 30 },
          ]),
          stderr: "",
        };
      },
    });

    assert.deepEqual(repository.listAllSessions(), [
      { id: "ses_active", title: "Active", directory: "/workspace", updated: 20 },
      { id: "ses_archived", title: "Archived", directory: "/workspace", updated: 10, timeArchived: 30 },
    ]);
    assert.deepEqual(repository.listArchivedSessions(), [
      { id: "ses_active", title: "Active", directory: "/workspace", updated: 20 },
      { id: "ses_archived", title: "Archived", directory: "/workspace", updated: 10, timeArchived: 30 },
    ]);
    assert.match(normalizeOpenCodeArgs(calls[0] ?? [])[1] ?? "", /from session order by time_updated desc/);
    assert.match(normalizeOpenCodeArgs(calls[1] ?? [])[1] ?? "", /where time_archived is not null/);
  });

  it("finds the newest session id for a matching title", () => {
    const calls: string[][] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "ses_newest", title: "Shared Title", directory: "/workspace", time_updated: 30 },
            { id: "ses_older", title: "Shared Title", directory: "/workspace", time_updated: 20 },
          ]),
          stderr: "",
        };
      },
    });

    const session = repository.findLatestSessionByTitle("Shared Title", "/workspace");

    assert.deepEqual(session, { id: "ses_newest", title: "Shared Title", directory: "/workspace", updated: 30 });
    const query = normalizeOpenCodeArgs(calls[0] ?? [])[1] ?? "";
    assert.match(query, /where title = 'Shared Title'/);
    assert.match(query, /time_archived is null/);
    assert.match(query, /parent_id is null/);
    assert.match(query, /directory = '\/workspace'/);
    assert.match(query, /order by time_updated desc limit 1/);
  });

  it("finds an exact session id for reload restore", () => {
    const calls: string[][] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify([{ id: "ses_exact", title: "Shared Title", directory: "/workspace", time_updated: 30 }]),
          stderr: "",
        };
      },
    });

    const session = repository.findSessionById("ses_exact", "/workspace");

    assert.deepEqual(session, { id: "ses_exact", title: "Shared Title", directory: "/workspace", updated: 30 });
    assert.match(normalizeOpenCodeArgs(calls[0] ?? [])[1] ?? "", /where id = 'ses_exact'/);
  });

  it("finds the newest registered test session by restore title without querying sqlite", async () => {
    const repository = new OpenCodeSessionRepository({
      runAsync: async () => {
        throw new Error("registered session overrides should satisfy restore lookups");
      },
    });

    repository.registerSessionForTest({ id: "ses_older", title: "Shared Title", directory: "/workspace", updated: 10 }, "/workspace");
    repository.registerSessionForTest({ id: "ses_newer", title: "Shared Title", directory: "/workspace", updated: 20 }, "/workspace");
    repository.registerSessionForTest({ id: "ses_child", title: "Shared Title", directory: "/workspace", parentId: "ses_parent", updated: 30 }, "/workspace");
    repository.registerSessionForTest({ id: "ses_archived", title: "Shared Title", directory: "/workspace", timeArchived: 40, updated: 40 }, "/workspace");
    repository.registerSessionForTest({ id: "ses_other", title: "Shared Title", directory: "/other", updated: 50 }, "/other");

    const session = await repository.findLatestSessionByTitleAsync("Shared Title", "/workspace");

    assert.deepEqual(session, { id: "ses_newer", title: "Shared Title", directory: "/workspace", updated: 20 });
  });

  it("supports async session reads without the synchronous runner", async () => {
    const calls: string[][] = [];
    const reads: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: () => {
        throw new Error("sync runner should not be used");
      },
      runAsync: async (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        throw new Error("opencode db query should not be used for sqlite reads");
      },
      openDatabase: createReadableDatabaseFactory({
        rows: [{ id: "ses_exact", title: "Shared Title", directory: "/workspace", time_updated: 30 }],
        reads,
      }) as never,
    });

    const session = await repository.findSessionByIdAsync("ses_exact", "/workspace");

    assert.deepEqual(session, { id: "ses_exact", title: "Shared Title", directory: "/workspace", updated: 30 });
    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"]]);
    assert.match(reads[0]?.query ?? "", /where id = \?/);
  });

  it("falls back to async opencode db reads when bundled sqlite is unavailable", async () => {
    const calls: string[][] = [];
    const repository = new OpenCodeSessionRepository({
      runAsync: async (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{ id: "ses_exact", title: "Shared Title", directory: "/workspace", time_updated: 30 }]),
          stderr: "",
        };
      },
      openDatabase: createUnavailableDatabaseFactory() as never,
    });

    const session = await repository.findSessionByIdAsync("ses_exact", "/workspace");

    assert.deepEqual(session, { id: "ses_exact", title: "Shared Title", directory: "/workspace", updated: 30 });
    assert.deepEqual(normalizeOpenCodeArgs(calls[0] ?? []), ["db", "path"]);
    assert.match(normalizeOpenCodeArgs(calls[1] ?? [])[1] ?? "", /where id = 'ses_exact'/);
  });

  it("uses bundled sqlite for async session reads", async () => {
    const calls: string[][] = [];
    const reads: RecordedWrite[] = [];
    const execs: RecordedExec[] = [];
    const opens: RecordedOpen[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        throw new Error("opencode db query should not be used for sqlite reads");
      },
      openDatabase: createReadableDatabaseFactory({
        rows: [
          { id: "ses_top", title: "Top", directory: "/workspace", time_updated: 20, time_archived: null, parent_id: null },
        ],
        reads,
        execs,
        opens,
      }) as never,
    });

    const sessions = await repository.listSessionsAsync("/workspace");

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"]]);
    assert.deepEqual(opens, [{ databasePath: "/tmp/opencode.db", options: { readOnly: true, timeout: 0 } }]);
    assert.deepEqual(execs, [{ databasePath: "/tmp/opencode.db", query: "PRAGMA busy_timeout = 0" }]);
    assert.match(reads[0]?.query ?? "", /parent_id is null/);
    assert.deepEqual(reads[0]?.params, [100]);
    assert.deepEqual(sessions, [
      { id: "ses_top", title: "Top", directory: "/workspace", updated: 20 },
    ]);
  });

  it("binds sqlite read parameters for exact ids and quoted titles", async () => {
    const reads: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      openDatabase: createReadableDatabaseFactory({
        rows: [{ id: "ses_exact", title: "O'Brien", directory: "/tmp/it's", time_updated: 30 }],
        reads,
      }) as never,
    });

    await repository.findSessionByIdAsync("ses_exact", "/workspace");
    await repository.findLatestSessionByTitleAsync("O'Brien", "/tmp/it's");

    assert.deepEqual(reads.map((read) => read.params), [
      ["ses_exact"],
      ["O'Brien", "/tmp/it's"],
    ]);
  });

  it("caches sqlite database paths per cwd", async () => {
    const calls: string[][] = [];
    const opens: RecordedOpen[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args, options) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: `${options.cwd ?? "default"}.db\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      openDatabase: createReadableDatabaseFactory({
        rows: [],
        reads: [],
        opens,
      }) as never,
    });

    await repository.listSessionsAsync("/one");
    await repository.listSessionsAsync("/two");
    await repository.listSessionsAsync("/one");

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"], ["db", "path"]]);
    assert.deepEqual(opens.map((open) => open.databasePath), ["/one.db", "/two.db", "/one.db"]);
  });

  it("returns undefined when no session matches a restore title", () => {
    const repository = new OpenCodeSessionRepository({
      run: () => ({ status: 0, stdout: JSON.stringify([]), stderr: "" }),
    });

    assert.equal(repository.findLatestSessionByTitle("Missing"), undefined);
  });

  it("throws when opencode session list fails", () => {
    const repository = new OpenCodeSessionRepository({
      run: () => ({ status: 1, stdout: "", stderr: "boom" }),
    });

    assert.throws(() => repository.listSessions("/workspace"), /Failed to list OpenCode sessions: boom/);
  });

  it("deletes a session with the expected command", () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const repository = new OpenCodeSessionRepository({
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    repository.deleteSession("ses_1", "/workspace");

    assert.deepEqual(calls.map((call) => normalizeRecordedCall(call)), [
      { command: "opencode", args: ["session", "delete", "ses_1"], cwd: undefined },
    ]);
  });

  it("runs the Windows command shim through cmd.exe for repository subprocesses", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const repository = new OpenCodeSessionRepository({
      openCodeCommand: "opencode.cmd",
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    repository.deleteSession("ses_1");

    if (process.platform === "win32") {
      assert.deepEqual(calls, [
        { command: "cmd.exe", args: ["/d", "/s", "/c", "opencode.cmd", "session", "delete", "ses_1"] },
      ]);
    } else {
      assert.deepEqual(calls, [
        { command: "opencode.cmd", args: ["session", "delete", "ses_1"] },
      ]);
    }
  });

  it("bridges WSL UNC workspaces through wsl.exe and skips bundled sqlite for async session reads", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    let openedDatabase = false;
    const repository = new OpenCodeSessionRepository({
      platform: "win32",
      runAsync: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        return {
          status: 0,
          stdout: JSON.stringify([{ id: "ses_wsl", title: "WSL", directory: "/home/me/proj", time_updated: 30 }]),
          stderr: "",
        };
      },
      openDatabase: (() => {
        openedDatabase = true;
        throw new Error("bundled sqlite should not be opened for a WSL-bridged workspace");
      }) as never,
    });

    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const session = await repository.findSessionByIdAsync("ses_wsl", cwd);

    assert.equal(openedDatabase, false);
    assert.deepEqual(session, { id: "ses_wsl", title: "WSL", directory: "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", updated: 30 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      command: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/me/proj", "-e", "bash", "-ic", "opencode 'db' 'select id, project_id, parent_id, title, directory, time_created, time_updated, time_archived from session where id = '\\''ses_wsl'\\'' limit 1' '--format' 'json'"],
      cwd: undefined,
    });
  });

  it("deletes a parent session and its descendants through a single bundled sqlite write", async () => {
    const calls: string[][] = [];
    const writes: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      openDatabase: createDatabaseFactoryWithSessionRows([{ id: "ses_parent" }], writes) as never,
    });

    await repository.deleteSessions(["ses_parent"]);

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"]]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.databasePath, "/tmp/opencode.db");
    assert.match(writes[0]?.query ?? "", /with recursive target\(id\)/i);
    assert.match(writes[0]?.query ?? "", /session\.parent_id = target\.id/i);
    assert.deepEqual(writes[0]?.params, ["ses_parent"]);
  });

  it("surfaces a missing session during bundled bulk delete", async () => {
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      openDatabase: createDatabaseFactoryWithSessionRows([], []) as never,
    });

    await assert.rejects(
      repository.deleteSessions(["ses_parent"]),
      /Failed to delete OpenCode session: OpenCode session not found: ses_parent/,
    );
  });

  it("archives and unarchives sessions through bundled sqlite writes", async () => {
    const calls: string[][] = [];
    const writes: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => 12345,
      openDatabase: createFakeDatabaseFactory(writes, []) as never,
    });

    await repository.archiveSession("ses_1");
    await repository.unarchiveSession("ses_2");

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [
      ["db", "path"],
    ]);
    assert.deepEqual(writes, [
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [12345, "ses_1"],
      },
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [null, "ses_2"],
      },
    ]);
  });

  it("archives multiple sessions with a single database path lookup and write transaction", async () => {
    const calls: string[][] = [];
    const writes: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => 12345,
      openDatabase: createFakeDatabaseFactory(writes, []) as never,
    });

    await repository.archiveSessions(["ses_1", "ses_2"]);

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"]]);
    assert.deepEqual(writes, [
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [12345, "ses_1"],
      },
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [12345, "ses_2"],
      },
    ]);
  });

  it("unarchives multiple sessions with a single database path lookup and write transaction", async () => {
    const calls: string[][] = [];
    const writes: RecordedWrite[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        calls.push(args);
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      openDatabase: createFakeDatabaseFactory(writes, []) as never,
    });

    await repository.unarchiveSessions(["ses_1", "ses_2"]);

    assert.deepEqual(calls.map((args) => normalizeOpenCodeArgs(args)), [["db", "path"]]);
    assert.deepEqual(writes, [
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [null, "ses_1"],
      },
      {
        databasePath: "/tmp/opencode.db",
        query: "update session set time_archived = ? where id = ?",
        params: [null, "ses_2"],
      },
    ]);
  });

  it("does not rely on a system sqlite3 binary for archive writes", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const repository = new OpenCodeSessionRepository({
      run: (command, args) => {
        calls.push({ command, args });
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => 12345,
      openDatabase: createFakeDatabaseFactory([], []) as never,
    });

    await repository.archiveSession("ses_1");

    assert.deepEqual(calls.map((call) => normalizeRecordedCall(call)), [
      { command: "opencode", args: ["db", "path"] },
    ]);
  });

  it("sets a sqlite busy timeout before bundled archive writes", async () => {
    const execs: RecordedExec[] = [];
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => 12345,
      busyTimeoutMs: 2000,
      openDatabase: createFakeDatabaseFactory([], execs) as never,
    });

    await repository.archiveSession("ses_1");

    assert.deepEqual(execs.map((exec) => exec.query), [
      "PRAGMA busy_timeout = 2000",
      "PRAGMA foreign_keys = ON",
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
  });

  it("surfaces bundled sqlite errors during archive writes", async () => {
    const repository = new OpenCodeSessionRepository({
      run: (_command, args) => {
        if (isOpenCodeDbPathArgs(args)) {
          return { status: 0, stdout: "/tmp/opencode.db\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      now: () => 12345,
      openDatabase: createFailingDatabaseFactory(new Error("database is locked")) as never,
    });

    await assert.rejects(
      repository.archiveSession("ses_1"),
      /Failed to archive OpenCode session: database is locked/,
    );
  });

  it("surfaces opencode db path failures during archive writes", async () => {
    const repository = new OpenCodeSessionRepository({
      run: () => ({ status: 1, stdout: "", stderr: "boom" }),
      openDatabase: createFakeDatabaseFactory([], []) as never,
    });

    await assert.rejects(
      repository.archiveSession("ses_1"),
      /Failed to archive OpenCode session: boom/,
    );
  });

  it("caps async command output before returning", async () => {
    const result = await runCommandAsync(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(11 * 1024 * 1024))"],
      { encoding: "utf8", timeout: 5000 },
    );

    assert.match(result.error?.message ?? "", /Command output exceeded/);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 10 * 1024 * 1024);
  });

  it("terminates async commands after timeout", async () => {
    const result = await runCommandAsync(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { encoding: "utf8", timeout: 10 },
    );

    assert.match(result.error?.message ?? "", /Command timed out/);
  });
});

function createFakeDatabaseFactory(writes: RecordedWrite[], execs: RecordedExec[] = []) {
  return function FakeDatabase(this: {
    prepare: (query: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => void };
    exec: (_query: string) => void;
    transaction: <T extends (...args: unknown[]) => void>(fn: T) => { immediate: (...args: Parameters<T>) => void };
    close: () => void;
  }, databasePath: string) {
    this.exec = (query) => { execs.push({ databasePath, query }); };
    this.prepare = (query: string) => ({
      all: () => [],
      run: (...params: unknown[]) => {
        writes.push({ databasePath, query, params });
      },
    });
    this.transaction = <T extends (...args: unknown[]) => void>(fn: T) => ({
      immediate: (...args: Parameters<T>) => fn(...args),
    });
    this.close = () => {};
  };
}

function createReadableDatabaseFactory({
  rows,
  reads,
  execs = [],
  opens = [],
}: {
  rows: unknown[];
  reads: RecordedWrite[];
  execs?: RecordedExec[];
  opens?: RecordedOpen[];
}) {
  return function FakeDatabase(this: {
    prepare: (query: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => void };
    exec: (_query: string) => void;
    close: () => void;
  }, databasePath: string, options?: unknown) {
    opens.push({ databasePath, options });
    this.exec = (query) => { execs.push({ databasePath, query }); };
    this.prepare = (query: string) => ({
      all: (...params: unknown[]) => {
        reads.push({ databasePath, query, params });
        return rows;
      },
      run: (...params: unknown[]) => {
        reads.push({ databasePath, query, params });
      },
    });
    this.close = () => {};
  };
}

function createDatabaseFactoryWithSessionRows(rows: Array<{ id: string }>, writes: RecordedWrite[]) {
  return function FakeDatabase(this: {
    prepare: (query: string) => { all: (...params: unknown[]) => unknown[]; run: (...params: unknown[]) => void };
    exec: (_query: string) => void;
    transaction: <T extends (...args: unknown[]) => void>(fn: T) => { immediate: (...args: Parameters<T>) => void };
    close: () => void;
  }, databasePath: string) {
    this.exec = () => {};
    this.prepare = (query: string) => ({
      all: () => query.startsWith("select id from session") ? rows : [],
      run: (...params: unknown[]) => {
        writes.push({ databasePath, query, params });
      },
    });
    this.transaction = <T extends (...args: unknown[]) => void>(fn: T) => ({
      immediate: (...args: Parameters<T>) => fn(...args),
    });
    this.close = () => {};
  };
}

function createFailingDatabaseFactory(error: Error) {
  return function FakeDatabase(this: {
    prepare: () => { all: () => never[]; run: () => never };
    exec: (_query: string) => void;
    transaction: <T extends (...args: unknown[]) => void>(fn: T) => { immediate: (...args: Parameters<T>) => void };
    close: () => void;
  }, _databasePath: string) {
    this.exec = () => {};
    this.prepare = () => ({
      all: () => {
        throw error;
      },
      run: () => {
        throw error;
      },
    });
    this.transaction = <T extends (...args: unknown[]) => void>(fn: T) => ({
      immediate: (...args: Parameters<T>) => fn(...args),
    });
    this.close = () => {};
  };
}

function createUnavailableDatabaseFactory() {
  return function FakeDatabase() {
    throw new Error("node:sqlite is unavailable in this VS Code runtime.");
  };
}
