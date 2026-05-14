import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestPath = path.join(root, "package.json");
const fallbackReadmePath = "README.local-vsix.md";
const fallbackIgnoreFilePath = ".vscodeignore.local-vsix";
const vsceEntrypoint = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
const extraArgs = process.argv.slice(2);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const repositoryUrl = typeof manifest.repository?.url === "string" ? manifest.repository.url : "";
const shouldUseFallbackReadme = !isPublicRepositoryUrl(repositoryUrl);
const args = ["package", ...extraArgs];

if (shouldUseFallbackReadme) {
  if (!fs.existsSync(fallbackReadmePath)) {
    throw new Error(`Missing fallback README at ${path.join(root, fallbackReadmePath)}`);
  }
  if (!fs.existsSync(fallbackIgnoreFilePath)) {
    throw new Error(`Missing fallback ignore file at ${path.join(root, fallbackIgnoreFilePath)}`);
  }

  args.push(
    "--allow-missing-repository",
    "--readme-path",
    fallbackReadmePath,
    "--ignoreFile",
    fallbackIgnoreFilePath,
  );
  process.stdout.write("Packaging with fallback Marketplace README until package.json repository points at a public GitHub/GitLab URL.\n");
}

const result = spawnSync(process.execPath, [vsceEntrypoint, ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function isPublicRepositoryUrl(value) {
  if (!value || /example\.invalid/i.test(value)) {
    return false;
  }

  return /https:\/\/(github|gitlab)\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value.trim());
}
