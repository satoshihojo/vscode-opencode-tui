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
