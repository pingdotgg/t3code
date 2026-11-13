import { assert, describe, it } from "@effect/vitest";
import type { PullRequestReviewCommentDraft } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as EntirePullRequestProvider from "./EntirePullRequestProvider.ts";
import * as Fixtures from "./entireFixtures.ts";
import { makeTrailRepository, realGit } from "./entireGitFixture.ts";
import { Answer, fakeEntire, type SentRequest } from "./entireTestServer.ts";

const target = { cwd: "", host: "entire.io", repository: "gh/acme/web", number: 7 };
const REVIEW_ID = "01J0REVIEW0000000000000000";

const makeRepository = () => makeTrailRepository({ "a.txt": "two\nthree\n", "b.txt": "new\n\n" });

const added = (path: string, newLine: number, body: string): PullRequestReviewCommentDraft => ({
  path,
  position: { kind: "added", newLine },
  body,
});

const started = (sent: SentRequest) => ({
  review_id: REVIEW_ID,
  head_sha: (sent.body as { head_sha: string }).head_sha,
  limits: { max_comments_per_batch: 100 },
});

const routes = (head: string, extra: Record<string, unknown> = {}) => ({
  "GET /trails/7": { ...Fixtures.detail, head_sha: head },
  "POST /trails/7/reviews": started,
  [`POST /trails/7/reviews/${REVIEW_ID}/comments`]: { review: { id: REVIEW_ID }, results: [] },
  "POST /trails/7/approvals": { ok: true },
  ...extra,
});

describe("Entire line comments", () => {
  it.effect("publishes line comments on the diff shown, as one review, then approves", () => {
    const repository = makeRepository();
    const server = fakeEntire(routes(repository.head), { git: realGit });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.submitReview({
        ...target,
        cwd: repository.work,
        verdict: "approve",
        body: "Nearly there",
        comments: [
          added("a.txt", 2, "Why three?"),
          {
            path: "a.txt",
            position: { kind: "context", oldLine: 1, newLine: 1, side: "right" },
            body: "And two",
          },
        ],
      });
      const writes = server.sent.filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map((request) => `${request.method} ${request.path}`),
        [
          "POST /trails/7/reviews",
          `POST /trails/7/reviews/${REVIEW_ID}/comments`,
          "POST /trails/7/approvals",
        ],
      );
      const [start, publish, approve] = writes;
      assert.deepStrictEqual(start?.body, {
        head_sha: repository.head,
        base_sha: repository.base,
      });
      const body = publish?.body as {
        summary: string | null;
        comments: ReadonlyArray<{ client_id: string; body: string; location: unknown }>;
      };
      assert.strictEqual(body.summary, "Nearly there");
      assert.deepStrictEqual(
        body.comments.map((comment) => [comment.body, comment.location]),
        [
          [
            "Why three?",
            {
              granularity: "line",
              file_path: "a.txt",
              start_line: 2,
              end_line: 2,
              selected_text: "three",
            },
          ],
          [
            "And two",
            {
              granularity: "line",
              file_path: "a.txt",
              start_line: 1,
              end_line: 1,
              selected_text: "two",
            },
          ],
        ],
      );
      assert.strictEqual(new Set(body.comments.map((comment) => comment.client_id)).size, 2);
      // The same submission sent again is the same review to Entire.
      const key = start?.headers["idempotency-key"];
      assert.match(key ?? "", /^t3code-/u);
      assert.strictEqual(publish?.headers["idempotency-key"], key);
      // The summary is not shown with the trail's activity; the approval carries it there.
      assert.deepStrictEqual(approve?.body, { event: "approve", body: "Nearly there" });
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("refuses lines the head does not have, and blank ones, without a write", () => {
    const repository = makeRepository();
    const server = fakeEntire(routes(repository.head), { git: realGit });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const submit = (comment: PullRequestReviewCommentDraft) =>
        provider
          .submitReview({
            ...target,
            cwd: repository.work,
            verdict: "comment",
            body: "",
            comments: [comment],
          })
          .pipe(Effect.flip);
      const deleted = yield* submit({
        path: "a.txt",
        position: { kind: "deleted", oldLine: 1 },
        body: "Gone",
      });
      assert.include(deleted.detail, "removed");
      const left = yield* submit({
        path: "a.txt",
        position: { kind: "context", oldLine: 1, newLine: 1, side: "left" },
        body: "Old side",
      });
      assert.include(left.detail, "removed");
      const blank = yield* submit(added("b.txt", 2, "Empty line"));
      assert.include(blank.detail, "blank");
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("says why Entire refused, and that a failed publish left an empty review", () => {
    const repository = makeRepository();
    const forbidden = fakeEntire(
      routes(repository.head, {
        "POST /trails/7/reviews": new Answer(403, { detail: "no publish access to repo" }),
      }),
      { git: realGit },
    );
    const conflict = fakeEntire(
      routes(repository.head, {
        [`POST /trails/7/reviews/${REVIEW_ID}/comments`]: new Answer(409, {
          detail: "review comments batch failed atomically",
        }),
      }),
      { git: realGit },
    );
    const submit = Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      return yield* provider
        .submitReview({
          ...target,
          cwd: repository.work,
          verdict: "comment",
          body: "",
          comments: [added("a.txt", 1, "Hm")],
        })
        .pipe(Effect.flip);
    });
    return Effect.gen(function* () {
      const denied = yield* submit.pipe(Effect.provide(forbidden.layer));
      assert.include(denied.detail, "no publish access");
      const failed = yield* submit.pipe(Effect.provide(conflict.layer));
      assert.include(failed.detail, "empty review");
      assert.notInclude(conflict.writes(), "POST /trails/7/approvals");
    }).pipe(Effect.ensuring(repository.cleanup));
  });

  it.effect("posts a commenting review's body where the trail's activity shows it", () => {
    const repository = makeRepository();
    const server = fakeEntire(
      routes(repository.head, {
        "POST /trails/7/discussions": { discussion: {}, message: {} },
      }),
      { git: realGit },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.submitReview({
        ...target,
        cwd: repository.work,
        verdict: "comment",
        body: "Two things",
        comments: [added("a.txt", 1, "Hm")],
      });
      assert.deepStrictEqual(server.writes(), [
        "POST /trails/7/reviews",
        `POST /trails/7/reviews/${REVIEW_ID}/comments`,
        "POST /trails/7/discussions",
      ]);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { body: "Two things" });
    }).pipe(Effect.provide(server.layer), Effect.ensuring(repository.cleanup));
  });

  it.effect("posts a comment with no lines as a discussion, and an empty one not at all", () => {
    const server = fakeEntire({ "POST /trails/7/discussions": { discussion: {}, message: {} } });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      for (const body of ["  ", "  Looks good\n"])
        yield* provider.submitReview({ ...target, verdict: "comment", body, comments: [] });
      assert.deepStrictEqual(
        server.sent.map((request) => [`${request.method} ${request.path}`, request.body]),
        [["POST /trails/7/discussions", { body: "Looks good" }]],
      );
    }).pipe(Effect.provide(server.layer));
  });
});
