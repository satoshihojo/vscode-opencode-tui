import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outTestPath = path.join(root, "out-test");
const tscPath = path.join(root, "node_modules", "typescript", "bin", "tsc");

fs.rmSync(outTestPath, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.test.json"], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
