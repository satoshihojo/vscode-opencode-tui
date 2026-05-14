import fs from "node:fs";
import path from "node:path";

let cachedExtensionId: string | undefined;
let cachedProjectRoot: string | undefined;

export function getTestExtensionId() {
  if (cachedExtensionId) {
    return cachedExtensionId;
  }

  const manifestPath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    publisher?: unknown;
    name?: unknown;
  };

  if (typeof manifest.publisher !== "string" || typeof manifest.name !== "string") {
    throw new Error(`Invalid extension manifest at ${manifestPath}`);
  }

  cachedExtensionId = `${manifest.publisher}.${manifest.name}`;
  return cachedExtensionId;
}

export function getProjectRoot() {
  if (cachedProjectRoot) {
    return cachedProjectRoot;
  }

  cachedProjectRoot = path.resolve(__dirname, "../../..");
  return cachedProjectRoot;
}
