import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "./BitbucketApi.ts";
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

const bilal = { uuid: "{bilal}", nickname: "bilal" };
const octocat = { uuid: "{octocat}", nickname: "octocat" };
const hubot = { uuid: "{hubot}", nickname: "hubot" };

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

function callAt(index: number) {
  const call = mockedRequest.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function filterOfCall(index: number): string | null {
  const url = callAt(index).url;
  return new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("q");
}

afterEach(() => {
  mockedRequest.mockReset();
});

layer("BitbucketPullRequestApi.layer", (it) => {
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

  it.effect("counts the rows it walked past as more to come", () =>
    Effect.gen(function* () {
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

      expect(filterOfCall(0)).toBe(
        '(title ~ "page" OR description ~ "page") AND updated_on <= 2026-07-02T00:00:00+00:00',
      );
    }),
  );

  it.effect("narrows by author and draft state in the same query", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.listPullRequests({
        repository: "acme/web",
        state: "open",
        limit: 50,
        author: 'ana"',
        draft: false,
      });

      expect(filterOfCall(0)).toBe(
        '(author.nickname = "ana\\"" OR author.display_name = "ana\\"") AND draft = false',
      );
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

  it.effect("reads every file version the patch states, not only the paths asked about", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            [
              "diff --git a/a.ts b/a.ts",
              "index 1111111..2222222 100644",
              "--- a/a.ts",
              "+++ b/a.ts",
              "@@ -1 +1 @@",
              "-a",
              "+b",
              "diff --git a/b.ts b/b.ts",
              "index 3333333..4444444 100644",
              "--- a/b.ts",
              "+++ b/b.ts",
              "@@ -1 +1 @@",
              "-c",
              "+d",
              "",
            ].join("\n"),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const revisions = yield* api.getFileRevisions({
        repository: "acme/web",
        number: 71,
        paths: ["a.ts", "missing.ts"],
      });

      assert.deepStrictEqual(
        [...revisions.revisions],
        [
          ["a.ts", "2222222"],
          ["b.ts", "4444444"],
          ["missing.ts", ""],
        ],
      );
      assert.strictEqual(revisions.complete, true);
      expect(callAt(0)).toMatchObject({ url: "/repositories/acme/web/pullrequests/71/diff" });
    }),
  );

  it.effect("says nothing about the files past the end of a patch it could not read whole", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed({
          body: "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n@@ -1 +1 @@\n",
          truncated: true,
        }),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const revisions = yield* api.getFileRevisions({
        repository: "acme/web",
        number: 72,
        paths: ["a.ts", "past-the-cut.ts"],
      });

      assert.deepStrictEqual([...revisions.revisions], [["a.ts", "2222222"]]);
      assert.strictEqual(revisions.complete, false);
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

  it.effect.each([
    { reply: pullRequestJson({ state: "MERGED" }), state: "merged" },
    { reply: JSON.stringify({ type: "task", task_status: "PENDING" }), state: undefined },
  ])("returns the pull request a merge replied with, if any", ({ reply, state }) =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(reply)));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const merged = yield* api.runAction({ repository: "acme/web", number: 7, action: "merge" });

      assert.strictEqual(merged?.state, state);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("asks for the time a pull request closed, which Bitbucket leaves out by default", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            pullRequestJson({ state: "MERGED", closed_on: "2025-06-16T23:40:46.222238+00:00" }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const pullRequest = yield* api.getPullRequest({ repository: "acme/web", number: 7 });

      expect(callAt(0).url).toBe("/repositories/acme/web/pullrequests/7?fields=%2Bclosed_on");
      assert.strictEqual(pullRequest.closedAt, "2025-06-16T23:40:46.222Z");
    }),
  );

  it.effect("stops the comment walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.succeed(
          response(
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

  it.effect("asks for the credentials' permission on this repository, and nobody else's", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(
        Effect.succeed(
          response(
            JSON.stringify({ values: [{ type: "repository_permission", permission: "read" }] }),
          ),
        ),
      );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      assert.isFalse(yield* api.getRepositoryPermission({ repository: "acme/web" }));

      expect(new URL(callAt(0).url, "https://api.bitbucket.org").pathname).toBe(
        "/user/workspaces/acme/permissions/repositories",
      );
      assert.strictEqual(filterOfCall(0), 'repository.full_name="acme/web"');
    }),
  );

  it.effect("escapes a repository name before it goes inside a filter literal", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response(JSON.stringify({ values: [] }))));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      yield* api.getRepositoryPermission({ repository: 'acme/we"b' });

      assert.strictEqual(filterOfCall(0), 'repository.full_name="acme/we\\"b"');
    }),
  );

  const permissionFailure = (status: number) =>
    Effect.fail(
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status,
        responseBodyLength: 0,
      }),
    );

  it.effect.each([403, 404, 410])(
    "reads HTTP %s from the permissions endpoint as an unknown permission",
    (status) =>
      Effect.gen(function* () {
        mockedRequest.mockReturnValue(permissionFailure(status));
        const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

        assert.isTrue(yield* api.getRepositoryPermission({ repository: "acme/web" }));
      }),
  );

  it.effect.each([401, 500])("still fails the permission read on HTTP %s", (status) =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(permissionFailure(status));
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const error = yield* Effect.flip(api.getRepositoryPermission({ repository: "acme/web" }));
      assert.strictEqual(error._tag, "BitbucketResponseError");
      if (error._tag === "BitbucketResponseError") {
        assert.strictEqual(error.status, status);
      }
    }),
  );

  it.effect("reads the workspace's people and marks whoever is already a reviewer", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(pullRequestJson({ reviewers: [octocat] }))))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              JSON.stringify({ values: [{ user: bilal }, { user: octocat }, { user: hubot }] }),
            ),
          ),
        );
      const api = yield* BitbucketPullRequestApi.BitbucketPullRequestApi;

      const list = yield* api.listReviewerCandidates({ repository: "acme/web", number: 7 });

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

      const call = callAt(1);
      expect(call.method).toBe("PUT");
      expect(call.url).toBe("/repositories/acme/web/pullrequests/7");
      expect(JSON.parse(call.body ?? "")).toEqual({
        reviewers: [{ uuid: "{octocat}" }, { uuid: "{hubot}" }],
      });
    }),
  );
});
