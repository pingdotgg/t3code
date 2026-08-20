import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";

const mockedRequest = vi.fn<BitbucketApi.BitbucketApi["Service"]["request"]>();

const layer = it.layer(
  BitbucketIssueApi.layer.pipe(
    Layer.provide(Layer.mock(BitbucketApi.BitbucketApi)({ request: mockedRequest })),
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
      title: `Issue ${firstNumber + index}`,
      state: "open",
      created_on: "2026-06-16T05:04:32+00:00",
      updated_on: "2026-06-16T05:04:33+00:00",
      links: { html: { href: `https://bitbucket.org/acme/web/issues/${firstNumber + index}` } },
    })),
    ...(next === undefined ? {} : { next }),
  });
}

function valuePage(values: ReadonlyArray<unknown>, next?: string): string {
  return JSON.stringify({ values, ...(next === undefined ? {} : { next }) });
}

/** One issue as `/issues/{id}` answers with it. */
function issueJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    id: 7,
    title: "Issue 7",
    state: "open",
    reporter: { nickname: "bilal" },
    created_on: "2026-06-16T05:04:32+00:00",
    updated_on: "2026-06-16T05:04:33+00:00",
    links: { html: { href: "https://bitbucket.org/acme/web/issues/7" } },
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

layer("BitbucketIssueApi.layer", (it) => {
  it.effect("lists open issues at Bitbucket's page ceiling", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(3, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const batch = yield* api.listIssues({ repository: "acme/web", state: "open", limit: 50 });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      const url = callAt(0).url;
      expect(url).toContain("/repositories/acme/web/issues");
      // Over 50 Bitbucket answers with an empty page and no error, so it is never exceeded.
      expect(url).toContain("pagelen=50");
      expect(url).toContain("sort=-updated_on");
      expect(filterOfCall(0)).toBe('(state = "new" OR state = "open")');
    }),
  );

  it.effect("asks for every state that reads as closed on the closed tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.listIssues({ repository: "acme/web", state: "closed", limit: 50 });

      expect(filterOfCall(0)).toBe(
        '(state = "resolved" OR state = "on hold" OR state = "invalid" OR state = "duplicate" OR state = "wontfix" OR state = "closed")',
      );
    }),
  );

  it.effect("asks for every state at once on the All tab", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.listIssues({ repository: "acme/web", state: "all", limit: 50 });

      const filter = filterOfCall(0);
      for (const state of [
        "new",
        "open",
        "resolved",
        "on hold",
        "invalid",
        "duplicate",
        "wontfix",
        "closed",
      ]) {
        expect(filter).toContain(`state = "${state}"`);
      }
    }),
  );

  it.effect("follows the cursor Bitbucket sends rather than counting offsets", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/issues?page=2";
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))))
        .mockReturnValueOnce(Effect.succeed(response(page(50, 51))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const batch = yield* api.listIssues({ repository: "acme/web", state: "open", limit: 100 });

      assert.strictEqual(batch.items.length, 100);
      assert.isFalse(batch.truncated);
      assert.strictEqual(callAt(1).url, next);
    }),
  );

  it.effect("stops at the caller's page and says more remain", () =>
    Effect.gen(function* () {
      const next = "https://api.bitbucket.org/2.0/repositories/acme/web/issues?page=2";
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(50, 1, next))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const batch = yield* api.listIssues({ repository: "acme/web", state: "open", limit: 50 });

      assert.strictEqual(batch.items.length, 50);
      assert.isTrue(batch.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("searches with a filter expression joined to the state filter", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.listIssues({ repository: "acme/web", state: "open", limit: 50, query: "crash" });

      expect(filterOfCall(0)).toBe(
        '(state = "new" OR state = "open") AND (title ~ "crash" OR content.raw ~ "crash")',
      );
    }),
  );

  it.effect("escapes a quote and a backslash, so a search cannot reshape the filter", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.listIssues({
        repository: "acme/web",
        state: "open",
        limit: 50,
        query: String.raw`a\" OR state = "closed"`,
      });

      const literal = String.raw`a\\\" OR state = \"closed\"`;
      expect(filterOfCall(0)).toContain(`(title ~ "${literal}" OR content.raw ~ "${literal}")`);
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(page(0, 1))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.listIssues({
        repository: "acme/web",
        state: "open",
        limit: 50,
        cursor: { updatedBefore: "2026-07-02T00:00:00.123456+00:00" },
      });

      expect(filterOfCall(0)).toContain("updated_on <= 2026-07-02T00:00:00.123456+00:00");
    }),
  );

  it.effect("refuses a repository that is not workspace and slug", () =>
    Effect.gen(function* () {
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const error = yield* Effect.flip(
        api.listIssues({ repository: "acme/team/web", state: "open", limit: 50 }),
      );

      assert.strictEqual(error._tag, "BitbucketIssueRepositoryUnsupportedError");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("reads an issue's body from its content", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(response(issueJson({ content: { raw: "Steps to reproduce..." } }))),
      );
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const issue = yield* api.getIssue({ repository: "acme/web", number: 7 });

      assert.strictEqual(issue.body, "Steps to reproduce...");
      assert.strictEqual(issue.state, "open");
      expect(callAt(0).url).toBe("/repositories/acme/web/issues/7");
    }),
  );

  it.effect("counts a state outside new and open as closed", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(issueJson({ state: "wontfix" }))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const issue = yield* api.getIssue({ repository: "acme/web", number: 7 });

      assert.strictEqual(issue.state, "closed");
      assert.isNotNull(issue.closedAt);
    }),
  );

  it.effect("creates an issue with the reader's title and body, and its first assignee", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(issueJson({}))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const created = yield* api.createIssue({
        repository: "acme/web",
        title: "Bug",
        body: "It broke.",
        assignee: "octocat",
      });

      assert.strictEqual(created.number, 7);
      expect(callAt(0)).toMatchObject({ method: "POST", url: "/repositories/acme/web/issues" });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({
        title: "Bug",
        content: { raw: "It broke." },
        assignee: { nickname: "octocat" },
      });
    }),
  );

  it.effect("creates an issue with no assignee field at all when none is given", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(issueJson({}))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.createIssue({ repository: "acme/web", title: "Bug", body: "", assignee: null });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ title: "Bug", content: { raw: "" } });
    }),
  );

  it.effect("writes only the fields the reader changed", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.updateIssue({ repository: "acme/web", number: 7, title: "New title" });

      expect(callAt(0)).toMatchObject({ method: "PUT", url: "/repositories/acme/web/issues/7" });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ title: "New title" });
    }),
  );

  it.effect("rewrites an issue comment by its id", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.updateComment({
        repository: "acme/web",
        number: 7,
        commentId: "42",
        body: "Second thoughts",
      });

      expect(callAt(0)).toMatchObject({
        method: "PUT",
        url: "/repositories/acme/web/issues/7/comments/42",
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ content: { raw: "Second thoughts" } });
    }),
  );

  it.effect("closes an issue by writing its state", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "close" });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ state: "closed" });
    }),
  );

  it.effect("reopens an issue by writing its state back to open", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.runAction({ repository: "acme/web", number: 7, action: "reopen" });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ state: "open" });
    }),
  );

  it.effect("posts a comment as a JSON document, so the body stays text", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.comment({ repository: "acme/web", number: 7, body: "true" });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        url: "/repositories/acme/web/issues/7/comments",
        body: '{"content":{"raw":"true"}}',
      });
    }),
  );

  it.effect("writes the one assignee Bitbucket takes, by nickname", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.setAssignee({ repository: "acme/web", number: 7, assignee: "hubot" });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ assignee: { nickname: "hubot" } });
    }),
  );

  it.effect("clears the assignee by writing null rather than an empty object", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValue(Effect.succeed(response("{}")));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      yield* api.setAssignee({ repository: "acme/web", number: 7, assignee: null });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).body ?? "")).toEqual({ assignee: null });
    }),
  );

  it.effect("follows the comment cursor and drops deleted or empty remarks", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            valuePage(
              [
                {
                  id: 10,
                  content: { raw: "First." },
                  user: { nickname: "bilal" },
                  created_on: "2026-06-16T05:04:32+00:00",
                },
                {
                  id: 11,
                  content: { raw: "gone" },
                  deleted: true,
                  created_on: "2026-06-16T05:05:00+00:00",
                },
                { id: 12, content: { raw: "  " }, created_on: "2026-06-16T05:06:00+00:00" },
              ],
              "https://api.bitbucket.org/2.0/comments?page=2",
            ),
          ),
        ),
      );
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            valuePage([
              {
                id: 13,
                content: { raw: "Second." },
                user: { nickname: "julius" },
                created_on: "2026-06-16T06:04:32+00:00",
              },
            ]),
          ),
        ),
      );
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const result = yield* api.listComments({ repository: "acme/web", number: 7 });

      expect(result.comments.map((comment) => comment.id)).toEqual(["10", "13"]);
      assert.isFalse(result.truncated);
      expect(callAt(1).url).toBe("https://api.bitbucket.org/2.0/comments?page=2");
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
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      assert.isFalse(yield* api.getRepositoryPermission({ repository: "acme/web" }));

      expect(callAt(0).url).toContain("/user/permissions/repositories");
      assert.strictEqual(filterOfCall(0), 'repository.full_name="acme/web"');
    }),
  );

  it.effect("fails the read when Bitbucket answers with something unreadable", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(response(JSON.stringify({ error: "nope" }))),
      );
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const error = yield* Effect.flip(api.getIssue({ repository: "acme/web", number: 7 }));

      assert.strictEqual(error._tag, "BitbucketIssueReadError");
    }),
  );

  it.effect("surfaces the response error verbatim rather than stacking a message on top", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.fail(
          new BitbucketApi.BitbucketResponseError({
            operation: "request",
            status: 404,
            responseBodyLength: 0,
          }),
        ),
      );
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const error = yield* Effect.flip(
        api.listIssues({ repository: "acme/web", state: "open", limit: 50 }),
      );

      // Narrowed by the tag rather than asserted into: a different failure must fail the test,
      // not be read as a 404 that never happened.
      assert.strictEqual(error._tag, "BitbucketResponseError");
      assert.strictEqual(error._tag === "BitbucketResponseError" ? error.status : null, 404);
    }),
  );

  it.effect("fails when the credentials belong to no named account", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(JSON.stringify({}))));
      const api = yield* BitbucketIssueApi.BitbucketIssueApi;

      const error = yield* Effect.flip(api.getViewer());

      assert.strictEqual(error._tag, "BitbucketIssueViewerUnavailableError");
    }),
  );
});
