import { realpathSync } from "node:fs";
import * as path from "node:path";

export function matchesPermissionPattern(realFilePath: string, pattern: string) {
  const normalizedPattern = normalizePermissionPath(pattern);
  const normalizedGlobPattern = normalizedPattern.replaceAll("\\", "/");
  if (resolveRealPathForComparison(normalizedPattern) === realFilePath) {
    return true;
  }
  if (normalizedGlobPattern.endsWith("/**")) {
    return isWithinRoot(realFilePath, resolveRealPathForComparison(normalizedGlobPattern.slice(0, -3)));
  }
  if (normalizedGlobPattern.endsWith("/*")) {
    const root = resolveRealPathForComparison(normalizedGlobPattern.slice(0, -2));
    const relative = path.relative(root, realFilePath);
    return relative !== "" && !relative.includes(path.sep) && !relative.includes("/") && !relative.includes("\\");
  }

  return false;
}

export function normalizePermissionPath(value: string) {
  return path.resolve(value.replaceAll("\\", "/"));
}

export function resolveRealPathForComparison(targetPath: string): string {
  const absoluteTarget = path.resolve(targetPath);

  try {
    return realpathSync.native(absoluteTarget);
  } catch (error) {
    if (!isMissingNodePathError(error)) {
      throw error;
    }

    const parent = path.dirname(absoluteTarget);
    if (parent === absoluteTarget) {
      throw error;
    }

    return path.join(resolveRealPathForComparison(parent), path.basename(absoluteTarget));
  }
}

export function isWithinRoot(targetPath: string, workspaceRoot: string) {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingNodePathError(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
