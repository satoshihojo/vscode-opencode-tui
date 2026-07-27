import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  augmentWslenvForWslBridge,
  buildOpenCodeRelaunchCommand,
  buildOpenCodeTerminalName,
  buildSessionConfigContent,
  createSessionEnvironment,
  OpenCodeSessionManager,
  readWindowsEditorExecutable,
  translateConfigContentPluginUrlsForWsl,
  translateWindowsFileUrlToWsl,
} from "../../src/opencode/session-manager";
import { resolveOpenCodeCommand, resolveOpenCodeSpawnCommand, resolveWslBridgedSpawn, isWslBridgeRequired, parseWslUncPath } from "../../src/opencode/command";

describe("buildSessionConfigContent", () => {
  it("builds a deterministic session config without mutating the base config", () => {
    const baseConfig = {
      mcp: {
        existing: {
          type: "remote",
          url: "http://127.0.0.1:7000/mcp",
        },
      },
    };

    const serialized = buildSessionConfigContent(baseConfig, {
      disableBuiltinEditing: true,
      mcpServerName: "vscode",
      mcpUrl: "http://127.0.0.1:8787/mcp",
      mcpHeaders: {
        "x-opencode-vscode-bridge-token": "secret",
      },
    });
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    assert.deepEqual(parsed.permission, {
      edit: "deny",
    });
    assert.deepEqual((parsed.mcp as Record<string, unknown>).existing, {
      type: "remote",
      url: "http://127.0.0.1:7000/mcp",
    });
    assert.deepEqual((parsed.mcp as Record<string, unknown>).vscode, {
      type: "remote",
      url: "http://127.0.0.1:8787/mcp",
      headers: {
        "x-opencode-vscode-bridge-token": "secret",
      },
    });
    assert.deepEqual(baseConfig, {
      mcp: {
        existing: {
          type: "remote",
          url: "http://127.0.0.1:7000/mcp",
        },
      },
    });
  });
});

