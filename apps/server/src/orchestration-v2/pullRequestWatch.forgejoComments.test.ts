import type { ThreadPullRequestWatch } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ForgejoComment,
  forgejoComment,
} from "@t3tools/source-control-forgejo/server/forgejoPullRequestJson";

import { evaluatePullRequestWatch as evaluate } from "./pullRequestWatch.ts";

// These cases read the head once or at one moment, so the no-checks notice never comes due.
const evaluatePullRequestWatch = (
  ...args: Parameters<typeof evaluate> extends [...infer Head, number] ? Head : never
) => evaluate(...args, 0);

const decodeForgejoComment = Schema.decodeSync(ForgejoComment);

describe("Forgejo comment watch boundary", () => {
  const createdAt = "2026-10-10T19:52:40Z";
  const editedAt = "2026-10-10T20:04:50Z";
  const seen = {
    startedAt: "2026-10-02T12:00:00.000Z",
    headSha: "aaaaaaaaaa",
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-10-10T19:52:40.000Z",
    remarkIds: ["29061"],
    conflicting: false,
    wakes: 2,
  } satisfies ThreadPullRequestWatch;
  const finalDetail = {
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: false,
      review: { inlineComment: true, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: true, listCandidates: true },
    },
    headSha: seen.headSha,
    checks: [],
    mergeability: "mergeable",
    viewer: "agent-user",
    author: { login: "agent-user", name: null, avatarUrl: null },
  } satisfies Parameters<typeof evaluatePullRequestWatch>[1];
  const decodedComment = (updatedAt: string | null | undefined) =>
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
    "does not wake for an unchanged comment with updated_at %s",
    (updatedAt) => {
      const comment = decodedComment(updatedAt);
      assert.isUndefined(comment.editedAt);
      assert.deepEqual(evaluatePullRequestWatch(seen, finalDetail, [comment]).changes, []);
    },
  );

  it("wakes once for the edit of an already-seen benchmark comment", () => {
    const finalComment = decodedComment(editedAt);
    assert.strictEqual(finalComment.editedAt, "2026-10-10T20:04:50.000Z");
    assert.isUndefined(decodedComment(createdAt).editedAt);
    const completed = evaluatePullRequestWatch(seen, finalDetail, [finalComment]);
    assert.deepEqual(completed.changes, [{ kind: "remarks", remarks: [finalComment] }]);
    assert.strictEqual(completed.next.remarksThrough, "2026-10-10T20:04:50.000Z");
    assert.deepEqual(
      evaluatePullRequestWatch(completed.next, finalDetail, [finalComment]).changes,
      [],
    );
    assert.deepEqual(
      evaluatePullRequestWatch(seen, finalDetail, [decodedComment(createdAt)]).changes,
      [],
    );
    const secondEdit = decodedComment("2026-10-10T20:05:50Z");
    const second = evaluatePullRequestWatch(completed.next, finalDetail, [secondEdit]);
    assert.deepEqual(second.changes, [{ kind: "remarks", remarks: [secondEdit] }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, finalDetail, [secondEdit]).changes, []);
    assert.deepEqual(
      evaluatePullRequestWatch(seen, finalDetail, [
        { ...finalComment, author: { login: "agent-user", name: null, avatarUrl: null } },
      ]).changes,
      [],
    );
  });
});
