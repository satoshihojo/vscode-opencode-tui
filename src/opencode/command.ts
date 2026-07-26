export function resolveWslBridgedSpawn(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; cwd: undefined } | undefined {
  if (platform !== "win32" || !cwd) {
    return undefined;
  }
  const wsl = parseWslUncPath(cwd);
  if (!wsl) {
    return undefined;
  }
  const trimmed = command.trim();
  // Bridge only the bare "opencode" shim: it exists inside WSL but not on the
  // Windows host. Any resolved absolute Windows executable or batch file is a
  // Windows-side install, so leave it to the normal resolver.
  if (trimmed !== "opencode") {
    return undefined;
  }
  // wsl.exe -e <cmd> spawns a non-login, non-interactive shell that does not
  // source ~/.bashrc, so the user's opencode install dir (e.g. ~/.opencode/bin,
  // added to PATH by ~/.bashrc) is never on PATH and execvpe(opencode) fails
  // with ENOENT. Run an interactive bash instead: bash -i sources ~/.bashrc,
  // and -c runs the opencode command then exits. Each opencode arg is POSIX
  // single-quote-escaped so SQL string literals (e.g. id = 'ses_1') survive.
  const bashCommand = `opencode ${args.map(shellQuoteForBash).join(" ")}`;
  return {
    command: "wsl.exe",
    args: ["-d", wsl.distro, "--cd", wsl.path, "-e", "bash", "-ic", bashCommand],
    cwd: undefined,
  };
}

function shellQuoteForBash(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function isWslBridgeRequired(cwd: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && !!cwd && parseWslUncPath(cwd) !== undefined;
}

export function parseWslUncPath(cwd: string): { distro: string; path: string } | undefined {
  const match = cwd.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i);
  if (!match) {
    return undefined;
  }
  return { distro: match[1], path: `/${match[2].replace(/\\/g, "/")}` };
}

export function buildWslUncPath(distro: string, linuxPath: string): string {
  const tail = linuxPath.replace(/^\//, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${distro}\\${tail}`;
}

export function resolveOpenCodeCommand(command: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") {
    return command;
  }

  const trimmedCommand = command.trim();
  if (trimmedCommand === "opencode") {
    return "opencode.cmd";
  }

  const executable = readWindowsPathExecutable(trimmedCommand);
  if (executable) {
    return quoteWindowsCommandExecutable(executable);
  }

  return command;
}

export function resolveOpenCodeSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
) {
  const trimmedCommand = command.trim();
  if (platform === "win32" && isWindowsShellCommand(trimmedCommand)) {
    const executable = readWindowsCommandExecutable(trimmedCommand);
    if (executable) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", executable, ...args],
      };
    }
  }

  if (platform === "win32") {
    const executable = readWindowsExecutablePath(trimmedCommand);
    if (executable) {
      return {
        command: executable,
        args: [...args],
      };
    }
  }

  return {
    command,
    args: [...args],
  };
}

function isWindowsShellCommand(command: string) {
  return command === "opencode" || isWindowsBatchFile(command);
}

function readWindowsCommandExecutable(command: string) {
  if (command === "opencode") {
    return "opencode.cmd";
  }

  return isWindowsBatchFile(command) ? stripSurroundingQuotes(command) : undefined;
}

function readWindowsPathExecutable(command: string) {
  return readWindowsCommandExecutable(command) ?? readWindowsExecutablePath(command);
}

function readWindowsExecutablePath(command: string) {
  return isWindowsExecutableFile(command) ? stripSurroundingQuotes(command) : undefined;
}

function isWindowsBatchFile(command: string) {
  return /\.(?:cmd|bat)$/i.test(stripSurroundingQuotes(command));
}

function isWindowsExecutableFile(command: string) {
  return /\.(?:exe|com)$/i.test(stripSurroundingQuotes(command));
}

function stripSurroundingQuotes(command: string) {
  return command.replace(/^"(.*)"$/s, "$1");
}

function quoteWindowsCommandExecutable(command: string) {
  return /\s/.test(command) ? `"${command.replaceAll('"', '""')}"` : command;
}