describe("resolveOpenCodeCommand", () => {
  it("uses the Windows command shim when launching opencode by name", () => {
    assert.equal(resolveOpenCodeCommand("opencode", "win32"), "opencode.cmd");
    assert.equal(resolveOpenCodeCommand("opencode.cmd", "win32"), "opencode.cmd");
    assert.equal(resolveOpenCodeCommand("C:\\Program Files\\OpenCode\\opencode.cmd", "win32"), '"C:\\Program Files\\OpenCode\\opencode.cmd"');
    assert.equal(resolveOpenCodeCommand("C:\\Program Files\\OpenCode\\opencode.exe", "win32"), '"C:\\Program Files\\OpenCode\\opencode.exe"');
    assert.equal(resolveOpenCodeCommand("npx opencode", "win32"), "npx opencode");
    assert.equal(resolveOpenCodeCommand("opencode", "linux"), "opencode");
  });

  it("keeps repository subprocess commands shell-independent", () => {
    assert.deepEqual(resolveOpenCodeSpawnCommand("opencode", ["db", "path"], "linux"), {
      command: "opencode",
      args: ["db", "path"],
    });
    assert.deepEqual(resolveOpenCodeSpawnCommand("opencode", ["db", "path"], "win32"), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "opencode.cmd", "db", "path"],
    });
    assert.deepEqual(resolveOpenCodeSpawnCommand("npx opencode", ["db", "path"], "win32"), {
      command: "npx opencode",
      args: ["db", "path"],
    });
    assert.deepEqual(resolveOpenCodeSpawnCommand("C:\\Program Files\\OpenCode\\opencode.cmd", ["db", "path"], "win32"), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Program Files\\OpenCode\\opencode.cmd", "db", "path"],
    });
    assert.deepEqual(resolveOpenCodeSpawnCommand("\"C:\\Program Files\\OpenCode\\opencode.cmd\"", ["db", "path"], "win32"), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Program Files\\OpenCode\\opencode.cmd", "db", "path"],
    });
    assert.deepEqual(resolveOpenCodeSpawnCommand("C:\\Program Files\\OpenCode\\opencode.exe", ["db", "path"], "win32"), {
      command: "C:\\Program Files\\OpenCode\\opencode.exe",
      args: ["db", "path"],
    });
  });

  describe("resolveWslBridgedSpawn", () => {
    it("returns undefined on linux regardless of cwd", () => {
      assert.equal(
        resolveWslBridgedSpawn("opencode", ["db", "path"], "\\\\wsl.localhost\\Ubuntu\\home\\me", "linux"),
        undefined,
      );
    });

    it("returns undefined when cwd is undefined", () => {
      assert.equal(resolveWslBridgedSpawn("opencode", ["db", "path"], undefined, "win32"), undefined);
    });

    it("returns undefined when cwd is not a WSL UNC path", () => {
      assert.equal(resolveWslBridgedSpawn("opencode", ["db", "path"], "C:\\Users\\me", "win32"), undefined);
    });

    it("returns undefined when command is not the bare opencode shim", () => {
      assert.equal(
        resolveWslBridgedSpawn("C:\\Program Files\\opencode.exe", ["db", "path"], "\\\\wsl.localhost\\Ubuntu\\home\\me", "win32"),
        undefined,
      );
    });

    it("bridges a wsl.localhost UNC path through wsl.exe", () => {
      assert.deepEqual(
        resolveWslBridgedSpawn("opencode", ["db", "path"], "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", "win32"),
        {
          command: "wsl.exe",
          args: ["-d", "Ubuntu", "--cd", "/home/me/proj", "-e", "bash", "-ic", "opencode 'db' 'path'"],
          cwd: undefined,
        },
      );
    });

    it("bridges a legacy wsl$ UNC path through wsl.exe", () => {
      assert.deepEqual(
        resolveWslBridgedSpawn("opencode", ["db", "path"], "\\\\wsl$\\Debian\\root\\proj", "win32"),
        {
          command: "wsl.exe",
          args: ["-d", "Debian", "--cd", "/root/proj", "-e", "bash", "-ic", "opencode 'db' 'path'"],
          cwd: undefined,
        },
      );
    });

    it("shell-quotes opencode args containing single quotes (SQL literals)", () => {
      assert.deepEqual(
        resolveWslBridgedSpawn("opencode", ["db", "select * from session where id = 'ses_1'", "--format", "json"], "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", "win32"),
        {
          command: "wsl.exe",
          args: ["-d", "Ubuntu", "--cd", "/home/me/proj", "-e", "bash", "-ic", "opencode 'db' 'select * from session where id = '\\''ses_1'\\''' '--format' 'json'"],
          cwd: undefined,
        },
      );
    });
  });

  describe("isWslBridgeRequired", () => {
    it("returns true for a win32 WSL UNC cwd", () => {
      assert.equal(isWslBridgeRequired("\\\\wsl.localhost\\Ubuntu\\home\\me", "win32"), true);
    });

    it("returns false for a non-UNC win32 cwd", () => {
      assert.equal(isWslBridgeRequired("C:\\Users\\me", "win32"), false);
    });

    it("returns false for an undefined cwd", () => {
      assert.equal(isWslBridgeRequired(undefined, "win32"), false);
    });

    it("returns false on linux", () => {
      assert.equal(isWslBridgeRequired("\\\\wsl.localhost\\Ubuntu\\home\\me", "linux"), false);
    });
  });

  describe("parseWslUncPath", () => {
    it("parses a wsl.localhost path with a deep tail", () => {
      assert.deepEqual(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj"), {
        distro: "Ubuntu",
        path: "/home/me/proj",
      });
    });

    it("parses a legacy wsl$ path", () => {
      assert.deepEqual(parseWslUncPath("\\\\wsl$\\Debian\\root"), { distro: "Debian", path: "/root" });
    });

    it("returns undefined for a plain drive path", () => {
      assert.equal(parseWslUncPath("C:\\Users\\me"), undefined);
    });

    it("returns undefined for a non-UNC path", () => {
      assert.equal(parseWslUncPath("/home/me"), undefined);
    });
  });
});

