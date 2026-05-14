import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const vsceEntrypoint = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
const result = spawnSync(process.execPath, [vsceEntrypoint, "ls"], {
  cwd: root,
  encoding: "utf8",
});

if (result.status !== 0) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

const packagedPaths = new Set(
  result.stdout
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean),
);

for (const entry of [
  "dist/extension.js",
  "dist/bridge-plugin.mjs",
  "dist/vscode-bridge-plugin.mjs",
  "dist/tui-session-plugin.mjs",
  "dist/vscode-tui-session-plugin.mjs",
  "dist/vscode-tui-config.json",
  "vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier",
  "vendor/terminal-notifier-LICENSE",
  "vendor/notifu/LICENSE",
  "vendor/snoreToast/snoretoast-x64.exe",
  "vendor/snoreToast/LICENSE",
  "media/opencode-button-dark.svg",
  "media/opencode-button-light.svg",
  "media/icon.png",
]) {
  if (!packagedPaths.has(entry)) {
    throw new Error(`Expected VSIX contents to include ${entry}.`);
  }
}

for (const entry of ["out-test/", ".tmp-vscode", "src/", "test/", "local/"]) {
  if (hasPathPrefix(packagedPaths, entry)) {
    throw new Error(`Expected VSIX contents to exclude ${entry}.`);
  }
}

process.stdout.write("VSIX package contents look correct.\n");

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function hasPathPrefix(paths, prefix) {
  const normalizedPrefix = normalizePath(prefix).replace(/\/+$/, "");
  for (const entry of paths) {
    if (entry === normalizedPrefix || entry.startsWith(`${normalizedPrefix}/`)) {
      return true;
    }
  }

  return false;
}
