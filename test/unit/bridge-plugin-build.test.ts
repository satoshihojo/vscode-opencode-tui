import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

describe("bridge plugin build artifact", () => {
  it("creates bundled plugin wrappers after compile", () => {
    const wrapperPath = path.resolve(process.cwd(), "dist/vscode-bridge-plugin.mjs");
    const bundledPluginPath = path.resolve(process.cwd(), "dist/bridge-plugin.mjs");
    const tuiWrapperPath = path.resolve(process.cwd(), "dist/vscode-tui-session-plugin.mjs");
    const bundledTuiPluginPath = path.resolve(process.cwd(), "dist/tui-session-plugin.mjs");
    const bundledTuiConfigPath = path.resolve(process.cwd(), "dist/vscode-tui-config.json");
    const terminalNotifierPath = path.resolve(
      process.cwd(),
      "vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier",
    );
    const snoreToastPath = path.resolve(process.cwd(), "vendor/snoreToast/snoretoast-x64.exe");

    assert.equal(fs.existsSync(wrapperPath), true);
    assert.equal(fs.existsSync(bundledPluginPath), true);
    assert.equal(fs.existsSync(tuiWrapperPath), true);
    assert.equal(fs.existsSync(bundledTuiPluginPath), true);
    assert.equal(fs.existsSync(bundledTuiConfigPath), true);
    assert.equal(fs.existsSync(terminalNotifierPath), true);
    assert.equal(fs.existsSync(snoreToastPath), true);
  });
});
