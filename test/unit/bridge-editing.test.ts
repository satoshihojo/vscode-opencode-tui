import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { matchesPermissionPattern } from "../../src/path-permission";

describe("bridge-editing permission patterns", () => {
  it("matches exact paths", () => {
    const filePath = path.resolve("/workspace/allowed/file.ts");

    assert.equal(matchesPermissionPattern(filePath, filePath), true);
  });

  it("accepts backslash-separated exact paths", () => {
    const filePath = path.resolve("/workspace/allowed/file.ts");
    const pattern = filePath.replaceAll(path.sep, "\\");

    assert.equal(matchesPermissionPattern(filePath, pattern), true);
  });

  it("matches recursive globs with slash separators", () => {
    const root = path.resolve("/workspace/allowed");

    assert.equal(matchesPermissionPattern(path.join(root, "nested", "file.ts"), `${root}/**`), true);
  });

  it("matches single-level globs without matching nested files", () => {
    const root = path.resolve("/workspace/allowed");

    assert.equal(matchesPermissionPattern(path.join(root, "file.ts"), `${root}/*`), true);
    assert.equal(matchesPermissionPattern(path.join(root, "nested", "file.ts"), `${root}/*`), false);
  });

  it("accepts backslash-separated recursive glob patterns", () => {
    const root = path.resolve("/workspace/allowed");
    const pattern = `${root.replaceAll(path.sep, "\\")}\\**`;

    assert.equal(matchesPermissionPattern(path.join(root, "nested", "file.ts"), pattern), true);
  });

  it("accepts backslash-separated single-level glob patterns", () => {
    const root = path.resolve("/workspace/allowed");
    const pattern = `${root.replaceAll(path.sep, "\\")}\\*`;

    assert.equal(matchesPermissionPattern(path.join(root, "file.ts"), pattern), true);
    assert.equal(matchesPermissionPattern(path.join(root, "nested", "file.ts"), pattern), false);
  });
});
