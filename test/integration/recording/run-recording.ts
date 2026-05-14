import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runTests } from "@vscode/test-electron";
import { RECORDING_VIEWPORT } from "./recording-plan";
import { prepareRecordingSandbox } from "./recording-sandbox";

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, "../../../..");
  const extensionTestsPath = path.resolve(__dirname, "./index");
  const fixtureWorkspacePath = path.resolve(__dirname, "../../../../test/fixture-workspace");
  const realOpenCodePath = resolveRealOpenCodePath();
  if (!realOpenCodePath) {
    throw new Error("Unable to locate a real opencode binary for recording.");
  }

  const sandbox = prepareRecordingSandbox({
    fixtureWorkspacePath,
    openCodePath: realOpenCodePath,
  });

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const pathDelimiter = process.platform === "win32" ? ";" : ":";
  const inheritedPath = process.env[pathKey] ?? process.env.PATH ?? "";
  const effectivePathPrefix = path.dirname(realOpenCodePath);
  const outputDirectory = path.resolve(__dirname, "../../../../docs/media");
  const mp4Path = process.env.OPENCODE_EDIT_RECORDING_MP4_OUT ?? path.join(outputDirectory, "review-queue-workflow.mp4");
  const gifPath = process.env.OPENCODE_EDIT_RECORDING_GIF_OUT ?? path.join(outputDirectory, "review-queue-workflow.gif");
  const untrimmedMp4Path = process.env.OPENCODE_EDIT_RECORDING_UNTRIMMED_MP4_OUT ?? path.join(outputDirectory, "review-queue-workflow.untrimmed.mp4");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      ...process.env,
      [pathKey]: inheritedPath.length > 0 ? `${effectivePathPrefix}${pathDelimiter}${inheritedPath}` : effectivePathPrefix,
      OPENCODE_EDIT_SUPPRESS_NOTIFICATIONS: "1",
      OPENCODE_EDIT_BYPASS_SESSION_PICKER: "0",
      OPENCODE_EDIT_SCREENSHOT_USE_REAL_OPENCODE: "1",
      OPENCODE_EDIT_SCREENCAST_MODE: "1",
      OPENCODE_EDIT_RECORDING_MP4_OUT: mp4Path,
      OPENCODE_EDIT_RECORDING_GIF_OUT: gifPath,
      OPENCODE_EDIT_RECORDING_UNTRIMMED_MP4_OUT: untrimmedMp4Path,
      OPENCODE_EDIT_RECORDING_VIEWPORT: `${RECORDING_VIEWPORT.width}x${RECORDING_VIEWPORT.height}`,
      XDG_DATA_HOME: sandbox.dataHomePath,
      XDG_CACHE_HOME: sandbox.cacheHomePath,
      XDG_CONFIG_HOME: sandbox.configHomePath,
      XDG_STATE_HOME: sandbox.stateHomePath,
    },
    launchArgs: [
      sandbox.workspacePath,
      `--window-size=${RECORDING_VIEWPORT.width},${RECORDING_VIEWPORT.height}`,
      "--window-position=0,0",
      "--disable-extensions",
      "--skip-release-notes",
      "--force-color-profile=srgb",
    ],
  });
}

function resolveRealOpenCodePath() {
  const configuredPath = process.env.OPENCODE_EDIT_SCREENSHOT_OPENCODE_PATH;
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const defaultPath = "/usr/local/bin/opencode";
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, ["opencode"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  const resolvedPath = result.stdout.split(/\r?\n/).find((entry) => entry.length > 0);
  return resolvedPath && existsSync(resolvedPath) ? resolvedPath : undefined;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
