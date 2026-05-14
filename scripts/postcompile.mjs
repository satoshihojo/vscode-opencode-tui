import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const bridgePluginTarget = path.join(root, "dist", "vscode-bridge-plugin.mjs");
const tuiSessionPluginTarget = path.join(root, "dist", "vscode-tui-session-plugin.mjs");
const tuiConfigTarget = path.join(root, "dist", "vscode-tui-config.json");
const notifierVendorSource = path.join(root, "node_modules", "node-notifier", "vendor");
const notifierVendorTarget = path.join(root, "vendor");

await fs.writeFile(
  bridgePluginTarget,
  [
    'export { default } from "./bridge-plugin.mjs";',
    "",
  ].join("\n"),
  "utf8",
);

await fs.writeFile(
  tuiSessionPluginTarget,
  [
    'export { default } from "./tui-session-plugin.mjs";',
    "",
  ].join("\n"),
  "utf8",
);

await fs.writeFile(
  tuiConfigTarget,
  JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    plugin: [pathToFileURL(tuiSessionPluginTarget).toString()],
  }, null, 2),
  "utf8",
);

await fs.rm(notifierVendorTarget, { recursive: true, force: true });
await fs.cp(notifierVendorSource, notifierVendorTarget, { recursive: true });
