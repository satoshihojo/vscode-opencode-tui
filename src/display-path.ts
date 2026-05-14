import * as path from "node:path";

type PathModuleLike = Pick<typeof path, "relative" | "isAbsolute">;

export function toDisplayPathForFile(
  filePath: string,
  workspaceRoots: readonly string[],
  pathModule: PathModuleLike = path,
) {
  const containingRoot = workspaceRoots.find((root) => isWithinRoot(filePath, root, pathModule));
  if (!containingRoot) {
    return filePath;
  }

  return pathModule.relative(containingRoot, filePath).replaceAll("\\", "/");
}

function isWithinRoot(targetPath: string, root: string, pathModule: PathModuleLike) {
  const relative = pathModule.relative(root, targetPath);
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
}
