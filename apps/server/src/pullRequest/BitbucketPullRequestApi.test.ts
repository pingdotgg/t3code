import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketPullRequestApi from "./BitbucketPullRequestApi.ts";

const mockedRequest = vi.fn<BitbucketApi.BitbucketApi["Service"]["request"]>();

const layer = it.layer(
  BitbucketPullRequestApi.layer.pipe(
    Layer.provide(
      Layer.mock(BitbucketApi.BitbucketApi)({
        request: mockedRequest,
      }),
    ),
  ),
);

/** The shape `request` answers with: a body plus whether it had to be cut short. */
function response(body: string) {
  return { body, truncated: false };
}

function page(count: number, firstNumber: number, next?: string): string {
  return JSON.stringify({
    pagelen: 50,
    size: count,
    values: Array.from({ length: count }, (_, index) => ({
      id: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      state: "OPEN",
      created_on: "2026-06-16T05:04:32+00:00",
      updated_on: "2026-06-16T05:04:33+00:00",
      source: { branch: { name: "feat/page" } },
      destination: { branch: { name: "master" } },
      links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${firstNumber}` } },
    })),
    ...(next === undefined ? {} : { next }),
  });
}

function valuePage(values: ReadonlyArray<unknown>, next?: string): string {
  return JSON.stringify({ values, ...(next === undefined ? {} : { next }) });
}

/** Who opened the pull request, and two accounts that could review it. */
const bilal = { uuid: "{bilal}", nickname: "bilal" };
const octocat = { uuid: "{octocat}", nickname: "octocat" };
const hubot = { uuid: "{hubot}", nickname: "hubot" };

/** One pull request as `/pullrequests/{id}` answers with it. */
function pullRequestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    id: 7,
    title: "Pull request 7",
    state: "OPEN",
    author: bilal,
    created_on: "2026-06-16T05:04:32+00:00",
    updated_on: "2026-06-16T05:04:33+00:00",
    source: { branch: { name: "feat/page" } },
    destination: { branch: { name: "master" } },
    links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } },
    ...overrides,
  });
}

/** The request the nth call made. */
function callAt(index: number) {
  const call = mockedRequest.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** The filter expression of the nth request, read back out of its query string. */
function filterOfCall(index: number): string | null {
  const url = callAt(index).url;
  return new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("q");
}

afterEach(() => {
  mockedRequest.mockReset();
});

layer("BitbucketPullRequestApi.layer", (it) => {
  it.effect("asks for reviewers, newest first, at Bitbucket's page ceiling", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(3, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const url = callAt(0).url;
      expect(url).toContain("/repositories/acme/web/pullrequests");
      expect(url).toContain("state=OPEN");
      // Over 50 Bitbucket answers with an empty page and no error, so it is never exceeded.
      expect(url).toContain("pagelen=50");
      expect(url).toContain("sort=-updated_on");
      expect(url).toContain("fields=%2Bvalues.reviewers");
    }),
  );

  it.effect("follows the cursor Bitbucket sends rather than counting offsets", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))))
        .mockReturnValueOnce(Effect.succeed(response(page(50, 51))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 100,
      });

      assert.strictEqual(batch.items.length, 100);
      assert.isFalse(batch.truncated);
      assert.strictEqual(callAt(1).url, next);
    }),
  );

  it.effect("stops at the caller's page and says more remain", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
      });

      assert.strictEqual(batch.items.length, 50);
      assert.isTrue(batch.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("counts the rows it walked past as more to come", () =>
    Effect.gen(function* () {
      // Bitbucket pages in fifties whatever was asked for, so a request for ninety-nine reads a
      // hundred and drops one. That row is more results, and saying otherwise takes the "load
      // more" away from a listing that has not finished.
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests?page=2";
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))))
        .mockReturnValueOnce(Effect.succeed(response(page(50, 51))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const batch = yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 99,
      });

      assert.strictEqual(batch.items.length, 99);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("searches with a filter expression, which is all Bitbucket offers", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        query: "page",
      });

      expect(filterOfCall(0)).toBe('(title ~ "page" OR description ~ "page")');
      // The state filter beside it still stands, which the brackets are there to keep.
      expect(callAt(0).url).toContain("state=OPEN");
    }),
  );

  it.effect("escapes a quote and a backslash, so a search cannot reshape the filter", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        query: String.raw`a\" OR state = "MERGED"`,
      });

      const literal = String.raw`a\\\" OR state = \"MERGED\"`;
      expect(filterOfCall(0)).toBe(`(title ~ "${literal}" OR description ~ "${literal}")`);
    }),
  );

  it.effect("asks for no filter at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        query: "   ",
      });

      assert.isNull(filterOfCall(0));
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        cursor: { updatedBefore: "2026-07-02T00:00:00.123456+00:00", delivered: 50 },
      });

      // Inclusive, so the rows already sent at that instant come back for the caller to drop.
      expect(filterOfCall(0)).toBe("updated_on <= 2026-07-02T00:00:00.123456+00:00");
      expect(callAt(0).url).toContain("sort=-updated_on");
    }),
  );

  it.effect("narrows by the reader's words and by where it left off at once", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        query: "page",
        cursor: { updatedBefore: "2026-07-02T00:00:00+00:00", delivered: 50 },
      });

      // Bitbucket takes one `q`, so the two narrowings are joined rather than one replacing the
      // other — and the search keeps its brackets, which is what keeps the AND out of its OR.
      expect(filterOfCall(0)).toBe(
        '(title ~ "page" OR description ~ "page") AND updated_on <= 2026-07-02T00:00:00+00:00',
      );
    }),
  );

  it.effect("asks for declined pull requests on the closed tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({ repository: "acme/web", state: "closed", limit: 50 });

      expect(callAt(0).url).toContain("state=DECLINED");
    }),
  );

  it.effect("asks for every state at once on the All tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({ repository: "acme/web", state: "all", limit: 50 });

      // Bitbucket unions repeated state parameters, which is the only way to span them.
      const url = callAt(0).url;
      for (const state of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) {
        expect(url).toContain(`state=${state}`);
      }
    }),
  );

  it.effect("counts a superseded pull request as closed", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({ repository: "acme/web", state: "closed", limit: 50 });

      expect(callAt(0).url).toContain("state=DECLINED");
      expect(callAt(0).url).toContain("state=SUPERSEDED");
    }),
  );

  it.effect("refuses a repository that is not workspace and slug", () =>
    Effect.gen(function* () {
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(
        api.listPullRequests({ repository: "acme/team/web", state: "open", limit: 50 }),
      );

      assert.strictEqual(error._tag, "BitbucketRepositoryUnsupportedError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("returns the diff verbatim, because Bitbucket already sends a patch", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(patch)));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const diff = yield* api.getPullRequestDiff({ repository: "acme/web", number: 7 });

      assert.strictEqual(diff.patch, patch);
      assert.isFalse(diff.truncated);
      expect(callAt(0)).toMatchObject({
        url: "/repositories/acme/web/pullrequests/7/diff",
        // A diff of any size would otherwise be read into memory whole.
        maxBytes: 8 * 1024 * 1024,
      });
    }),
  );

  it.effect("reads a named commit's own patch, which pages no further than the whole of it", () =>
    Effect.gen(function* () {
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(patch)));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const diff = yield* api.getPullRequestDiff({
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      assert.strictEqual(diff.patch, patch);
      expect(callAt(0)).toMatchObject({
        url: "/repositories/acme/web/diff/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        maxBytes: 8 * 1024 * 1024,
      });
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a URL", () =>
    Effect.gen(function* () {
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(
        api.getPullRequestDiff({
          repository: "acme/web",
          number: 7,
          commit: "../../acme/other/diff/deadbeef",
        }),
      );

      assert.strictEqual(error._tag, "BitbucketDiffCommitError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("aggregates every diffstat page", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/diffstat?page=2";
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              valuePage(
                [
                  { lines_added: 9, lines_removed: 2 },
                  { lines_added: 3, lines_removed: 1 },
                ],
                next,
              ),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(response(valuePage([{ lines_added: 4, lines_removed: 7 }]))),
        );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const stat = yield* api.getDiffStat({ repository: "acme/web", number: 7 });

      expect(stat).toEqual({ additions: 16, deletions: 10, changedFiles: 3 });
      expect(callAt(1).url).toBe(next);
    }),
  );

  it.effect("returns the complete commit timeline oldest first across pages", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/commits?page=2";
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              valuePage(
                [
                  { hash: "ddd", message: "fourth", date: "2026-07-04T00:00:00Z" },
                  { hash: "ccc", message: "third", date: "2026-07-03T00:00:00Z" },
                ],
                next,
              ),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              valuePage([
                { hash: "bbb", message: "second", date: "2026-07-02T00:00:00Z" },
                { hash: "aaa", message: "first", date: "2026-07-01T00:00:00Z" },
              ]),
            ),
          ),
        );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const commits = yield* api.listCommits({ repository: "acme/web", number: 7 });

      expect(commits.map((commit) => commit.oid)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
      expect(callAt(1).url).toBe(next);
    }),
  );

  it.effect("returns build statuses from every page", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/statuses?page=2";
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(response(valuePage([{ name: "Build", state: "SUCCESSFUL" }], next))),
        )
        .mockReturnValueOnce(
          Effect.succeed(response(valuePage([{ name: "Lint", state: "FAILED" }]))),
        );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const checks = yield* api.listChecks({ repository: "acme/web", number: 7 });

      expect(checks.map((check) => [check.name, check.status])).toEqual([
        ["Build", "success"],
        ["Lint", "failure"],
      ]);
      expect(callAt(1).url).toBe(next);
    }),
  );

  it.effect("reads an empty conflict list as mergeable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const mergeability = yield* api.getMergeability({ repository: "acme/web", number: 7 });

      assert.strictEqual(mergeability, "mergeable");
      expect(callAt(0).url).toBe("/repositories/acme/web/pullrequests/7/conflicts");
    }),
  );

  it.effect("merges with Bitbucket's own name for the strategy", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.runAction({
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "rebase",
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/merge",
        body: '{"merge_strategy":"rebase_fast_forward"}',
      });
    }),
  );

  it.effect("closes a pull request by declining it", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "close" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/decline",
      });
    }),
  );

  it.effect("posts a comment as a JSON document, so the body stays text", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.comment({ repository: "acme/web", number: 7, body: "true" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/pullrequests/7/comments",
        body: '{"content":{"raw":"true"}}',
      });
    }),
  );

  it.effect("fails the read when Bitbucket answers with something unreadable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(response(JSON.stringify({ error: "nope" }))),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getPullRequest({ repository: "acme/web", number: 7 }));

      assert.strictEqual(error._tag, "BitbucketPullRequestReadError");
    }),
  );

  it.effect("states a failure once, without stacking one message inside another", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.fail(
          new BitbucketApi.BitbucketResponseError({
            operation: "request",
            status: 500,
            responseBodyLength: 0,
          }),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getViewer());

      // The fact only; the provider adds the operation around it.
      assert.strictEqual(error.detail, "Bitbucket returned HTTP 500.");
    }),
  );

  it.effect("fails when the credentials belong to no named account", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(JSON.stringify({}))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getViewer());

      assert.strictEqual(error._tag, "BitbucketViewerUnavailableError");
    }),
  );

  it.effect("follows Bitbucket's cursor and reassembles a thread that spans two pages", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              next: "https://api.bitbucket.org/2.0/comments?page=2",
              values: [
                {
                  id: 10,
                  content: { raw: "rename this" },
                  user: { nickname: "bilal" },
                  created_on: "2026-06-16T05:04:32+00:00",
                  inline: { path: "src/a.ts", to: 12 },
                },
              ],
            }),
          ),
        ),
      );
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            // The reply arrives a page after the remark it answers, which is why the threads
            // are only assembled once every page is in hand.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              values: [
                {
                  id: 11,
                  content: { raw: "done" },
                  user: { nickname: "julius" },
                  created_on: "2026-06-16T06:04:32+00:00",
                  parent: { id: 10 },
                },
              ],
            }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const { comments, threads, truncated } = yield* api.listComments({
        repository: "acme/web",
        number: 7,
      });

      expect(callAt(1).url).toBe("https://api.bitbucket.org/2.0/comments?page=2");
      expect(comments.map((comment) => comment.id)).toEqual(["10", "11"]);
      expect(threads[0]?.comments.map((comment) => comment.id)).toEqual(["10", "11"]);
      assert.isFalse(truncated);
    }),
  );

  it.effect("stops the comment walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      // Bitbucket that always names a next page: the walk has to end itself.
      mockedRequest.mockReturnValue(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              next: "https://api.bitbucket.org/2.0/comments?page=2",
              values: [
                {
                  id: 10,
                  content: { raw: "again" },
                  created_on: "2026-06-16T05:04:32+00:00",
                },
              ],
            }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const { truncated } = yield* api.listComments({ repository: "acme/web", number: 7 });

      assert.strictEqual(mockedRequest.mock.calls.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect("reassembles a thread from the flat comment list, replies included", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              values: [
                {
                  id: 10,
                  content: { raw: "rename this" },
                  user: { nickname: "bilal" },
                  created_on: "2026-06-16T05:04:32+00:00",
                  inline: { path: "src/a.ts", to: 12, from: null },
                  resolution: { type: "pullrequest_comment_resolution" },
                },
                {
                  id: 11,
                  content: { raw: "done" },
                  user: { nickname: "julius" },
                  created_on: "2026-06-16T06:04:32+00:00",
                  parent: { id: 10 },
                },
                // A reply to a reply still belongs to the thread its root opened.
                {
                  id: 12,
                  content: { raw: "thanks" },
                  user: { nickname: "bilal" },
                  created_on: "2026-06-16T07:04:32+00:00",
                  parent: { id: 11 },
                },
                {
                  id: 13,
                  content: { raw: "ship it" },
                  user: { nickname: "bilal" },
                  created_on: "2026-06-16T08:04:32+00:00",
                },
              ],
            }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const { threads } = yield* api.listComments({ repository: "acme/web", number: 7 });

      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "10",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: true,
      });
      expect(threads[0]?.comments.map((comment) => comment.id)).toEqual(["10", "11", "12"]);
    }),
  );

  it.effect("writes a review's line comments, its summary, then its verdict", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.submitReview({
        repository: "acme/web",
        number: 7,
        verdict: "request-changes",
        body: "Two things.",
        comments: [{ path: "src/a.ts", line: 12, side: "left", body: "why remove?" }],
      });

      expect(callAt(0).url).toContain("/pullrequests/7/comments");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({
        content: { raw: "why remove?" },
        inline: { path: "src/a.ts", from: 12 },
      });
      expect(callAt(1).url).toContain("/pullrequests/7/comments");
      // The verdict goes last, so a review that failed part-way is never a rejection either.
      expect(callAt(2).url).toContain("/pullrequests/7/request-changes");
    }),
  );

  it.effect("resolves by creating the sub-resource and unresolves by deleting it", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.setCommentResolution({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        resolved: true,
      });
      yield* api.setCommentResolution({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        resolved: false,
      });

      assert.strictEqual(callAt(0).method, "POST");
      assert.strictEqual(callAt(1).method, "DELETE");
      expect(callAt(0).url).toContain("/comments/10/resolve");
    }),
  );

  it.effect("replies by naming the comment it answers", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.replyToComment({
        repository: "acme/web",
        number: 7,
        commentId: "10",
        body: "Fixed.",
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({
        content: { raw: "Fixed." },
        parent: { id: 10 },
      });
    }),
  );

  it.effect("asks for the credentials' permission on this repository, and nobody else's", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.succeed(
          response(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({ values: [{ type: "repository_permission", permission: "read" }] }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      assert.isFalse(yield* api.getRepositoryPermission({ repository: "acme/web" }));

      expect(callAt(0).url).toContain("/user/permissions/repositories");
      assert.strictEqual(filterOfCall(0), 'repository.full_name="acme/web"');
    }),
  );

  it.effect("escapes a repository name before it goes inside a filter literal", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValue(Effect.succeed(response(JSON.stringify({ values: [] }))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.getRepositoryPermission({ repository: 'acme/we"b' });

      // A quote would otherwise end the literal and leave the rest standing as filter syntax.
      assert.strictEqual(filterOfCall(0), 'repository.full_name="acme/we\\"b"');
    }),
  );

  it.effect("reads the workspace's people and marks whoever is already a reviewer", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(pullRequestJson({ reviewers: [octocat] }))))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify({ values: [{ user: bilal }, { user: octocat }, { user: hubot }] }),
            ),
          ),
        );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const list = yield* api.listReviewerCandidates({ repository: "acme/web", number: 7 });

      // The people live on the workspace: nothing on a repository lists who may review it.
      expect(callAt(1).url).toBe("/workspaces/acme/members?pagelen=50");
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["{octocat}", true],
        ["{hubot}", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("writes the reviewer set back with the one being asked added to it", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(pullRequestJson({ reviewers: [octocat] }))))
        .mockReturnValueOnce(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.setReviewerRequest({
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "{hubot}" }],
        requested: true,
      });

      // Bitbucket writes `reviewers` whole, so the one already on the pull request travels with
      // the new one or the request would take them off it.
      const call = callAt(1);
      expect(call.method).toBe("PUT");
      expect(call.url).toBe("/repositories/acme/web/pullrequests/7");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(call.body ?? "")).toEqual({
        reviewers: [{ uuid: "{octocat}" }, { uuid: "{hubot}" }],
      });
    }),
  );

  it.effect("takes a reviewer out of the set rather than clearing it", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(response(pullRequestJson({ reviewers: [octocat, hubot] }))),
        )
        .mockReturnValueOnce(Effect.succeed(response("{}")));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.setReviewerRequest({
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "{hubot}" }],
        requested: false,
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).body ?? "")).toEqual({ reviewers: [{ uuid: "{octocat}" }] });
    }),
  );
});
