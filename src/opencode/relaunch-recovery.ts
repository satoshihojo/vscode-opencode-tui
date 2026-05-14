import { spawnSync } from "node:child_process";

export type RelaunchRecoveryTerminal = {
  exitStatus: unknown;
};

export function signalOpenCodeProcess(openCodePort: number, signal?: "TERM" | "KILL") {
  const pattern = `opencode --port ${openCodePort}`;
  const args = ["-f", pattern];
  if (signal) {
    args.unshift(`-${signal}`);
  }
  spawnSync("pkill", args, {
    stdio: "ignore",
  });
}

export function isOpenCodeProcessRunning(openCodePort: number) {
  const pattern = `opencode --port ${openCodePort}`;
  const result = spawnSync("pgrep", ["-f", pattern], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export async function waitForOpenCodeProcessExit(
  openCodePort: number,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    wait?: (durationMs: number) => Promise<void>;
    isRunning?: (openCodePort: number) => boolean;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 1500;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const wait = options.wait ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const isRunning = options.isRunning ?? isOpenCodeProcessRunning;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(openCodePort)) {
      return true;
    }

    await wait(pollIntervalMs);
  }

  return !isRunning(openCodePort);
}

export async function tryTerminateExistingOpenCodeProcessForReuse({
  existingOpenCodePort,
  terminal,
  waitForExit = waitForOpenCodeProcessExit,
  signalProcess = signalOpenCodeProcess,
  platform = process.platform,
}: {
  existingOpenCodePort?: number;
  terminal: RelaunchRecoveryTerminal;
  waitForExit?: (openCodePort: number) => Promise<boolean>;
  signalProcess?: (openCodePort: number, signal?: "TERM" | "KILL") => void;
  platform?: NodeJS.Platform;
}) {
  if (platform === "win32") {
    return true;
  }

  if (!existingOpenCodePort) {
    return false;
  }

  signalProcess(existingOpenCodePort, "TERM");
  const exited = await waitForExit(existingOpenCodePort);
  return exited && terminal.exitStatus === undefined;
}
