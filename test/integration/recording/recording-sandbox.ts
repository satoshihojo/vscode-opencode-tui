import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type RecordingSessionFixture = {
  sessionId: string;
  title: string;
  slug: string;
  userPrompt: string;
  assistantReply: string;
  additions: number;
  deletions: number;
  files: number;
  createdOffsetMs: number;
  updatedOffsetMs: number;
};

export type RecordingSandbox = {
  rootPath: string;
  workspacePath: string;
  dataHomePath: string;
  cacheHomePath: string;
  configHomePath: string;
  stateHomePath: string;
};

export const RECORDING_SESSION_FIXTURES: readonly RecordingSessionFixture[] = [
  {
    sessionId: "ses_recordingQueueDiffFixes001",
    title: "Queue diff fixes",
    slug: "quiet-forest",
    userPrompt: [
      "Queue risk check",
      "- modified summary copy",
      "- delete legacy flow",
      "- add queue cards",
    ].join("\n"),
    assistantReply: [
      "Highest risk: the delete.",
      "It removes the legacy review flow.",
      "The modify and add changes look routine.",
    ].join("\n"),
    additions: 3,
    deletions: 1,
    files: 4,
    createdOffsetMs: 32 * 60_000,
    updatedOffsetMs: 345 * 24 * 60 * 60_000,
  },
  {
    sessionId: "ses_recordingBackgroundAgent001",
    title: "Background queue audit",
    slug: "ember-field",
    userPrompt: [
      "Background audit",
      "- verify queue status dots",
      "- verify timestamp spacing",
    ].join("\n"),
    assistantReply: [
      "Background audit queued.",
      "Status dots and timestamps are ready for review.",
    ].join("\n"),
    additions: 0,
    deletions: 0,
    files: 1,
    createdOffsetMs: 30 * 60_000,
    updatedOffsetMs: 6 * 60_000,
  },
  {
    sessionId: "ses_recordingSummarizePending001",
    title: "Summarize pending edits",
    slug: "silver-lake",
    userPrompt: [
      "Release note draft",
      "1. summary copy refresh",
      "2. queue cards added",
      "3. legacy cleanup removed",
    ].join("\n"),
    assistantReply: [
      "Release notes",
      "1. Refined the review summary copy.",
      "2. Added queue card examples.",
      "3. Removed legacy cleanup code.",
    ].join("\n"),
    additions: 1,
    deletions: 0,
    files: 2,
    createdOffsetMs: 28 * 60_000,
    updatedOffsetMs: 8 * 60_000,
  },
  {
    sessionId: "ses_recordingRefactorReview001",
    title: "Refactor review queue",
    slug: "golden-harbor",
    userPrompt: [
      "Review UI refactor",
      "[ ] quiet empty state",
      "[ ] file count copy",
      "[ ] remove summary badge",
    ].join("\n"),
    assistantReply: [
      "Refactor plan",
      "Keep the header quiet.",
      "Pluralize the file count.",
      "Drop the duplicate badge.",
    ].join("\n"),
    additions: 2,
    deletions: 0,
    files: 3,
    createdOffsetMs: 24 * 60_000,
    updatedOffsetMs: 2 * 60_000,
  },
] as const;

export const PREOPENED_RECORDING_SESSIONS = RECORDING_SESSION_FIXTURES.slice(0, 3);
export const QUICK_PICK_RECORDING_SESSION = RECORDING_SESSION_FIXTURES[3];
export const QUICK_PICK_RECORDING_FILTER = "refactor";

export function prepareRecordingSandbox({
  fixtureWorkspacePath,
  openCodePath,
  env = process.env,
}: {
  fixtureWorkspacePath: string;
  openCodePath: string;
  env?: NodeJS.ProcessEnv;
}): RecordingSandbox {
  const rootPath = path.join(os.tmpdir(), "opencode-tui-integration-recording");
  const workspacePath = path.join(rootPath, "workspace");
  const dataHomePath = path.join(rootPath, "xdg-data");
  const cacheHomePath = path.join(rootPath, "xdg-cache");
  const configHomePath = path.join(rootPath, "xdg-config");
  const stateHomePath = path.join(rootPath, "xdg-state");

  rmSync(rootPath, { recursive: true, force: true });
  mkdirSync(rootPath, { recursive: true });
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  mkdirSync(dataHomePath, { recursive: true });
  mkdirSync(cacheHomePath, { recursive: true });
  mkdirSync(configHomePath, { recursive: true });
  mkdirSync(stateHomePath, { recursive: true });

  copyRecordingAuth(dataHomePath, env);
  seedRecordingSessions({
    openCodePath,
    workspacePath,
    sandbox: {
      rootPath,
      workspacePath,
      dataHomePath,
      cacheHomePath,
      configHomePath,
      stateHomePath,
    },
    env,
  });

  return {
    rootPath,
    workspacePath,
    dataHomePath,
    cacheHomePath,
    configHomePath,
    stateHomePath,
  };
}

function copyRecordingAuth(dataHomePath: string, env: NodeJS.ProcessEnv) {
  const sourceAuthPath = resolveSourceAuthPath(env);
  if (!sourceAuthPath) {
    throw new Error("Unable to locate opencode auth.json for the recording sandbox.");
  }

  const destinationPath = path.join(dataHomePath, "opencode", "auth.json");
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourceAuthPath, destinationPath);
}

