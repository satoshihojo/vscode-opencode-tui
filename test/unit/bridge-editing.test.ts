import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { matchesPermissionPattern } from "../../src/path-permission";
import { toWorkspaceUncPath } from "../../src/bridge/wsl-uri";

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

describe("toWorkspaceUncPath", () => {
  const wsl = { distro: "Ubuntu", linuxRoot: "/home/me/proj" };

  it("returns undefined when no WSL context is supplied", () => {
    assert.equal(toWorkspaceUncPath("/home/me/proj/src/new.ts", undefined), undefined);
    assert.equal(toWorkspaceUncPath("src/new.ts", undefined), undefined);
  });

  it("translates an absolute Linux path to a WSL UNC path", () => {
    assert.equal(
      toWorkspaceUncPath("/home/me/proj/src/new.ts", wsl),
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\new.ts",
    );
  });

  it("joins a relative Linux path against the WSL linuxRoot", () => {
    assert.equal(
      toWorkspaceUncPath("src/new.ts", wsl),
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\new.ts",
    );
  });

  it("handles backslash-separated relative paths from opencode", () => {
    assert.equal(
      toWorkspaceUncPath("src\\nested\\new.ts", wsl),
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\nested\\new.ts",
    );
  });

  it("resolves an absolute path outside the workspace root", () => {
    assert.equal(toWorkspaceUncPath("/etc/passwd", wsl), "\\\\wsl.localhost\\Ubuntu\\etc\\passwd");
  });
});
