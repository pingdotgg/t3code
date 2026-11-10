import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ForgejoComment,
  ForgejoPullRequest,
  ForgejoReview,
  forgejoChangeRequest,
  forgejoComment,
  forgejoReview,
} from "./forgejoPullRequestJson.ts";

const decodeForgejoComment = Schema.decodeSync(ForgejoComment);
const decodeForgejoPullRequest = Schema.decodeSync(ForgejoPullRequest);
const decodeForgejoReview = Schema.decodeSync(ForgejoReview);

describe("forgejoComment", () => {
  const createdAt = "2026-10-10T19:52:40Z";
  const comment = (updatedAt: string | null | undefined) =>
    forgejoComment(
      decodeForgejoComment({
        id: 29061,
        body: "Performance: five rounds complete",
        user: { login: "forgejo-actions" },
        created_at: createdAt,
        ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
      }),
    );

  it.each([undefined, null, createdAt, "2026-10-10T19:52:40.000Z"])(
    "reads no edit from an updated_at of %s",
    (updatedAt) => {
      const mapped = comment(updatedAt);
      assert.strictEqual(mapped.createdAt, "2026-10-10T19:52:40.000Z");
      assert.isUndefined(mapped.editedAt);
    },
  );

  it("reads a later updated_at as an edit, in UTC milliseconds", () => {
    const mapped = comment("2026-10-10T20:04:50Z");
    assert.strictEqual(mapped.id, "29061");
    assert.strictEqual(mapped.author?.login, "forgejo-actions");
    assert.strictEqual(mapped.editedAt, "2026-10-10T20:04:50.000Z");
  });
});

describe("forgejoChangeRequest", () => {
  const headBranch = (head: { ref: string; label?: string; repo: { full_name: string } | null }) =>
    forgejoChangeRequest(
      decodeForgejoPullRequest({
        number: 7,
        title: "Merged feature",
        body: null,
        html_url: "https://forgejo.test/maria/project/pulls/7",
        user: null,
        state: "closed",
        merged: true,
        head: { ...head, sha: "head" },
        base: { ref: "main", label: "main", sha: "base", repo: null },
        created_at: "2026-10-10T19:52:40Z",
        updated_at: "2026-10-12T00:00:00Z",
        closed_at: "2026-10-12T00:00:00Z",
        merged_at: "2026-10-12T00:00:00Z",
        labels: null,
      }),
    ).headBranch;

  it("reads a deleted head branch from its label", () => {
    const head = { ref: "refs/pull/7/head", label: "feature" };
    assert.strictEqual(headBranch({ ...head, repo: { full_name: "maria/project" } }), "feature");
    // A deleted fork leaves no repository to say whose `feature` that was.
    assert.strictEqual(headBranch({ ...head, repo: null }), "refs/pull/7/head");
  });

  it("keeps the ref when the server sends no label", () => {
    assert.strictEqual(headBranch({ ref: "feature", repo: null }), "feature");
  });
});

describe("forgejoReview", () => {
  it.each([
    ["REQUEST_CHANGES", false, "CHANGES_REQUESTED"],
    ["REQUEST_CHANGES", true, "DISMISSED"],
    ["APPROVED", true, "DISMISSED"],
  ])("reads %s with dismissed %s as %s", (state, dismissed, reviewState) => {
    const mapped = forgejoReview(
      decodeForgejoReview({
        id: 8,
        body: "",
        user: { login: "maria" },
        state,
        dismissed,
        submitted_at: "2026-10-10T19:52:40Z",
        comments_count: 0,
      }),
    );
    assert.strictEqual(mapped.reviewState, reviewState);
  });
});