function resolveSourceAuthPath(env: NodeJS.ProcessEnv) {
  const candidates = [
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "opencode", "auth.json") : undefined,
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    env.APPDATA ? path.join(env.APPDATA, "opencode", "auth.json") : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string");

  return candidates.find((candidate) => existsSync(candidate));
}

function seedRecordingSessions({
  openCodePath,
  workspacePath,
  sandbox,
  env,
}: {
  openCodePath: string;
  workspacePath: string;
  sandbox: RecordingSandbox;
  env: NodeJS.ProcessEnv;
}) {
  const importsPath = path.join(sandbox.rootPath, "imports");
  mkdirSync(importsPath, { recursive: true });

  for (const fixture of RECORDING_SESSION_FIXTURES) {
    const filePath = path.join(importsPath, `${fixture.sessionId}.json`);
    writeFileSync(filePath, JSON.stringify(buildRecordingSessionExport(fixture, workspacePath), null, 2));

    const result = spawnSync(openCodePath, ["import", filePath], {
      encoding: "utf8",
      cwd: workspacePath,
      env: createSandboxEnvironment(env, sandbox),
    });
    if (result.status === 0) {
      continue;
    }

    const message = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status ?? "unknown"}`;
    throw new Error(`Failed to import recording fixture ${fixture.sessionId}: ${message}`);
  }
}

function buildRecordingSessionExport(fixture: RecordingSessionFixture, workspacePath: string) {
  const now = Date.now();
  const userMessageId = buildRecordingMessageId(fixture.sessionId, "user");
  const assistantMessageId = buildRecordingMessageId(fixture.sessionId, "assistant");
  const userTextPartId = buildRecordingPartId(userMessageId, "text");
  const assistantStepStartPartId = buildRecordingPartId(assistantMessageId, "stepstart");
  const assistantTextPartId = buildRecordingPartId(assistantMessageId, "text");
  const assistantStepFinishPartId = buildRecordingPartId(assistantMessageId, "stepfinish");
  const userCreatedAt = now - fixture.createdOffsetMs + 10_000;
  const assistantCreatedAt = userCreatedAt + 20_000;
  const assistantCompletedAt = assistantCreatedAt + 12_000;

  return {
    info: {
      id: fixture.sessionId,
      slug: fixture.slug,
      projectID: "proj_recording_fixture",
      directory: workspacePath,
      title: fixture.title,
      version: "1.14.22",
      summary: {
        additions: fixture.additions,
        deletions: fixture.deletions,
        files: fixture.files,
      },
      time: {
        created: now - fixture.createdOffsetMs,
        updated: now - fixture.updatedOffsetMs,
      },
    },
    messages: [
      {
        info: {
          role: "user",
          time: {
            created: userCreatedAt,
          },
          agent: "build",
          model: {
            providerID: "github-copilot",
            modelID: "gpt-5.4",
            variant: "xhigh",
          },
          summary: {
            diffs: [],
          },
          id: userMessageId,
          sessionID: fixture.sessionId,
        },
        parts: [
          {
            type: "text",
            text: fixture.userPrompt,
            id: userTextPartId,
            sessionID: fixture.sessionId,
            messageID: userMessageId,
          },
        ],
      },
      {
        info: {
          parentID: userMessageId,
          role: "assistant",
          mode: "build",
          agent: "build",
          variant: "xhigh",
          path: {
            cwd: workspacePath,
            root: workspacePath,
          },
          cost: 0,
          tokens: {
            total: 1280,
            input: 640,
            output: 320,
            reasoning: 320,
            cache: {
              read: 0,
              write: 0,
            },
          },
          modelID: "gpt-5.4",
          providerID: "github-copilot",
          time: {
            created: assistantCreatedAt,
            completed: assistantCompletedAt,
          },
          finish: "stop",
          id: assistantMessageId,
          sessionID: fixture.sessionId,
        },
        parts: [
          {
            type: "step-start",
            snapshot: `snapshot_${assistantMessageId}_start`,
            id: assistantStepStartPartId,
            sessionID: fixture.sessionId,
            messageID: assistantMessageId,
          },
          {
            type: "text",
            text: fixture.assistantReply,
            time: {
              start: assistantCreatedAt + 500,
              end: assistantCreatedAt + 2_500,
            },
            id: assistantTextPartId,
            sessionID: fixture.sessionId,
            messageID: assistantMessageId,
          },
          {
            type: "step-finish",
            reason: "stop",
            snapshot: `snapshot_${assistantMessageId}_finish`,
            tokens: {
              total: 1280,
              input: 640,
              output: 320,
              reasoning: 320,
              cache: {
                read: 0,
                write: 0,
              },
            },
            cost: 0,
            id: assistantStepFinishPartId,
            sessionID: fixture.sessionId,
            messageID: assistantMessageId,
          },
        ],
      },
    ],
  };
}

function buildRecordingMessageId(sessionId: string, suffix: string) {
  return `msg_${sessionId.replace(/^ses_?/, "").slice(0, 20)}_${suffix}`;
}

function buildRecordingPartId(messageId: string, suffix: string) {
  return `prt_${messageId.replace(/^msg_?/, "").slice(0, 20)}_${suffix}`;
}

function createSandboxEnvironment(env: NodeJS.ProcessEnv, sandbox: RecordingSandbox): NodeJS.ProcessEnv {
  return {
    ...env,
    XDG_DATA_HOME: sandbox.dataHomePath,
    XDG_CACHE_HOME: sandbox.cacheHomePath,
    XDG_CONFIG_HOME: sandbox.configHomePath,
    XDG_STATE_HOME: sandbox.stateHomePath,
  };
}
