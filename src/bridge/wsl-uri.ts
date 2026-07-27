import * as path from "node:path";
import { buildWslUncPath } from "../opencode/command";

export type WslWorkspaceContext = {
  distro: string;
  linuxRoot: string;
};

/**
 * Translate a Linux path that opencode sent (absolute like `/home/me/file` or
 * relative like `src/file`) into a Windows UNC path rooted at the WSL distro
 * pointed to by `wsl`. Returns undefined when no WSL translation applies so
 * callers can fall back to the existing `vscode.Uri.file(...)` path.
 *
 * Pure string manipulation — safe to import from node-only unit tests.
 */
export function toWorkspaceUncPath(
  linuxPath: string,
  wsl: WslWorkspaceContext | undefined,
): string | undefined {
  if (!wsl) {
    return undefined;
  }
  const normalized = linuxPath.replaceAll("\\", "/");
  const absolute = path.posix.isAbsolute(normalized)
    ? normalized
    : path.posix.join(wsl.linuxRoot, normalized);
  return buildWslUncPath(wsl.distro, absolute);
}