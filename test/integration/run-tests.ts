import path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = path.resolve(__dirname, "../../../test/fixture-workspace");
  const fakeBinPath = path.resolve(__dirname, "../../../test/bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const inheritedPath = process.env[pathKey] ?? process.env.PATH ?? "";
  process.env[pathKey] = `${fakeBinPath}${path.delimiter}${inheritedPath}`;

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