describe("createSessionEnvironment", () => {
  it("adds session-local opencode variables without mutating the base env", () => {
    const baseEnv = {
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "secret",
      OPENCODE_API_KEY: "also-secret",
    };

    const env = createSessionEnvironment(baseEnv, "{\"ok\":true}");

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.OPENCODE_API_KEY, undefined);
    assert.equal(env.OPENCODE_CALLER, "vscode");
    assert.equal(env.OPENCODE_CONFIG_CONTENT, "{\"ok\":true}");
    assert.deepEqual(baseEnv, {
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "secret",
      OPENCODE_API_KEY: "also-secret",
    });
  });

  it("forwards safe GUI session variables needed for clipboard integration without forwarding secrets", () => {
    const env = createSessionEnvironment({
      DISPLAY: ":1",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/run/user/1000/.Xauthority",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_SESSION_TYPE: "wayland",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      AWS_SESSION_TOKEN: "secret",
    }, "{}");

    assert.equal(env.DISPLAY, ":1");
    assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
    assert.equal(env.XAUTHORITY, "/run/user/1000/.Xauthority");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    assert.equal(env.XDG_SESSION_TYPE, "wayland");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
  });
});

describe("readWindowsEditorExecutable", () => {
  it("recognizes stable and insiders VS Code executables", () => {
    assert.equal(readWindowsEditorExecutable("C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"), "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe");
    assert.equal(readWindowsEditorExecutable("C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"), "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe");
    assert.equal(readWindowsEditorExecutable("C:\\Program Files\\nodejs\\node.exe"), undefined);
  });
});

