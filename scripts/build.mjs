import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const distDir = path.join(root, "dist");

await fs.rm(distDir, { recursive: true, force: true });

const sharedBuildOptions = {
  bundle: true,
  legalComments: "eof",
  logLevel: "info",
  platform: "node",
  sourcemap: false,
  target: "node20",
};

await Promise.all([
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(root, "src", "extension.ts")],
    external: ["vscode"],
    format: "cjs",
    outfile: path.join(distDir, "extension.js"),
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(root, "src", "bridge-plugin.mts")],
    format: "esm",
    outfile: path.join(distDir, "bridge-plugin.mjs"),
  }),
  build({
    ...sharedBuildOptions,
    entryPoints: [path.join(root, "src", "tui-session-plugin.ts")],
    format: "esm",
    outfile: path.join(distDir, "tui-session-plugin.mjs"),
  }),
]);
