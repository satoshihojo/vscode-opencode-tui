import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toDisplayPathForFile } from "../../src/display-path";

describe("toDisplayPathForFile", () => {
  it("returns a workspace-relative path for files inside the workspace", () => {
    const displayPath = toDisplayPathForFile(
      "/workspace/src/example.ts",
      ["/workspace"],
    );

    assert.equal(displayPath, "src/example.ts");
  });

  it("preserves the leading slash for POSIX absolute paths outside the workspace", () => {
    const displayPath = toDisplayPathForFile(
      "/home/vuht26j/outside.ts",
      ["/workspace"],
    );

    assert.equal(displayPath, "/home/vuht26j/outside.ts");
  });

  it("preserves Windows absolute paths outside the workspace", () => {
    const win32Path = {
      relative(from: string, to: string) {
        if (from === "C:\\workspace" && to === "D:\\outside\\file.ts") {
          return "D:\\outside\\file.ts";
        }
        return "src\\example.ts";
      },
      isAbsolute(value: string) {
        return /^[A-Za-z]:\\/.test(value);
      },
    };

    const displayPath = toDisplayPathForFile(
      "D:\\outside\\file.ts",
      ["C:\\workspace"],
      win32Path,
    );

    assert.equal(displayPath, "D:\\outside\\file.ts");
  });
});