describe("OpenCodeSessionManager", () => {
  it("merges extra bridge environment into the spawned terminal and starts opencode with a separate app port", () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedLocation: unknown;
    let capturedName = "";
    let capturedStrictEnv: boolean | undefined;
    let sentCommand = "";

    const sessionManager = new OpenCodeSessionManager(
      ({ name, env, strictEnv, location }) => {
        capturedName = name;
        capturedEnv = env;
        capturedStrictEnv = strictEnv;
        capturedLocation = location;
        return {
          show() {},
          sendText(value: string) {
            sentCommand = value;
          },
        };
      },
      () => "{\"plugin\":[]}",
      () => ({ OPENCODE_VSCODE_BRIDGE_URL: "http://127.0.0.1:9000/bridge" }),
      { openCodePortFactory: () => 9001 },
    );

    const result = sessionManager.startSession({ PATH: "/usr/bin" });

    assert.equal(capturedEnv?.OPENCODE_VSCODE_BRIDGE_URL, "http://127.0.0.1:9000/bridge");
    assert.equal(capturedEnv?.OPENCODE_CONFIG_CONTENT, "{\"plugin\":[]}");
    assert.equal(capturedEnv?._EXTENSION_OPENCODE_PORT, "9001");
    assert.equal(capturedStrictEnv, true);
    assert.deepEqual(capturedLocation, {
      viewColumn: 2,
      preserveFocus: false,
    });
    assert.equal(capturedName, "new session");
    assert.equal(sentCommand, `${process.platform === "win32" ? "opencode.cmd" : "opencode"} --port 9001`);
    assert.equal(result.openCodePort, 9001);
  });

  it("retries when the generated OpenCode port matches the bridge port", () => {
    const ports = [9000, 9002];
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({ OPENCODE_VSCODE_BRIDGE_URL: "http://127.0.0.1:9000/bridge" }),
      { openCodePortFactory: () => ports.shift() ?? 9003 },
    );

    const launch = sessionManager.buildLaunchSpec({ PATH: "/usr/bin" });

    assert.equal(launch.command, `${process.platform === "win32" ? "opencode.cmd" : "opencode"} --port 9002`);
    assert.equal(launch.env._EXTENSION_OPENCODE_PORT, "9002");
  });

  it("can explicitly continue the latest session when requested", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({ OPENCODE_VSCODE_BRIDGE_URL: "not-a-url" }),
      { openCodePortFactory: () => 9004 },
    );

    const launch = sessionManager.buildLaunchSpec({ PATH: "/usr/bin" }, { continueLast: true });

    assert.equal(launch.command, `${process.platform === "win32" ? "opencode.cmd" : "opencode"} --port 9004 -c`);
    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_URL, "not-a-url");
    assert.equal(launch.env.OPENCODE_CONFIG_CONTENT, "{\"plugin\":[]}");
  });

  it("continues a specific session id when supplied", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({ OPENCODE_VSCODE_BRIDGE_URL: "not-a-url" }),
      { openCodePortFactory: () => 9004 },
    );

    const launch = sessionManager.buildLaunchSpec({ PATH: "/usr/bin" }, { sessionId: "ses_123abc" });

    assert.equal(launch.command, `${process.platform === "win32" ? "opencode.cmd" : "opencode"} --port 9004 -s ses_123abc`);
    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_URL, "not-a-url");
    assert.equal(launch.env.OPENCODE_CONFIG_CONTENT, "{\"plugin\":[]}");
  });

  it("rejects invalid explicit session ids", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9005 },
    );

    assert.throws(
      () => sessionManager.buildLaunchSpec({ PATH: "/usr/bin" }, { sessionId: "bad" }),
      /Invalid OpenCode session id: bad/,
    );
  });

  it("starts forked sessions in the requested cwd with a descriptive terminal name", () => {
    let capturedCwd = "";
    let capturedName = "";
    const sessionManager = new OpenCodeSessionManager(
      ({ name, cwd }) => {
        capturedName = name;
        capturedCwd = cwd ?? "";
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9006 },
    );

    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", fork: true, cwd: "/workspace-a", sessionLabel: "Long Session Title" },
    );
    sessionManager.startSession(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", fork: true, cwd: "/workspace-a", sessionLabel: "Long Session Title" },
    );

    assert.equal(launch.command, `${process.platform === "win32" ? "opencode.cmd" : "opencode"} --port 9006 --fork -s ses_abcdef123456`);
    assert.equal(launch.cwd, "/workspace-a");
    assert.equal(capturedCwd, "/workspace-a");
    assert.equal(capturedName, "Long Session Title");
  });

  it("launches opencode inside wsl.exe when the session cwd is a WSL UNC path", () => {
    let capturedShellPath: string | undefined;
    let capturedShellArgs: string[] | undefined;
    let capturedCwd: string | undefined;
    const sessionManager = new OpenCodeSessionManager(
      ({ cwd, shellPath, shellArgs }) => {
        capturedCwd = cwd;
        capturedShellPath = shellPath;
        capturedShellArgs = shellArgs;
        return { show() {}, sendText() {} };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9020 },
    );

    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", cwd, sessionLabel: "WSL session" },
    );
    sessionManager.startSession(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", cwd, sessionLabel: "WSL session" },
    );

    assert.equal(launch.command, "opencode --port 9020 -s ses_abcdef123456");
    assert.equal(launch.cwd, undefined);
    assert.equal(launch.shellPath, "wsl.exe");
    assert.deepEqual(launch.shellArgs, ["-d", "Ubuntu", "--cd", "/home/me/proj"]);
    assert.equal(capturedCwd, undefined);
    assert.equal(capturedShellPath, "wsl.exe");
    assert.deepEqual(capturedShellArgs, ["-d", "Ubuntu", "--cd", "/home/me/proj"]);
  });

  it("uses explicit editor environment for terminal-launched editor commands", () => {
    let capturedEnv: Record<string, string> | undefined;
    const sessionManager = new OpenCodeSessionManager(
      ({ env }) => {
        capturedEnv = env;
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9011 },
    );

    sessionManager.startSession({ PATH: "/usr/bin" });

    assert.equal(capturedEnv?.EDITOR, process.platform === "win32" ? "code.cmd --wait" : "code --wait");
    assert.equal(capturedEnv?.VISUAL, process.platform === "win32" ? "code.cmd --wait" : "code --wait");
  });

  it("preserves user-provided editor environment", () => {
    let capturedEnv: Record<string, string> | undefined;
    const sessionManager = new OpenCodeSessionManager(
      ({ env }) => {
        capturedEnv = env;
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9012 },
    );

    sessionManager.startSession({
      PATH: "/usr/bin",
      EDITOR: "custom-editor --wait",
      VISUAL: "custom-visual --wait",
    });

    assert.equal(capturedEnv?.EDITOR, "custom-editor --wait");
    assert.equal(capturedEnv?.VISUAL, "custom-visual --wait");
  });

  it("mirrors a single user-provided editor variable into the missing one", () => {
    let capturedEnv: Record<string, string> | undefined;
    const sessionManager = new OpenCodeSessionManager(
      ({ env }) => {
        capturedEnv = env;
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9013 },
    );

    sessionManager.startSession({
      PATH: "/usr/bin",
      EDITOR: "custom-editor --wait",
    });

    assert.equal(capturedEnv?.EDITOR, "custom-editor --wait");
    assert.equal(capturedEnv?.VISUAL, "custom-editor --wait");
  });

  it("uses a sanitized bash prompt for screencast recording sessions", () => {
    let capturedShellPath: string | undefined;
    let capturedShellArgs: string[] | undefined;
    let capturedEnv: Record<string, string> | undefined;
    const expectedShellPath = process.platform === "win32" ? undefined : "bash";
    const expectedShellArgs = process.platform === "win32" ? undefined : ["--noprofile", "--norc"];

    const sessionManager = new OpenCodeSessionManager(
      ({ env, shellPath, shellArgs }) => {
        capturedEnv = env;
        capturedShellPath = shellPath;
        capturedShellArgs = shellArgs;
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9009 },
    );

    sessionManager.startSession({
      PATH: "/usr/bin",
      OPENCODE_EDIT_SCREENCAST_MODE: "1",
    });

    assert.equal(capturedShellPath, expectedShellPath);
    assert.deepEqual(capturedShellArgs, expectedShellArgs);
    assert.equal(capturedEnv?.PS1, process.platform === "win32" ? undefined : "$ ");
    assert.equal(capturedEnv?.PROMPT_COMMAND, process.platform === "win32" ? undefined : "");
  });

  it("does not override the shell for normal sessions", () => {
    let capturedShellPath: string | undefined;
    let capturedShellArgs: string[] | undefined;

    const sessionManager = new OpenCodeSessionManager(
      ({ shellPath, shellArgs }) => {
        capturedShellPath = shellPath;
        capturedShellArgs = shellArgs;
        return {
          show() {},
          sendText() {},
        };
      },
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9010 },
    );

    sessionManager.startSession({ PATH: "/usr/bin" });

    assert.equal(capturedShellPath, undefined);
    assert.equal(capturedShellArgs, undefined);
  });

  it("builds short terminal names without the opencode prefix", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9007 },
    );

    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionLabel: "0123456789abcdefghijklmnopqrstuvwxyz" },
    );

    assert.equal(launch.terminalName, "0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("strips the opencode-tui-integration workspace suffix from session labels", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9008 },
    );

    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionLabel: "Feature work - opencode-tui-integration" },
    );

    assert.equal(launch.terminalName, "Feature work");
  });

  it("keeps trimming stable for tab titles", () => {
    assert.equal(
      buildOpenCodeTerminalName({ sessionLabel: "MCP経由でOpenCode編集セッション - opencode-tui-integration" }),
      "MCP経由でOpenCode編集セッション",
    );
  });

  it("throws after repeated OpenCode port collisions with the bridge port", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({ OPENCODE_VSCODE_BRIDGE_URL: "http://127.0.0.1:9000/bridge" }),
      { openCodePortFactory: () => 9000 },
    );

    assert.throws(
      () => sessionManager.buildLaunchSpec({ PATH: "/usr/bin" }),
      /Unable to choose an OpenCode port distinct from the VS Code bridge port/,
    );
  });

  it("throws when the generated OpenCode port is invalid", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({
        show() {},
        sendText() {},
      }),
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 0 },
    );

    assert.throws(
      () => sessionManager.buildLaunchSpec({ PATH: "/usr/bin" }),
      /Invalid OpenCode port: 0/,
    );
  });

  it("builds a POSIX relaunch command with tracked OpenCode and editor env vars", () => {
    const command = buildOpenCodeRelaunchCommand(
      "opencode --port 9001 -s ses_123abc",
      {
        OPENCODE_CALLER: "vscode",
        OPENCODE_CONFIG_CONTENT: "simple",
        _EXTENSION_OPENCODE_PORT: "9001",
        EDITOR: "code --wait",
        VISUAL: "code --wait",
        PATH: "/usr/bin",
      },
      "posix",
    );

    assert.equal(
      command,
      `OPENCODE_CALLER='vscode' OPENCODE_CONFIG_CONTENT='simple' _EXTENSION_OPENCODE_PORT='9001' EDITOR='code --wait' VISUAL='code --wait' opencode --port 9001 -s ses_123abc`,
    );
  });

  it("keeps TUI config when rebuilding a relaunch command for an existing terminal", () => {
    const command = buildOpenCodeRelaunchCommand(
      "opencode --port 9000",
      {
        OPENCODE_TUI_CONFIG: "/tmp/tui.json",
        OPENCODE_VSCODE_BRIDGE_URL: "http://127.0.0.1:1234",
        _EXTENSION_OPENCODE_PORT: "9000",
        PATH: "/usr/bin",
      },
      "posix",
    );

    assert.equal(
      command,
      "OPENCODE_TUI_CONFIG='/tmp/tui.json' OPENCODE_VSCODE_BRIDGE_URL='http://127.0.0.1:1234' _EXTENSION_OPENCODE_PORT='9000' opencode --port 9000",
    );
  });

  it("builds a PowerShell relaunch command with escaped values", () => {
    const command = buildOpenCodeRelaunchCommand(
      "opencode --port 9002",
      {
        OPENCODE_CALLER: "vscode",
        OPENCODE_CONFIG_CONTENT: "it's fine",
      },
      "powershell",
    );

    assert.equal(
      command,
      "$env:OPENCODE_CALLER='vscode'; $env:OPENCODE_CONFIG_CONTENT='it''s fine'; opencode --port 9002",
    );
  });

  it("builds a cmd relaunch command with escaped percent and quotes", () => {
    const command = buildOpenCodeRelaunchCommand(
      "opencode --port 9003",
      {
        OPENCODE_CONFIG_CONTENT: '100% "quoted"',
      },
      "cmd",
    );

    assert.equal(
      command,
      'set "OPENCODE_CONFIG_CONTENT=100%% ""quoted""" && opencode --port 9003',
    );
  });
});

