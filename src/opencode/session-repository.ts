import { spawn, spawnSync } from "node:child_process";
import { resolveOpenCodeSpawnCommand } from "./command";
import { isValidSessionId } from "./session-manager";

export type OpenCodeSessionSummary = {
  id: string;
  title?: string;
  directory?: string;
  updated?: number | string;
  created?: number | string;
  projectId?: string;
  parentId?: string;
  timeArchived?: number | string;
};

type RunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type Runner = (command: string, args: string[], options: { cwd?: string; timeout: number; encoding: "utf8" }) => RunnerResult;

type AsyncRunner = (command: string, args: string[], options: { cwd?: string; timeout: number; encoding: "utf8" }) => Promise<RunnerResult>;

type WriteAction = "archive" | "unarchive" | "delete";

type SqliteStatementLike = {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
};

type SqliteDatabaseLike = {
  prepare(query: string): SqliteStatementLike;
  exec(query: string): unknown;
  close(): void;
};

type SqliteDatabaseConstructor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabaseLike;

type RepositoryOptions = {
  openCodeCommand?: string;
  maxCount?: number;
  run?: Runner;
  runAsync?: AsyncRunner;
  now?: () => number;
  openDatabase?: SqliteDatabaseConstructor;
  busyTimeoutMs?: number;
};

type SessionOverride = {
  session: OpenCodeSessionSummary;
  cwd?: string;
};

export class OpenCodeSessionRepository {
  private readonly command: string;
  private readonly maxCount: number;
  private readonly run: Runner;
  private readonly runAsync: AsyncRunner;
  private readonly now: () => number;
  private readonly openDatabase?: SqliteDatabaseConstructor;
  private readonly busyTimeoutMs: number;
  private readonly databasePaths = new Map<string, string>();
  private readonly sessionOverrides = new Map<string, SessionOverride>();

  constructor(options: RepositoryOptions = {}) {
    this.command = options.openCodeCommand ?? "opencode";
    this.maxCount = options.maxCount ?? 100;
    this.run = options.run ?? ((command, args, runOptions) => spawnSync(command, args, runOptions));
    this.runAsync = options.runAsync ?? (options.run ? ((command, args, runOptions) => Promise.resolve(options.run?.(command, args, runOptions) ?? this.run(command, args, runOptions))) : runCommandAsync);
    this.now = options.now ?? Date.now;
    this.openDatabase = options.openDatabase;
    this.busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  }

  listSessions(cwd?: string): OpenCodeSessionSummary[] {
    return this.querySessionsCli(
      `select ${SESSION_COLUMNS} from session where time_archived is null and parent_id is null order by time_updated desc limit ${this.maxCount}`,
      cwd,
    );
  }

  listAllSessions(cwd?: string): OpenCodeSessionSummary[] {
    return this.querySessionsCli(
      `select ${SESSION_COLUMNS} from session order by time_updated desc`,
      cwd,
    );
  }

  async listAllSessionsAsync(cwd?: string): Promise<OpenCodeSessionSummary[]> {
    return this.querySessionsSqlite(
      `select ${SESSION_COLUMNS} from session order by time_updated desc, id desc`,
      [],
      cwd,
      "list",
    );
  }

  listArchivedSessions(cwd?: string): OpenCodeSessionSummary[] {
    return this.querySessionsCli(
      `select ${SESSION_COLUMNS} from session where time_archived is not null order by time_updated desc`,
      cwd,
    );
  }

  async listArchivedSessionsAsync(cwd?: string): Promise<OpenCodeSessionSummary[]> {
    return this.querySessionsSqlite(
      `select ${SESSION_COLUMNS} from session where time_archived is not null order by time_updated desc, id desc`,
      [],
      cwd,
      "list",
    );
  }

  findSessionById(sessionId: string, cwd?: string): OpenCodeSessionSummary | undefined {
    if (!isValidSessionId(sessionId)) {
      return undefined;
    }

    const override = this.readSessionOverride(sessionId, cwd);
    if (override) {
      return override;
    }

    const sessions = this.querySessionsCli(
      `select ${SESSION_COLUMNS} from session where id = ${quoteSqlString(sessionId)} limit 1`,
      cwd,
    );
    return sessions[0];
  }

  async findSessionByIdAsync(sessionId: string, cwd?: string): Promise<OpenCodeSessionSummary | undefined> {
    if (!isValidSessionId(sessionId)) {
      return undefined;
    }

    const override = this.readSessionOverride(sessionId, cwd);
    if (override) {
      return override;
    }

    const sessions = await this.querySessionsSqlite(
      `select ${SESSION_COLUMNS} from session where id = ? limit 1`,
      [sessionId],
      cwd,
      "find",
    );
    return sessions[0];
  }

  findLatestSessionByTitle(title: string, cwd?: string): OpenCodeSessionSummary | undefined {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return undefined;
    }

