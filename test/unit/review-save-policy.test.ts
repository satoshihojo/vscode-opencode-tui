import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldSaveAfterApply } from "../../src/review/review-save-policy";

describe("shouldSaveAfterApply", () => {
  it("saves existing file targets only when the document was clean beforehand", () => {
    assert.equal(shouldSaveAfterApply({ targetKind: "existing", wasDirtyBeforeApply: false, scheme: "file" }), true);
    assert.equal(shouldSaveAfterApply({ targetKind: "existing", wasDirtyBeforeApply: true, scheme: "file" }), false);
  });

  it("does not save scratch or non-file targets", () => {
    assert.equal(shouldSaveAfterApply({ targetKind: "scratch", wasDirtyBeforeApply: false, scheme: "untitled" }), false);
    assert.equal(shouldSaveAfterApply({ targetKind: "existing", wasDirtyBeforeApply: false, scheme: "untitled" }), false);
  });
});