describe("translateWindowsFileUrlToWsl", () => {
  it("translates a Windows file:///DRIVE:/ URL to /mnt/<drive>/...", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("file:///C:/Users/me/foo.mjs"),
      "file:///mnt/c/Users/me/foo.mjs",
    );
  });

  it("translates a %-encoded Windows file:///DRIVE%3A URL", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("file:///C%3A/Users/me/foo.mjs"),
      "file:///mnt/c/Users/me/foo.mjs",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("file:///D:\\Users\\me\\foo.mjs"),
      "file:///mnt/d/Users/me/foo.mjs",
    );
  });

  it("lower-cases the drive letter", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("file:///D:/FP/Foo.mjs"),
      "file:///mnt/d/FP/Foo.mjs",
    );
  });

  it("leaves non-file:/// URLs unchanged", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("http://127.0.0.1:1234/bridge"),
      "http://127.0.0.1:1234/bridge",
    );
  });

  it("leaves already-translated /mnt/<drive>/ URLs unchanged", () => {
    assert.equal(
      translateWindowsFileUrlToWsl("file:///mnt/c/Users/me/foo.mjs"),
      "file:///mnt/c/Users/me/foo.mjs",
    );
  });
});

describe("translateConfigContentPluginUrlsForWsl", () => {
  it("translates plugin URLs inside OPENCODE_CONFIG_CONTENT", () => {
    const input = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        "file:///C:/Users/me/.vscode/extensions/satoshihojo.opencode-tui-integration-0.1.1/dist/vscode-bridge-plugin.mjs",
      ],
    });
    const output = translateConfigContentPluginUrlsForWsl(input);
    const parsed = JSON.parse(output) as { plugin: string[] };
    assert.equal(
      parsed.plugin[0],
      "file:///mnt/c/Users/me/.vscode/extensions/satoshihojo.opencode-tui-integration-0.1.1/dist/vscode-bridge-plugin.mjs",
    );
  });

  it("returns the input unchanged when no file:// URLs need translation", () => {
    const input = JSON.stringify({
      plugin: ["file:///mnt/c/Users/me/foo.mjs"],
    });
    assert.equal(translateConfigContentPluginUrlsForWsl(input), input);
  });

  it("returns the input unchanged when JSON parsing fails", () => {
    assert.equal(translateConfigContentPluginUrlsForWsl("not json"), "not json");
  });

  it("preserves other config fields when translating plugin URLs", () => {
    const input = JSON.stringify({
      permission: { edit: "deny" } as Record<string, unknown>,
      plugin: ["file:///C:/foo.mjs"],
    });
    const output = translateConfigContentPluginUrlsForWsl(input);
    const parsed = JSON.parse(output) as {
      permission: Record<string, unknown>;
      plugin: string[];
    };
    assert.deepEqual(parsed.permission, { edit: "deny" });
    assert.equal(parsed.plugin[0], "file:///mnt/c/foo.mjs");
  });
});

