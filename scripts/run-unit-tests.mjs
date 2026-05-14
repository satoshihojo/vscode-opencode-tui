import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const unitTestsPath = path.join(root, "out-test", "test", "unit");
const entries = fs.readdirSync(unitTestsPath, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(unitTestsPath, entry.name))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  throw new Error(`No compiled unit tests found in ${unitTestsPath}`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
  // Node 20 marks nested node:test children via NODE_TEST_CONTEXT.
  // Clear it so this script can launch a fresh test runner inside tests and CI.
  env: withoutNodeTestContext(process.env),
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function withoutNodeTestContext(environment) {
  const nextEnvironment = { ...environment };
  delete nextEnvironment.NODE_TEST_CONTEXT;
  return nextEnvironment;
}
