import * as path from "node:path";
import { OPENCODE_TERMINAL_VIEW_COLUMN } from "../layout/side-by-side-layout";
import { resolveOpenCodeCommand } from "./command";

type SessionManagerOptions = {
  openCodeCommand?: string;
  openCodePortFactory?: () => number;
};

type SessionLaunchSpec = {
  command: string;
  env: Record<string, string>;
  strictEnv: boolean;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
  terminalName: string;
  openCodePort: number;
  location: {
    viewColumn: number;
    preserveFocus: boolean;
  };
};

export type OpenCodeTerminalShell = "posix" | "powershell" | "cmd";

export type StartSessionOptions = {
  sessionId?: string;
  continueLast?: boolean;
  fork?: boolean;
  cwd?: string;
  terminalName?: string;
  sessionLabel?: string;
  updated?: number | string;
};

export type SessionConfigOverrides = {
  disableBuiltinEditing: boolean;
  mcpServerName?: string;
  mcpUrl?: string;
  mcpHeaders?: Record<string, string>;
};

type TerminalLike = {
  processId?: Thenable<number | undefined>;
  show(): void;
  sendText(text: string, addNewLine?: boolean): void;
};

type TerminalFactory = (options: {
  name: string;
  env: Record<string, string>;
  strictEnv: boolean;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
  location: SessionLaunchSpec["location"];
}) => TerminalLike;

type TerminalShellOverride = {
  shellPath: string;
  shellArgs: string[];
  env: Record<string, string>;
};

export class OpenCodeSessionManager {
  private readonly command: string;
  private readonly openCodePortFactory: () => number;

  constructor(
    private readonly createTerminal: TerminalFactory,
    private readonly configContent: () => string,
    private readonly extraEnvironment: () => Record<string, string> = () => ({}),
    options: SessionManagerOptions = {},
  ) {
    this.command = options.openCodeCommand ?? "opencode";
    this.openCodePortFactory = options.openCodePortFactory ?? createRandomOpenCodePort;
  }

  startSession(baseEnv: NodeJS.ProcessEnv = process.env, options: StartSessionOptions = {}) {
    const launch = this.buildLaunchSpec(baseEnv, options);
    return this.startLaunchSpec(launch);
  }

  startLaunchSpec(launch: SessionLaunchSpec) {
    const terminal = this.createTerminal({
      name: launch.terminalName,
      env: launch.env,
      strictEnv: launch.strictEnv,
      cwd: launch.cwd,
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
      location: launch.location,
    });

    terminal.show();
    terminal.sendText(launch.command);
    return {
      terminal,
      openCodePort: launch.openCodePort,
    };
  }

  buildLaunchSpec(baseEnv: NodeJS.ProcessEnv = process.env, options: StartSessionOptions = {}): SessionLaunchSpec {
    const extraEnvironment = this.extraEnvironment();
    const env = {
      ...createSessionEnvironment(baseEnv, this.configContent()),
      ...extraEnvironment,
    };
    applyDefaultEditorEnvironment(env, baseEnv);
    const terminalShellOverride = readTerminalShellOverride(baseEnv);
    if (terminalShellOverride) {
      Object.assign(env, terminalShellOverride.env);
    }

    const bridgePort = readPortFromBridgeUrl(extraEnvironment.OPENCODE_VSCODE_BRIDGE_URL);
    const openCodePort = this.createOpenCodePort(bridgePort);
    env._EXTENSION_OPENCODE_PORT = String(openCodePort);
    const command = `${resolveOpenCodeCommand(this.command)} --port ${openCodePort}${toSessionArgument(options)}`;
    const terminalName = options.sessionLabel?.trim()
      ? buildOpenCodeTerminalName(options)
      : options.terminalName ?? buildOpenCodeTerminalName(options);

    return {
      command,
      env,
      strictEnv: true,
      cwd: options.cwd,
      shellPath: terminalShellOverride?.shellPath,
      shellArgs: terminalShellOverride?.shellArgs,
      terminalName,
      openCodePort,
      location: {
        viewColumn: OPENCODE_TERMINAL_VIEW_COLUMN,
        preserveFocus: false,
      },
    };
  }

  private createOpenCodePort(reservedPort: number | undefined) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const port = normalizePort(this.openCodePortFactory());
      if (port !== reservedPort) {
        return port;
      }
    }

    throw new Error("Unable to choose an OpenCode port distinct from the VS Code bridge port.");
  }
}

function applyDefaultEditorEnvironment(env: Record<string, string>, baseEnv: NodeJS.ProcessEnv) {
  const editorCommand = env.EDITOR || env.VISUAL || readEditorCommand(baseEnv);
  if (!editorCommand) {
    return;
  }

  env.EDITOR = env.EDITOR || editorCommand;
  env.VISUAL = env.VISUAL || editorCommand;
}

function readEditorCommand(baseEnv: NodeJS.ProcessEnv) {
  if (baseEnv.EDITOR) {
    return baseEnv.EDITOR;
  }

  if (baseEnv.VISUAL) {
    return baseEnv.VISUAL;
  }

  if (process.platform !== "win32") {
    return "code --wait";
  }

  const editorExecutable = readWindowsEditorExecutable(process.execPath);
  if (editorExecutable) {
    return `${quoteCmdPath(editorExecutable)} --wait`;
  }

  return "code.cmd --wait";
}

