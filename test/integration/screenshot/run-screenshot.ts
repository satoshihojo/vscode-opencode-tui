import path from "node:path";
import { runTests } from "@vscode/test-electron";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, "../../../..");
  const extensionTestsPath = path.resolve(__dirname, "./index");
  const workspacePath = path.resolve(__dirname, "../../../../test/fixture-workspace");
  const fakeBinPath = path.resolve(__dirname, "../../../../test/bin");
  const screenshotPath = path.resolve(__dirname, "../../../../docs/media/review-queue-workflow.png");
  const realOpenCodePath = resolveRealOpenCodePath();
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const pathDelimiter = process.platform === "win32" ? ";" : ":";
  const inheritedPath = process.env[pathKey] ?? process.env.PATH ?? "";
  const useRealOpenCode = process.env.OPENCODE_EDIT_SCREENSHOT_USE_REAL_OPENCODE === "1" && realOpenCodePath !== undefined;
  const effectivePathPrefix = useRealOpenCode ? path.dirname(realOpenCodePath) : fakeBinPath;

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      ...process.env,
      [pathKey]: inheritedPath.length > 0 ? `${effectivePathPrefix}${pathDelimiter}${inheritedPath}` : effectivePathPrefix,
      OPENCODE_EDIT_FAKE_OPENCODE_SLEEP: process.env.OPENCODE_EDIT_FAKE_OPENCODE_SLEEP ?? "30",
      OPENCODE_EDIT_SCREENSHOT_OUT: process.env.OPENCODE_EDIT_SCREENSHOT_OUT ?? screenshotPath,
      OPENCODE_EDIT_SUPPRESS_NOTIFICATIONS: "1",
      OPENCODE_EDIT_BYPASS_SESSION_PICKER: "1",
      OPENCODE_EDIT_SCREENSHOT_USE_REAL_OPENCODE: useRealOpenCode ? "1" : "0",
    },
    launchArgs: [workspacePath, "--disable-extensions", "--force-color-profile=srgb", "--skip-release-notes"],
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
