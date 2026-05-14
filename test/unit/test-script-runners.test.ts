import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const compileTestsScriptPath = path.resolve(process.cwd(), "scripts/compile-tests.mjs");
const runUnitTestsScriptPath = path.resolve(process.cwd(), "scripts/run-unit-tests.mjs");

describe("test script runners", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const temporaryDirectory of temporaryDirectories.splice(0)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("compile-tests uses the workspace-local TypeScript compiler and replaces out-test", () => {
    const workspacePath = createTemporaryWorkspace();
    const fakeTscPath = path.join(workspacePath, "node_modules", "typescript", "bin", "tsc");
    const staleFilePath = path.join(workspacePath, "out-test", "stale.txt");
    const compiledMarkerPath = path.join(workspacePath, "out-test", "compiled.txt");

    temporaryDirectories.push(workspacePath);
    fs.mkdirSync(path.dirname(fakeTscPath), { recursive: true });
    fs.mkdirSync(path.dirname(staleFilePath), { recursive: true });
    fs.writeFileSync(staleFilePath, "stale", "utf8");
    fs.writeFileSync(fakeTscPath, [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const outTestPath = path.join(process.cwd(), "out-test");',
      'fs.mkdirSync(outTestPath, { recursive: true });',
      'fs.writeFileSync(path.join(outTestPath, "compiled.txt"), process.argv.slice(2).join(" "), "utf8");',
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [compileTestsScriptPath], {
      cwd: workspacePath,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(staleFilePath), false);
    assert.equal(fs.readFileSync(compiledMarkerPath, "utf8"), "-p tsconfig.test.json");
  });

  it("run-unit-tests executes compiled unit tests and ignores non-test files", () => {
    const workspacePath = createTemporaryWorkspace();
    const unitTestsPath = path.join(workspacePath, "out-test", "test", "unit");
    const markerPath = path.join(workspacePath, "unit-tests-ran.txt");

    temporaryDirectories.push(workspacePath);
    fs.mkdirSync(unitTestsPath, { recursive: true });
    fs.writeFileSync(path.join(unitTestsPath, "alpha.test.js"), [
      'const fs = require("node:fs");',
      'const { test } = require("node:test");',
      'test("writes a marker", () => {',
      `  fs.writeFileSync(${JSON.stringify(markerPath)}, "ok", "utf8");`,
      '});',
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(unitTestsPath, "ignored.js"), 'throw new Error("ignored file should not run");', "utf8");

    const result = spawnSync(process.execPath, [runUnitTestsScriptPath], {
      cwd: workspacePath,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(markerPath, "utf8"), "ok");
  });

  it("run-unit-tests succeeds even when invoked from a node:test child context", () => {
    const workspacePath = createTemporaryWorkspace();
    const unitTestsPath = path.join(workspacePath, "out-test", "test", "unit");
    const markerPath = path.join(workspacePath, "nested-node-test-context.txt");

    temporaryDirectories.push(workspacePath);
    fs.mkdirSync(unitTestsPath, { recursive: true });
    fs.writeFileSync(path.join(unitTestsPath, "alpha.test.js"), [
      'const fs = require("node:fs");',
      'const { test } = require("node:test");',
      'test("writes a nested marker", () => {',
      `  fs.writeFileSync(${JSON.stringify(markerPath)}, "ok", "utf8");`,
      '});',
    ].join("\n"), "utf8");

    const result = spawnSync(process.execPath, [runUnitTestsScriptPath], {
      cwd: workspacePath,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: "child-v8",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(markerPath, "utf8"), "ok");
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, /run\(\) is being called recursively/);
  });

  it("run-unit-tests fails clearly when no compiled unit tests are present", () => {
    const workspacePath = createTemporaryWorkspace();

    temporaryDirectories.push(workspacePath);
    fs.mkdirSync(path.join(workspacePath, "out-test", "test", "unit"), { recursive: true });

    const result = spawnSync(process.execPath, [runUnitTestsScriptPath], {
      cwd: workspacePath,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /No compiled unit tests found/);
  });
});

function createTemporaryWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-tui-integration-test-scripts-"));
}