describe("augmentWslenvForWslBridge", () => {
  it("joins keys with colons when WSLENV is undefined", () => {
    assert.equal(
      augmentWslenvForWslBridge(undefined, ["FOO", "BAR"]),
      "FOO:BAR",
    );
  });

  it("preserves user-provided WSLENV entries and appends new keys", () => {
    assert.equal(
      augmentWslenvForWslBridge("EXISTING/p:OTHER", ["FOO", "BAR"]),
      "EXISTING/p:OTHER:FOO:BAR",
    );
  });

  it("deduplicates keys already present in user-provided WSLENV", () => {
    assert.equal(
      augmentWslenvForWslBridge("FOO:EXISTING", ["FOO", "BAR"]),
      "FOO:EXISTING:BAR",
    );
  });
});

describe("OpenCodeSessionManager WSL bridge env translation", () => {
  it("translates plugin URLs, removes the 127.0.0.1 bridge URL, augments WSLENV, and prepends a WIN_HOST_IP preamble when bridge server env is present", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({ show() {}, sendText() {} }),
      () => JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [
          "file:///C:/Users/me/.vscode/extensions/satoshihojo.opencode-tui-integration-0.1.1/dist/vscode-bridge-plugin.mjs",
        ],
      }),
      () => ({
        OPENCODE_VSCODE_BRIDGE_URL: "http://127.0.0.1:9000/bridge",
        OPENCODE_VSCODE_BRIDGE_PORT: "9000",
        OPENCODE_VSCODE_BRIDGE_TOKEN: "secret",
        OPENCODE_VSCODE_WORKSPACE_ROOTS: JSON.stringify(["\\\\wsl.localhost\\Ubuntu\\home\\me\\proj"]),
        OPENCODE_TUI_CONFIG: "C:\\Users\\me\\.vscode\\extensions\\satoshihojo.opencode-tui-integration-0.1.1\\dist\\vscode-tui-config.json",
      }),
      { openCodePortFactory: () => 9001 },
    );

    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", cwd, sessionLabel: "WSL session" },
    );

    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_URL, undefined);
    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_PORT, "9000");
    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_TOKEN, "secret");

    const configContent = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT) as { plugin: string[] };
    assert.equal(
      configContent.plugin[0],
      "file:///mnt/c/Users/me/.vscode/extensions/satoshihojo.opencode-tui-integration-0.1.1/dist/vscode-bridge-plugin.mjs",
    );

    assert.ok(launch.env.WSLENV, "WSLENV should be set");
    for (const key of [
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CALLER",
      "OPENCODE_VSCODE_BRIDGE_PORT",
      "OPENCODE_VSCODE_BRIDGE_TOKEN",
      "OPENCODE_VSCODE_WORKSPACE_ROOTS",
      "OPENCODE_TUI_CONFIG/p",
      "_EXTENSION_OPENCODE_PORT",
    ]) {
      assert.ok(
        launch.env.WSLENV.includes(key),
        `WSLENV should include ${key} (actual: ${launch.env.WSLENV})`,
      );
    }

    assert.equal(launch.shellPath, "wsl.exe");
    assert.deepEqual(launch.shellArgs, ["-d", "Ubuntu", "--cd", "/home/me/proj"]);

    const expectedPreamble = `WIN_HOST_IP=$(ip route show default 2>/dev/null | awk '/^default/ {print $3; exit}'); export OPENCODE_VSCODE_BRIDGE_URL="http://\${WIN_HOST_IP:-127.0.0.1}:9000/bridge"; opencode --port 9001 -s ses_abcdef123456`;
    assert.equal(launch.command, expectedPreamble);
  });

  it("keeps the bare opencode command when no bridge port is supplied to a WSL UNC workspace", () => {
    const sessionManager = new OpenCodeSessionManager(
      () => ({ show() {}, sendText() {} }),
      () => "{\"plugin\":[]}",
      () => ({}),
      { openCodePortFactory: () => 9020 },
    );

    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj";
    const launch = sessionManager.buildLaunchSpec(
      { PATH: "/usr/bin" },
      { sessionId: "ses_abcdef123456", cwd, sessionLabel: "WSL session" },
    );

    assert.equal(launch.command, "opencode --port 9020 -s ses_abcdef123456");
    assert.equal(launch.env.OPENCODE_VSCODE_BRIDGE_URL, undefined);
    assert.equal(launch.env.WSLENV, undefined);
  });
});
