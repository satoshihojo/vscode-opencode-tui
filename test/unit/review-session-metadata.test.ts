import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeReviewSessionMetadata, normalizeSourceSessionIds } from "../../src/review/review-session-metadata";

describe("review session metadata", () => {
  it("maps child sessions to their parent session id and title", () => {
    const metadata = mergeReviewSessionMetadata(
      {
        sessionTitlesById: {},
        sessionCanonicalIdsById: {},
      },
      [
        { id: "ses_parent", title: "Opencode plugin implementation with git setup" },
        { id: "ses_child", parentId: "ses_parent", title: "Session ses_child" },
      ],
    );

    assert.equal(metadata.sessionCanonicalIdsById.ses_parent, "ses_parent");
    assert.equal(metadata.sessionCanonicalIdsById.ses_child, "ses_parent");
    assert.equal(metadata.sessionTitlesById.ses_parent, "Opencode plugin implementation with git setup");
  });

  it("dedupes parent and child session ids down to the same canonical session", () => {
    const normalized = normalizeSourceSessionIds(
      ["ses_parent", "ses_child"],
      {
        ses_parent: "ses_parent",
        ses_child: "ses_parent",
      },
    );

    assert.deepEqual(normalized, ["ses_parent"]);
  });

  it("overrides workspace-state self mappings when repository data marks the session as a child", () => {
    const metadata = mergeReviewSessionMetadata(
      {
        sessionTitlesById: {
          ses_child: "Session ses_child",
        },
        sessionCanonicalIdsById: {
          ses_child: "ses_child",
        },
      },
      [
        { id: "ses_parent", title: "Opencode plugin implementation with git setup" },
        { id: "ses_child", parentId: "ses_parent", title: "Session ses_child" },
      ],
    );

    assert.equal(metadata.sessionCanonicalIdsById.ses_child, "ses_parent");
    assert.equal(metadata.sessionTitlesById.ses_parent, "Opencode plugin implementation with git setup");
  });
});
