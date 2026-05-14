import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prepareSideBySideEditorLayout,
} from "../../src/layout/side-by-side-layout";

describe("side-by-side editor layout", () => {
  it("keeps the existing editor layout and focus when starting a session", async () => {
    const calls: Array<{ command: string; args: unknown[] }> = [];

    await prepareSideBySideEditorLayout((command, ...args) => {
      calls.push({ command, args });
    });

    assert.deepEqual(calls, []);
  });
});