export function readWindowsEditorExecutable(execPath: string) {
  const executableName = path.win32.basename(execPath).toLowerCase();
  if (executableName === "code.exe" || executableName === "code - insiders.exe") {
    return execPath;
  }

  return undefined;
}

function quoteCmdPath(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function toSessionArgument(options: StartSessionOptions) {
  if (options.sessionId) {
    if (!isValidSessionId(options.sessionId)) {
      throw new Error(`Invalid OpenCode session id: ${options.sessionId}`);
    }

    return `${options.fork ? " --fork" : ""} -s ${options.sessionId}`;
  }

  if (options.fork) {
    throw new Error("Forking an OpenCode session requires a session id.");
  }

  return options.continueLast ? " -c" : "";
}

export function isValidSessionId(sessionId: string) {
  return /^ses[A-Za-z0-9_]+$/.test(sessionId);
}

export function buildOpenCodeTerminalName(options: StartSessionOptions) {
  const sessionLabel = readCleanSessionLabel(options);
  if (sessionLabel) {
    return sessionLabel;
  }

  if (options.sessionId) {
    return options.sessionId.slice(0, 12);
  }

  return "new session";
}

export function buildOpenCodeRelaunchCommand(
  command: string,
  env: Record<string, string>,
  shell: OpenCodeTerminalShell,
) {
  const relevantEnv = Object.entries(env).filter(([key]) => isRelaunchEnvironmentVariable(key));
  if (relevantEnv.length === 0) {
    return command;
  }

  if (shell === "powershell") {
    return `${relevantEnv.map(([key, value]) => `$env:${key}=${quotePowerShellString(value)}`).join("; ")}; ${command}`;
  }

  if (shell === "cmd") {
    return `${relevantEnv.map(([key, value]) => `set \"${key}=${quoteCmdValue(value)}\"`).join(" && ")} && ${command}`;
  }

  return `${relevantEnv.map(([key, value]) => `${key}=${quotePosixString(value)}`).join(" ")} ${command}`;
}

function isRelaunchEnvironmentVariable(key: string) {
  return key.startsWith("OPENCODE_")
    || key === "_EXTENSION_OPENCODE_PORT"
    || key === "EDITOR"
    || key === "VISUAL";
}

function readTerminalShellOverride(baseEnv: NodeJS.ProcessEnv): TerminalShellOverride | undefined {
  if (baseEnv.OPENCODE_EDIT_SCREENCAST_MODE !== "1" || process.platform === "win32") {
    return undefined;
  }

  return {
    shellPath: "bash",
    shellArgs: ["--noprofile", "--norc"],
    env: {
      PS1: "$ ",
      PROMPT_COMMAND: "",
    },
  };
}

function stripWorkspaceSuffix(label: string) {
  return label
    .replace(/\s+[\-:|/]\s+opencode-tui-integration$/i, "")
    .replace(/\s+\(opencode-tui-integration\)$/i, "")
    .trim();
}

function readCleanSessionLabel(options: StartSessionOptions) {
  return options.sessionLabel?.trim()
    ? stripWorkspaceSuffix(options.sessionLabel.trim())
    : undefined;
}

function quotePosixString(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdValue(value: string) {
  return value.replace(/"/g, '""').replace(/%/g, "%%");
}

export function buildSessionConfigContent(
  baseConfig: Record<string, unknown>,
  overrides: SessionConfigOverrides,
): string {
  const nextConfig: Record<string, unknown> = deepClone(baseConfig);
  nextConfig.$schema = nextConfig.$schema ?? "https://opencode.ai/config.json";

  if (overrides.mcpServerName && overrides.mcpUrl) {
    nextConfig.mcp = {
      ...readRecord(nextConfig.mcp),
      [overrides.mcpServerName]: {
        type: "remote",
        url: overrides.mcpUrl,
        ...(overrides.mcpHeaders ? { headers: { ...overrides.mcpHeaders } } : {}),
      },
    };
  }

  if (overrides.disableBuiltinEditing) {
    nextConfig.permission = {
      ...readRecord(nextConfig.permission),
      edit: "deny",
    };
  }

  return JSON.stringify(nextConfig);
}

export function createSessionEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  configContent: string,
): Record<string, string> {
  const nextEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string" && shouldForwardBaseEnvironmentVariable(key)) {
      nextEnv[key] = value;
    }
  }

  nextEnv.OPENCODE_CALLER = "vscode";
  nextEnv.OPENCODE_CONFIG_CONTENT = configContent;
  return nextEnv;
}

function shouldForwardBaseEnvironmentVariable(key: string) {
  return SAFE_BASE_ENVIRONMENT_VARIABLES.has(key.toUpperCase());
}

const SAFE_BASE_ENVIRONMENT_VARIABLES = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "EDITOR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "VISUAL",
  "WINDIR",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_STATE_HOME",
]);

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function readPortFromBridgeUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const parsed = Number.parseInt(url.port, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createRandomOpenCodePort() {
  return Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
}

function normalizePort(value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid OpenCode port: ${value}`);
  }

  return value;
}
