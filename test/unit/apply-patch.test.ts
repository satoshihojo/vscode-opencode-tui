import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveNewContentsFromChunks, parsePatch, PatchApplicationError } from "../../src/apply-patch";

describe("apply-patch", () => {
  it("parses add, delete, update, and move hunks", () => {
    const hunks = parsePatch([
      "*** Begin Patch",
      "*** Add File: added.ts",
      "+export const added = true;",
      "*** Update File: moved-from.ts",
      "*** Move to: moved-to.ts",
      "@@ export const value = 1;",
      "+export const inserted = 2;",
      "*** Delete File: deleted.ts",
      "*** End Patch",
    ].join("\n"));

    assert.deepEqual(hunks, [
      { type: "add", path: "added.ts", contents: "export const added = true;" },
      {
        type: "update",
        path: "moved-from.ts",
        move_path: "moved-to.ts",
        chunks: [{
          old_lines: [],
          new_lines: ["export const inserted = 2;"],
          change_context: "export const value = 1;",
          is_end_of_file: undefined,
        }],
      },
      { type: "delete", path: "deleted.ts" },
    ]);
  });

  it("parses heredoc-wrapped patches", () => {
    const hunks = parsePatch([
      "<<'PATCH'",
      "*** Begin Patch",
      "*** Add File: heredoc.ts",
      "+export const fromHeredoc = true;",
      "*** End Patch",
      "PATCH",
    ].join("\n"));

    assert.deepEqual(hunks, [{ type: "add", path: "heredoc.ts", contents: "export const fromHeredoc = true;" }]);
  });

  it("parses end-of-file markers on update chunks", () => {
    const hunks = parsePatch([
      "*** Begin Patch",
      "*** Update File: target.ts",
      "@@",
      " export const value = 1;",
      "+export const eofValue = 2;",
      "*** End of File",
      "*** End Patch",
    ].join("\n"));

    assert.deepEqual(hunks, [{
      type: "update",
      path: "target.ts",
      move_path: undefined,
      chunks: [{
        old_lines: ["export const value = 1;"],
        new_lines: ["export const value = 1;", "export const eofValue = 2;"],
        change_context: undefined,
        is_end_of_file: true,
      }],
    }]);
  });

  it("applies out-of-order update chunks without moving unrelated lines", () => {
    const source = [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const lastValue = 1;",
      "",
    ].join("\n");

    const next = deriveNewContentsFromChunks(source, "target.ts", [
      { old_lines: ["export const lastValue = 1;"], new_lines: ["export const lastValue = 2;"] },
      { old_lines: ["export const firstValue = 1;"], new_lines: ["export const firstValue = 2;"] },
    ]);

    assert.equal(next, [
      "export const firstValue = 2;",
      "export const middleValue = 1;",
      "export const lastValue = 2;",
      "",
    ].join("\n"));
  });

  it("inserts context-only hunks after their matched context line", () => {
    const source = [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const lastValue = 1;",
      "",
    ].join("\n");

    const next = deriveNewContentsFromChunks(source, "target.ts", [
      {
        old_lines: [],
        new_lines: ["export const insertedValue = 2;"],
        change_context: "export const middleValue = 1;",
      },
    ]);

    assert.equal(next, [
      "export const firstValue = 1;",
      "export const middleValue = 1;",
      "export const insertedValue = 2;",
      "export const lastValue = 1;",
      "",
    ].join("\n"));
  });

  it("preserves repeated insertion-only hunks on the same context line", () => {
    const source = [
      "export const anchorValue = 1;",
      "export const tailValue = 1;",
      "",
    ].join("\n");

    const next = deriveNewContentsFromChunks(source, "target.ts", [
      {
        old_lines: [],
        new_lines: ["export const insertedFirst = 2;"],
        change_context: "export const anchorValue = 1;",
      },
      {
        old_lines: [],
        new_lines: ["export const insertedSecond = 3;"],
        change_context: "export const anchorValue = 1;",
      },
    ]);

    assert.equal(next, [
      "export const anchorValue = 1;",
      "export const insertedFirst = 2;",
      "export const insertedSecond = 3;",
      "export const tailValue = 1;",
      "",
    ].join("\n"));
  });

  it("surfaces hunk-indexed failures", () => {
    assert.throws(
      () => deriveNewContentsFromChunks("export const value = 1;\n", "target.ts", [
        { old_lines: ["export const missingValue = 1;"], new_lines: ["export const missingValue = 2;"] },
      ]),
      (error) => {
        assert.equal(error instanceof PatchApplicationError, true);
        assert.match(String(error), /Patch hunk 1 failed in target\.ts/);
        assert.match(String(error), /No files were changed/);
        return true;
      },
    );
  });

  it("matches normalized unicode punctuation in update chunks", () => {
    const next = deriveNewContentsFromChunks("const label = 'Don\\'t wait';\n", "target.ts", [
      { old_lines: ["const label = \u2018Don\\\u2019t wait\u2019;"], new_lines: ["const label = 'Go now';"] },
    ]);

    assert.equal(next, "const label = 'Go now';\n");
  });
});