    const override = this.readLatestSessionOverrideByTitle(normalizedTitle, cwd);
    if (override) {
      return override;
    }

    const whereClauses = [
      `title = ${quoteSqlString(normalizedTitle)}`,
      "time_archived is null",
      "parent_id is null",
      ...(cwd ? [`directory = ${quoteSqlString(cwd)}`] : []),
    ];

    const sessions = this.querySessionsCli(
      `select ${SESSION_COLUMNS} from session where ${whereClauses.join(" and ")} order by time_updated desc limit 1`,
      cwd,
    );
    return sessions[0];
  }

  async findLatestSessionByTitleAsync(title: string, cwd?: string): Promise<OpenCodeSessionSummary | undefined> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return undefined;
    }

    const override = this.readLatestSessionOverrideByTitle(normalizedTitle, cwd);
    if (override) {
      return override;
    }

    const directoryClause = cwd ? " and directory = ?" : "";
    const sessions = await this.querySessionsSqlite(
      `select ${SESSION_COLUMNS} from session where title = ? and time_archived is null and parent_id is null${directoryClause} order by time_updated desc, id desc limit 1`,
      cwd ? [normalizedTitle, cwd] : [normalizedTitle],
      cwd,
      "find",
    );
    return sessions[0];
  }

  async listSessionsAsync(cwd?: string): Promise<OpenCodeSessionSummary[]> {
    return this.querySessionsSqlite(
      `select ${SESSION_COLUMNS} from session where time_archived is null and parent_id is null order by time_updated desc, id desc limit ?`,
      [this.maxCount],
      cwd,
      "list",
    );
  }

  deleteSession(sessionId: string, _cwd?: string): void {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid OpenCode session id: ${sessionId}`);
    }

    const command = this.createSpawnCommand(["session", "delete", sessionId]);
    const result = this.run(command.command, command.args, { encoding: "utf8", timeout: 5000 });

    if (result.status !== 0) {
      throw new Error(`Failed to delete OpenCode session: ${formatFailure(result)}`);
    }
  }

  async deleteSessions(sessionIds: string[], _cwd?: string): Promise<void> {
    const normalizedSessionIds = uniqueValidSessionIds(sessionIds);
    if (normalizedSessionIds.length === 0) {
      return;
    }

    await this.runDatabaseWrite("delete", normalizedSessionIds.length, (database) => {
      const placeholders = normalizedSessionIds.map(() => "?").join(", ");
      const existingSessions = database
        .prepare(`select id from session where id in (${placeholders})`)
        .all(...normalizedSessionIds)
        .flatMap(readSessionIdRow);
      const missingSessions = normalizedSessionIds.filter((sessionId) => !existingSessions.includes(sessionId));
      if (missingSessions.length > 0) {
        throw new Error(`OpenCode session not found: ${missingSessions[0]}`);
      }

      const query = [
        "with recursive target(id) as (",
        `select id from session where id in (${placeholders})`,
        "union",
        "select session.id",
        "from session join target on session.parent_id = target.id",
        ")",
        "delete from session where id in (select id from target)",
      ].join(" ");
      database.prepare(query).run(...normalizedSessionIds);
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.updateArchiveTimes([sessionId], this.now(), "archive");
  }

  async archiveSessions(sessionIds: string[]): Promise<void> {
    await this.updateArchiveTimes(sessionIds, this.now(), "archive");
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    await this.updateArchiveTimes([sessionId], null, "unarchive");
  }

  async unarchiveSessions(sessionIds: string[]): Promise<void> {
    await this.updateArchiveTimes(sessionIds, null, "unarchive");
  }

  registerSessionForTest(session: OpenCodeSessionSummary, cwd?: string) {
    this.sessionOverrides.set(session.id, { session, cwd });
  }

  private querySessionsCli(query: string, cwd?: string) {
    const command = this.createSpawnCommand(["db", query, "--format", "json"]);
    const result = this.run(command.command, command.args, { cwd, encoding: "utf8", timeout: 5000 });

    if (result.status !== 0) {
      throw new Error(`Failed to list OpenCode sessions: ${formatFailure(result)}`);
    }

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Failed to list OpenCode sessions: expected a JSON array.");
    }

    return parsed.flatMap(parseSessionRecord);
  }

  private async querySessionsAsyncCli(query: string, cwd?: string) {
    const command = this.createSpawnCommand(["db", query, "--format", "json"]);
    const result = await this.runAsync(command.command, command.args, { cwd, encoding: "utf8", timeout: 5000 });

    if (result.status !== 0) {
      throw new Error(`Failed to list OpenCode sessions: ${formatFailure(result)}`);
    }

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Failed to list OpenCode sessions: expected a JSON array.");
    }

    return parsed.flatMap(parseSessionRecord);
  }

  private async querySessionsSqlite(query: string, params: unknown[], cwd: string | undefined, action: "find" | "list") {
    try {
      return await this.querySessionsSqliteRequired(query, params, cwd, action);
    } catch (error) {
      if (isSqliteUnavailableError(error)) {
        return this.querySessionsAsyncCli(bindSqlForCli(query, params), cwd);
      }
      throw error;
    }
  }

  private async querySessionsSqliteRequired(query: string, params: unknown[], cwd: string | undefined, action: "find" | "list") {
    const databasePath = await this.readDatabasePathAsync(action, cwd);
    try {
      const DatabaseSync = this.openDatabase ?? await loadDatabaseSync();
      const database = new DatabaseSync(databasePath, { readOnly: true, timeout: READ_SQLITE_BUSY_TIMEOUT_MS });
      try {
        database.exec(`PRAGMA busy_timeout = ${READ_SQLITE_BUSY_TIMEOUT_MS}`);
        return database.prepare(query).all(...params).flatMap(parseSessionRecord);
      } finally {
        database.close();
      }
    } catch (error) {
      throw new Error(`Failed to ${action} OpenCode sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async updateArchiveTimes(sessionIds: string[], value: number | null, action: "archive" | "unarchive") {
    const normalizedSessionIds = uniqueValidSessionIds(sessionIds);
    if (normalizedSessionIds.length === 0) {
      return;
    }

    await this.runDatabaseWrite(action, normalizedSessionIds.length, (database) => {
      const statement = database.prepare("update session set time_archived = ? where id = ?");
      for (const sessionId of normalizedSessionIds) {
        statement.run(value, sessionId);
      }
    });
  }

  private async runDatabaseWrite(action: WriteAction, sessionCount: number, write: (database: SqliteDatabaseLike) => void) {
    const databasePath = this.readDatabasePath(action, undefined);

    try {
      const DatabaseSync = this.openDatabase ?? await loadDatabaseSync();
      const database = new DatabaseSync(databasePath, { timeout: this.busyTimeoutMs });
      try {
        database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
        database.exec("PRAGMA foreign_keys = ON");
        database.exec("BEGIN IMMEDIATE");
        write(database);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Ignore rollback failures and surface the original error.
        }
        throw error;
      } finally {
        database.close();
      }
    } catch (error) {
      const targetLabel = sessionCount === 1 ? "session" : "sessions";
      throw new Error(`Failed to ${action} OpenCode ${targetLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readDatabasePath(action: WriteAction | "find" | "list", cwd?: string) {
    const cacheKey = toDatabasePathCacheKey(cwd);
    const cachedPath = this.databasePaths.get(cacheKey);
    if (cachedPath) {
      return cachedPath;
    }

    const command = this.createSpawnCommand(["db", "path"]);
    const pathResult = this.run(command.command, command.args, { cwd, encoding: "utf8", timeout: 5000 });
    if (pathResult.status !== 0) {
      throw new Error(`Failed to ${action} OpenCode session: ${formatFailure(pathResult)}`);
    }

    const databasePath = pathResult.stdout.trim();
    if (!databasePath) {
      throw new Error(`Failed to ${action} OpenCode session: OpenCode database path was empty.`);
    }

    this.databasePaths.set(cacheKey, databasePath);
    return databasePath;
  }

  private async readDatabasePathAsync(action: WriteAction | "find" | "list", cwd?: string) {
    const cacheKey = toDatabasePathCacheKey(cwd);
    const cachedPath = this.databasePaths.get(cacheKey);
    if (cachedPath) {
      return cachedPath;
    }

    const command = this.createSpawnCommand(["db", "path"]);
    const pathResult = await this.runAsync(command.command, command.args, { cwd, encoding: "utf8", timeout: 5000 });
    if (pathResult.status !== 0) {
      throw new Error(`Failed to ${action} OpenCode session: ${formatFailure(pathResult)}`);
    }

    const databasePath = pathResult.stdout.trim();
    if (!databasePath) {
      throw new Error(`Failed to ${action} OpenCode session: OpenCode database path was empty.`);
    }

    this.databasePaths.set(cacheKey, databasePath);
    return databasePath;
  }

  private readSessionOverride(sessionId: string, cwd?: string) {
    const override = this.sessionOverrides.get(sessionId);
    if (!override || (override.cwd && cwd && override.cwd !== cwd)) {
      return undefined;
    }

    return override.session;
  }

  private createSpawnCommand(args: readonly string[]) {
    return resolveOpenCodeSpawnCommand(this.command, args);
  }

  private readLatestSessionOverrideByTitle(title: string, cwd?: string) {
    const matches = Array.from(this.sessionOverrides.values())
      .filter((override) => override.session.title?.trim() === title)
      .filter((override) => !override.session.parentId && override.session.timeArchived === undefined)
      .filter((override) => !cwd || override.cwd === cwd || override.session.directory === cwd)
      .map((override) => override.session)
      .sort(compareSessionsNewestFirst);

    return matches[0];
  }
}

const SESSION_COLUMNS = "id, project_id, parent_id, title, directory, time_created, time_updated, time_archived";
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 1000;
const READ_SQLITE_BUSY_TIMEOUT_MS = 0;

function parseSessionRecord(value: unknown): OpenCodeSessionSummary[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !isValidSessionId(record.id)) {
    return [];
  }

  return [{
    id: record.id,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.directory === "string" ? { directory: record.directory } : {}),
    ...readTimeField(record, "updated", "time_updated"),
    ...readTimeField(record, "created", "time_created"),
    ...readTimeField(record, "timeArchived", "time_archived"),
    ...(typeof record.project_id === "string" ? { projectId: record.project_id } : {}),
    ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
    ...(typeof record.parent_id === "string" ? { parentId: record.parent_id } : {}),
    ...(typeof record.parentId === "string" ? { parentId: record.parentId } : {}),
  }];
}

function readTimeField(
  record: Record<string, unknown>,
  outputName: "updated" | "created" | "timeArchived",
  snakeName: string,
) {
  const value = record[snakeName] ?? record[outputName];
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? { [outputName]: value } : {};
}

function compareSessionsNewestFirst(left: OpenCodeSessionSummary, right: OpenCodeSessionSummary) {
  const updatedDifference = readComparableTime(right.updated) - readComparableTime(left.updated);
  if (updatedDifference !== 0) {
    return updatedDifference;
  }
  return right.id.localeCompare(left.id);
}

function readComparableTime(value: OpenCodeSessionSummary["updated"]) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatFailure(result: RunnerResult) {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return stderr || result.error?.message || `exit status ${result.status ?? "unknown"}`;
}

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveBusyTimeoutMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), 5000);
}

function toDatabasePathCacheKey(cwd: string | undefined) {
  return cwd ?? "";
}

function isSqliteUnavailableError(error: unknown) {
  return error instanceof Error && error.message.includes("node:sqlite is unavailable");
}

function bindSqlForCli(query: string, params: unknown[]) {
  let index = 0;
  return query.replace(/\?/g, () => {
    if (index >= params.length) {
      return "?";
    }
    const value = params[index++];
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
    return quoteSqlString(String(value));
  });
}

function readSessionIdRow(value: unknown) {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" ? [record.id] : [];
}

function uniqueValidSessionIds(sessionIds: string[]) {
  const seen = new Set<string>();
  const normalizedSessionIds: string[] = [];

  for (const sessionId of sessionIds) {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid OpenCode session id: ${sessionId}`);
    }
    if (seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    normalizedSessionIds.push(sessionId);
  }

  return normalizedSessionIds;
}

