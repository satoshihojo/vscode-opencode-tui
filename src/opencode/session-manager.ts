import * as path from "node:path";
import { BRIDGE_PORT_ENV } from "../bridge-protocol";
import { OPENCODE_TERMINAL_VIEW_COLUMN } from "../layout/side-by-side-layout";
import { parseWslUncPath, resolveOpenCodeCommand } from "./command";

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
    // When resuming a session whose cwd is a WSL UNC path (e.g. open of a
    // session created inside WSL), spawn the terminal inside WSL itself via
    // wsl.exe. Use the bare "opencode" shim rather than the Windows opencode.cmd
    // wrapper — the WSL bash shell resolves opencode from ~/.bashrc's PATH.
    const wslBridge = options.cwd ? parseWslUncPath(options.cwd) : undefined;
    const openCodeToken = wslBridge ? this.command.trim() || "opencode" : resolveOpenCodeCommand(this.command);
    const rawCommand = `${openCodeToken} --port ${openCodePort}${toSessionArgument(options)}`;
    // When bridging into WSL via wsl.exe, also rebind the bridge env so it
    // survives the WSL boundary and can reach the Windows-side bridge server
    // from inside the WSL bash. Without this, wsl.exe drops the bridge env
    // vars (they aren't in WSLENV), the embedded plugin URL points at a
    // Windows drive WSL can't import, and OPENCODE_VSCODE_BRIDGE_URL's
    // 127.0.0.1 resolves to the WSL bash own loopback instead of the Windows
    // host. buildWslBridgeCommand augments WSLENV, translates the plugin
    // URL to a /mnt/<drive>/... form, drops the Windows-side URL, and
    // prepends a bash preamble that auto-detects the WSL-reachable Windows
    // host IP and rebuilds OPENCODE_VSCODE_BRIDGE_URL at runtime.
    const wslBridgePort = wslBridge ? resolveBridgePortForWsl(env[BRIDGE_PORT_ENV]) : undefined;
    const command = wslBridge && wslBridgePort
      ? buildWslBridgeCommand(rawCommand, env, baseEnv, wslBridgePort)
      : rawCommand;
    const terminalName = options.sessionLabel?.trim()
      ? buildOpenCodeTerminalName(options)
      : options.terminalName ?? buildOpenCodeTerminalName(options);

    return {
      command,
      env,
      strictEnv: true,
      cwd: wslBridge ? undefined : options.cwd,
      shellPath: wslBridge ? "wsl.exe" : terminalShellOverride?.shellPath,
      shellArgs: wslBridge ? ["-d", wslBridge.distro, "--cd", wslBridge.path] : terminalShellOverride?.shellArgs,
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

function resolveBridgePortForWsl(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}

export function buildWslBridgeCommand(
  rawCommand: string,
  env: Record<string, string>,
  baseEnv: NodeJS.ProcessEnv,
  bridgePort: number,
): string {
  // OPENCODE_CONFIG_CONTENT embeds plugin URLs as Windows-side file:// URLs
  // (e.g. file:///C:/Users/.../dist/vscode-bridge-plugin.mjs). WSL opencode
  // cannot import those. WSLENV only translates per-var path values, not URLs
  // inside a JSON string, so rewrite them here before they cross the WSL
  // boundary into /mnt/<drive>/... form.
  if (env.OPENCODE_CONFIG_CONTENT) {
    env.OPENCODE_CONFIG_CONTENT = translateConfigContentPluginUrlsForWsl(env.OPENCODE_CONFIG_CONTENT);
  }

  // Drop the Windows-side 127.0.0.1 bridge URL. Inside WSL2, 127.0.0.1 refers
  // to the WSL bash own loopback, not the Windows host where the bridge
  // server actually listens (bound on 0.0.0.0). The bash preamble below
  // reconstructs OPENCODE_VSCODE_BRIDGE_URL with the WSL-reachable Windows
  // host IP at runtime.
  if (env.OPENCODE_VSCODE_BRIDGE_URL) {
    delete env.OPENCODE_VSCODE_BRIDGE_URL;
  }

  // wsl.exe only forwards env vars listed in WSLENV. Augment WSLENV with the
  // bridge/session keys so the WSL bash sees them. Mark OPENCODE_TUI_CONFIG
  // with /p so wsl.exe auto-translates the Windows-style absolute path to a
  // /mnt/<drive>/... WSL path across the boundary.
  const wslBridgeEnvKeys = collectWslBridgeEnvKeys(env);
  const wslenvEntries = wslBridgeEnvKeys.map((key) =>
    key === "OPENCODE_TUI_CONFIG" ? `${key}/p` : key,
  );
  env.WSLENV = augmentWslenvForWslBridge(baseEnv.WSLENV, wslenvEntries);

  // Resolve the Windows host IP from inside WSL at runtime, then export the
  // bridge URL with a parameter-expansion fallback. On WSL2 NAT, the default
  // route's next hop is the Windows host; on Windows 11 mirrored networking or
  // WSL1 there is no `default` route, so the lookup yields empty and
  // `${WIN_HOST_IP:-127.0.0.1}` falls back to loopback (which reaches the
  // Windows host in those modes).
  return `WIN_HOST_IP=$(ip route show default 2>/dev/null | awk '/^default/ {print $3; exit}'); export OPENCODE_VSCODE_BRIDGE_URL="http://\${WIN_HOST_IP:-127.0.0.1}:${bridgePort}/bridge"; ${rawCommand}`;
}

function collectWslBridgeEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) =>
    key.startsWith("OPENCODE_")
    || key === "_EXTENSION_OPENCODE_PORT"
    || key === "EDITOR"
    || key === "VISUAL",
  );
}

export function augmentWslenvForWslBridge(existingWslenv: string | undefined, keys: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  const existingList = (existingWslenv ?? "")
    .split(/:/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const entry of existingList) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  for (const entry of keys) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(":");
}

export function translateConfigContentPluginUrlsForWsl(configContent: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return configContent;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return configContent;
  }
  const record = parsed as Record<string, unknown>;
  const pluginField = record.plugin;
  if (!Array.isArray(pluginField)) {
    return configContent;
  }
  let mutated = false;
  const translated = pluginField.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const next = translateWindowsFileUrlToWsl(entry);
    if (next !== entry) {
      mutated = true;
    }
    return next;
  });
  if (!mutated) {
    return configContent;
  }
  record.plugin = translated;
  return JSON.stringify(record);
}

export function translateWindowsFileUrlToWsl(url: string): string {
  // Match file:///<drive>:(/|\)<rest> as emitted by vscode.Uri.file on
  // Windows (the colon may also be %-encoded as %3A). Translate to
  // file:///mnt/<lower-drive>/<rest> with forward slashes.
  const match = url.match(/^file:\/\/\/([A-Za-z])(?::|%3A)([\\\/])(.*)$/i);
  if (!match) {
    return url;
  }
  const drive = match[1].toLowerCase();
  const rest = match[3].replace(/\\/g, "/");
  return `file:///mnt/${drive}/${rest}`;
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