export function runCommandAsync(command: string, args: string[], options: { cwd?: string; timeout: number; encoding: "utf8" }): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let timeoutError: Error | undefined;

    const finish = (result: RunnerResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      resolve(result);
    };

    const readOutput = () => ({
      stdout: Buffer.concat(stdout).toString(options.encoding),
      stderr: Buffer.concat(stderr).toString(options.encoding),
    });

    const terminate = (error: Error) => {
      if (timeoutError) {
        return;
      }

      timeoutError = error;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    };

    const recordOutput = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (timeoutError) {
        return;
      }

      const usedBytes = stdoutBytes + stderrBytes;
      const remainingBytes = MAX_COMMAND_OUTPUT_BYTES - usedBytes;
      if (remainingBytes <= 0) {
        terminate(new Error(`Command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
        return;
      }

      const acceptedChunk = chunk.length > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
      if (stream === "stdout") {
        stdoutBytes += acceptedChunk.length;
      } else {
        stderrBytes += acceptedChunk.length;
      }

      if (acceptedChunk.length > 0) {
        target.push(acceptedChunk);
      }

      if (chunk.length > remainingBytes || stdoutBytes + stderrBytes >= MAX_COMMAND_OUTPUT_BYTES) {
        terminate(new Error(`Command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
      }
    };

    timeout = setTimeout(() => {
      terminate(new Error(`Command timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => recordOutput(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => recordOutput(stderr, chunk, "stderr"));
    child.on("error", (error) => {
      finish({ status: null, ...readOutput(), error });
    });
    child.on("close", (status) => {
      finish({ status, ...readOutput(), ...(timeoutError ? { error: timeoutError } : {}) });
    });
  });
}

async function loadDatabaseSync(): Promise<SqliteDatabaseConstructor> {
  try {
    const sqlite = await import("node:sqlite");
    return sqlite.DatabaseSync as SqliteDatabaseConstructor;
  } catch {
    throw new Error("node:sqlite is unavailable in this VS Code runtime.");
  }
}
