import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";
import { actor, assertRequestId, baseOid, decodeJson, encodeJson, fakeGitCafe, headOid, labels, pull, root, stack, target, timestamp } from "./GitCafePullRequestProvider.helpers2.testkit.ts";
import type { SentRequest } from "./GitCafePullRequestProvider.helpers2.testkit.ts";

describe("GitCafePullRequestProvider changed paths", () => {
  const snapshot = { version: pull.version, headOid, comparisonBaseOid: baseOid };

  it.effect("pages changed paths without fetching diff-file hunks", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/changes": (request: SentRequest) => ({
        ...snapshot,
        items: request.query.has("after")
          ? [{ path: "gone.ts", status: "deleted" }]
          : [{ path: "new name.ts", oldPath: "old name.ts", status: "renamed" }],
        next: request.query.has("after") ? null : "next-page",
      }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const first = yield* provider.getDiffFilePaths!(target);
      const second = yield* provider.getDiffFilePaths!({ ...target, cursor: first.nextCursor! });
      assert.deepStrictEqual(first.files, [{ oldPath: "old name.ts", newPath: "new name.ts" }]);
      assert.deepStrictEqual(second, {
        files: [{ oldPath: "gone.ts", newPath: "gone.ts" }],
        nextCursor: null,
      });
      assert.isFalse(server.sent.some((request) => request.path.includes("/diff-file")));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each(["getDiff", "getDiffFilePaths"] as const)(
    "%s rejects a repeated continuation cursor",
    (method) => {
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": pull,
        "GET /repos/owner/repo/pulls/7/changes": { ...snapshot, items: [], next: "same-page" },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const first = yield* provider[method]!(target);
        const input = { ...target, cursor: first.nextCursor! };
        const result =
          method === "getDiff"
            ? yield* provider.getDiff(input).pipe(Effect.result)
            : yield* provider.getDiffFilePaths!(input).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(server.layer));
    },
  );

  // getDiff cases guard parity with the existing patch path; getDiffFilePaths must refuse the same pages.
  it.effect.each(
    (["getDiff", "getDiffFilePaths"] as const).flatMap((method) =>
      [{ version: 5 }, { headOid: baseOid }, { comparisonBaseOid: headOid }].map((changed) => ({
        method,
        changed,
      })),
    ),
  )(
    "$method refuses a continuation from a different revision ($changed)",
    ({ method, changed }) => {
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": pull,
        "GET /repos/owner/repo/pulls/7/changes": (request: SentRequest) => ({
          ...snapshot,
          ...(request.query.has("after") ? changed : {}),
          items: [],
          next: request.query.has("after") ? null : "next-page",
        }),
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const read = (cursor?: string) =>
          method === "getDiff"
            ? provider.getDiff({ ...target, ...(cursor === undefined ? {} : { cursor }) })
            : provider.getDiffFilePaths!({
                ...target,
                ...(cursor === undefined ? {} : { cursor }),
              });
        const first = yield* read();
        const input = { ...target, cursor: first.nextCursor! };
        const result =
          method === "getDiff"
            ? yield* provider.getDiff(input).pipe(Effect.result)
            : yield* provider.getDiffFilePaths!(input).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each(["getDiff", "getDiffFilePaths"] as const)(
    "%s reads a pull that reports no head yet",
    (method) => {
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": { ...pull, headOid: null },
        "GET /repos/owner/repo/pulls/7/changes": { ...snapshot, items: [], next: null },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const result = yield* provider[method]!(target);
        assert.isNull(result.nextCursor);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each([{ version: 5 }, { headOid: baseOid }])(
    "refuses initial changed paths from a different pull revision (%j)",
    (changed) => {
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": pull,
        "GET /repos/owner/repo/pulls/7/changes": { ...snapshot, ...changed, items: [], next: null },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const result = yield* provider.getDiffFilePaths!(target).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(server.layer));
    },
  );
});

describe("GitCafePullRequestProvider source contents", () => {
  const comparisonBase = "a".repeat(40);
  const snapshot = { version: pull.version, headOid, comparisonBaseOid: comparisonBase };
  const input = {
    ...target,
    changeType: "rename-changed" as const,
    oldPath: "old name.ts",
    newPath: "src/new #name.ts",
  };
  const blob = (request: SentRequest) => ({
    commit: request.query.get("oid"),
    oid: "b".repeat(40),
    path: request.query.get("path"),
    size: 16,
    binary: false,
    content: "const value = 1;",
  });
  const routes = {
    "GET /repos/owner/repo/pulls/7": pull,
    "GET /repos/owner/repo/pulls/7/changes": snapshot,
    "GET /repos/owner/repo/blob": blob,
  };

  it.effect(
    "pins rename source to the comparison base and fork head, without reading branches",
    () => {
      const server = fakeGitCafe({
        ...routes,
        "GET /repos/owner/repo/pulls/7": {
          ...pull,
          sourceRepo: { owner: "fork", name: "project" },
        },
        "GET /repos/fork/project/blob": blob,
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const result = yield* provider.getDiffFileContents!(input);
        assert.deepStrictEqual(result, {
          oldContents: "const value = 1;",
          newContents: "const value = 1;",
        });
        const changes = server.sent.find((request) => request.path.endsWith("/changes"))!;
        assert.strictEqual(changes.query.get("expectedVersion"), "4");
        assert.strictEqual(changes.query.get("limit"), "1");
        assert.deepStrictEqual(
          server.sent
            .filter((request) => request.path.endsWith("/blob"))
            .map((request) => ({
              path: request.path,
              oid: request.query.get("oid"),
              file: request.query.get("path"),
              ref: request.query.get("ref"),
            })),
          [
            { path: "/repos/owner/repo/blob", oid: comparisonBase, file: input.oldPath, ref: null },
            { path: "/repos/fork/project/blob", oid: headOid, file: input.newPath, ref: null },
          ],
        );
        assert.deepStrictEqual(server.writes(), []);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each(["new", "deleted"] as const)(
    "skips the absent side of a %s file",
    (changeType) => {
      const server = fakeGitCafe(routes);
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const result = yield* provider.getDiffFileContents!({ ...input, changeType });
        assert.strictEqual(result[changeType === "new" ? "oldContents" : "newContents"], "");
        assert.lengthOf(
          server.sent.filter((request) => request.path.endsWith("/blob")),
          1,
        );
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each([
    { ...snapshot, version: 5 },
    { ...snapshot, headOid: baseOid },
    { ...snapshot, comparisonBaseOid: "main" },
  ])("refuses a changed or nonimmutable comparison snapshot", (response) => {
    const server = fakeGitCafe({ ...routes, "GET /repos/owner/repo/pulls/7/changes": response });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getDiffFileContents!(input).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.isFalse(server.sent.some((request) => request.path.endsWith("/blob")));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    { binary: true, content: null },
    { content: "binary\0data" },
    { size: 1_048_577 },
    { size: 1, content: "x".repeat(1_048_577) },
    { size: 1, content: "é".repeat(524_289) },
    { commit: baseOid },
    { path: "another.ts" },
    { content: null },
  ])("refuses unavailable, oversized, binary, or mismatched blobs", (fields) => {
    const server = fakeGitCafe({
      ...routes,
      "GET /repos/owner/repo/blob": (request: SentRequest) => ({ ...blob(request), ...fields }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getDiffFileContents!(input).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    [413, "oversized"],
    [501, "unavailable"],
  ] as const)("marks HTTP %s blob refusals permanently unavailable", ([status, reason]) => {
    const server = fakeGitCafe({
      ...routes,
      "GET /repos/owner/repo/blob": new Response("{}", { status }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const error = yield* provider.getDiffFileContents!({ ...input, changeType: "new" }).pipe(
        Effect.flip,
      );
      assert.deepInclude(error.cause as object, {
        _tag: "GitCafeDiffSourceUnavailableError",
        reason,
      });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("preserves authentication failures from blob access", () => {
    const server = fakeGitCafe({
      ...routes,
      "GET /repos/owner/repo/blob": new Response("{}", { status: 401 }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const error = yield* provider.getDiffFileContents!({ ...input, changeType: "new" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(error.reason, "unauthenticated");
      assert.strictEqual(error.operation, "getDiffFileContents");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "refuses commit-specific contents consistently with unsupported GitCafe commit diffs",
    () => {
      const server = fakeGitCafe({});
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const result = yield* provider.getDiffFileContents!({ ...input, commit: headOid }).pipe(
          Effect.result,
        );
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(server.sent, []);
      }).pipe(Effect.provide(server.layer));
    },
  );
});

describe("GitCafePullRequestProvider", () => {
  it.effect("keeps a staging repository's requests and links on staging", () => {
    const server = fakeGitCafe(
      { "GET /repos/owner/repo/pulls/7": pull },
      { env: { CAFE_TOKEN: "env-token", CAFE_HOST: "staging.git.cafe" } },
    );
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const input = {
        ...target,
        host: "staging.git.cafe",
      };
      const preview = yield* provider.getChangeRequestPreview!(input);
      assert.deepInclude(preview, {
        number: 7,
        title: "Change",
        url: "https://staging.git.cafe/owner/repo/pulls/7",
        author: { login: "alice", name: null, avatarUrl: "https://staging.git.cafe/avatars/one" },
        state: "open",
        isDraft: false,
        createdAt: timestamp,
      });
      const summary = yield* provider.getChangeRequestSummary!(input);
      assert.strictEqual(summary.url, "https://staging.git.cafe/owner/repo/pulls/7");
      assert.isTrue(server.sent.every((request) => request.host === "staging.git.cafe"));
      assert.deepStrictEqual(
        server.sent.map((request) => `${request.method} ${request.path}`),
        [
          "GET /repos/owner/repo/pulls/7",
          "GET /repos/owner/repo/pulls/7",
          "GET /repos/owner/repo/pulls/7/changes",
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses a repository outside GitCafe's hosts before sending anything", () => {
    const server = fakeGitCafe({});
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .getChangeRequest({ ...target, host: "github.com" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reports a refused token as unauthenticated and a limit as rate-limited", () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [401, "unauthenticated"],
        [429, "rate-limited"],
      ] as const) {
        const server = fakeGitCafe(
          { "GET /repos/owner/repo/pulls/7/stack": { stack: null } },
          {
            status,
          },
        );
        const error = yield* GitCafePullRequestProvider.make.pipe(
          Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
          Effect.flip,
          Effect.provide(server.layer),
        );
        assert.strictEqual(error.reason, reason);
      }
    }),
  );

  it.effect("never lets fetch follow a redirect with the token", () => {
    const server = fakeGitCafe({ "GET /repos/owner/repo/pulls/7/stack": { stack: null } });
    return GitCafePullRequestProvider.make.pipe(
      Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
      Effect.tap(() =>
        Effect.sync(() =>
          assert.deepStrictEqual(
            server.sent.map((r) => r.redirect),
            ["manual"],
          ),
        ),
      ),
      Effect.provide(server.layer),
    );
  });

  it.effect("follows a renumbered pull request's redirect only within the host's API", () =>
    Effect.gen(function* () {
      const moved = (location: string) =>
        new Response(null, { status: 301, headers: { location } });
      const renumbered = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7/stack": moved("/api/repos/owner/repo/pulls/8/stack"),
        "GET /repos/owner/repo/pulls/8/stack": { stack: null },
      });
      yield* GitCafePullRequestProvider.make.pipe(
        Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
        Effect.provide(renumbered.layer),
      );
      assert.deepStrictEqual(
        renumbered.sent.map((r) => `${r.host}${r.path}`),
        ["git.cafe/repos/owner/repo/pulls/7/stack", "git.cafe/repos/owner/repo/pulls/8/stack"],
      );

      for (const location of [
        "https://evil.example/api/repos/owner/repo/pulls/8/stack",
        "//evil.example/api/repos/owner/repo/pulls/8/stack",
        "https://staging.git.cafe/api/repos/owner/repo/pulls/8/stack",
        "/repos/owner/repo/pulls/8/stack",
      ]) {
        const elsewhere = fakeGitCafe({ "GET /repos/owner/repo/pulls/7/stack": moved(location) });
        const error = yield* GitCafePullRequestProvider.make.pipe(
          Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
          Effect.flip,
          Effect.provide(elsewhere.layer),
        );
        assert.strictEqual(error.detail, "GitCafe answered HTTP 301.");
        assert.strictEqual(elsewhere.sent.length, 1);
      }
    }),
  );

  it.effect("reads the stack a pull request belongs to, with each open layer's head", () => {
    const { "GET /repos/owner/repo/pulls/6": _merged, ...routes } = stack([
      { number: 6, headOid: baseOid, state: "merged" },
      { number: 7, headOid },
    ]);
    const server = fakeGitCafe(routes);
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getChangeRequestStack!(target);
      assert.strictEqual(result?.number, 3);
      assert.deepStrictEqual(
        result?.layers.map((layer) => [layer.number, layer.headSha]),
        [
          [6, undefined],
          [7, headOid],
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("resolves a thread through its root at the root's version", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7/comments": { items: [root], next: null },
      "POST /repos/owner/repo/pulls/7/comments/root/resolve": {
        id: "root",
        threadId: "root",
        version: 3,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.setThreadResolution({ ...target, threadId: "root", resolved: true });
      assert.deepStrictEqual(server.writes(), [
        "POST /repos/owner/repo/pulls/7/comments/root/resolve",
      ]);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 2 });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("keeps the timeline when GitCafe no longer has the head's commits", () => {
    const comment = { ...root, id: "c1", threadId: "c1", body: "Looks good", path: null };
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, state: "closed", closedAt: timestamp },
      "GET /repos/owner/repo/pulls/7/comments": { items: [comment], next: null },
      "GET /repos/owner/repo/pulls/7/reviews": { items: [], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const activity = yield* provider.getChangeRequestActivity(target);
      assert.deepStrictEqual(
        activity.comments.map((entry) => entry.body),
        ["Looks good"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("submits a review against the pull request's current head", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/reviews": { id: "review-1" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.submitReview({
        ...target,
        verdict: "request-changes",
        body: "Please fix",
        comments: [],
      });
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/reviews"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        verdict: "request_changes",
        body: "Please fix",
        commitOid: headOid,
      });
      assertRequestId(server.sent.at(-1)?.body);

      // GitCafe rejects a null body; an empty review leaves it out.
      yield* provider.submitReview({ ...target, verdict: "approve", body: "", comments: [] });
      assert.notProperty(server.sent.at(-1)?.body as object, "body");
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["completed", true],
    ["failed", false],
  ] as const)("merges synchronously and reads a %s outcome", ([state, succeeds]) => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/merge": { id: "merge-1", state, reason: "Blocked" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .runAction({ ...target, action: "merge", mergeMethod: "squash" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, succeeds ? "Success" : "Failure");
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/merge"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        strategy: "squash",
        headOid,
        expectedVersion: 4,
      });
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "lands a stack through a layer only while its heads are the ones the reader saw",
    () => {
      const layers = [
        { number: 6, headOid: baseOid },
        { number: 7, headOid },
      ];
      const server = fakeGitCafe({
        ...stack(layers),
        "POST /repos/owner/repo/pulls/stacks/3/land-through": {
          id: "land-1",
          state: "completed",
          landedCount: 2,
          stepCount: 2,
          stopReason: null,
          error: null,
          steps: [],
        },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const heads = layers.map((layer) => ({ number: layer.number, headSha: layer.headOid }));
        const stale = yield* provider
          .runAction({
            ...target,
            action: "merge",
            stackNumber: 3,
            expectedStackHeads: [heads[0]!, { number: 7, headSha: baseOid }],
          })
          .pipe(Effect.result);
        assert.strictEqual(stale._tag, "Failure");
        assert.deepStrictEqual(server.writes(), []);

        yield* provider.runAction({
          ...target,
          action: "merge",
          stackNumber: 3,
          expectedStackHeads: heads,
          mergeMethod: "merge",
        });
        assert.deepStrictEqual(server.writes(), [
          "POST /repos/owner/repo/pulls/stacks/3/land-through",
        ]);
        assert.deepInclude(server.sent.at(-1)?.body as object, {
          expectedRevision: 5,
          throughPullRequestNumber: 7,
          strategy: "merge",
        });
        assertRequestId(server.sent.at(-1)?.body);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each([
    ["authored", "authors"],
    ["reviewing", "reviewers"],
  ] as const)("filters %s pull requests by the viewer's actor on GitCafe", ([involvement, key]) => {
    const server = fakeGitCafe({
      "GET /auth/principal": { actorId: "act_one", handle: "Alice" },
      "GET /repos/owner/repo/pulls": { items: [pull], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement,
        viewer: "alice",
        limit: 10,
      });
      assert.strictEqual(server.sent.at(-1)?.query.get(key), '["act_one"]');
      assert.strictEqual(
        page.items[0]?.reviewRequestLogins.includes("alice"),
        involvement === "reviewing",
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("narrows a listing on GitCafe by label ids, draft state and the author's actor", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/labels": { items: labels, next: null },
      "GET /users/bob": { actorId: "act_bob", handle: "bob" },
      "GET /repos/owner/repo/pulls": { items: [pull], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 10,
        filters: {
          draft: "hide",
          labels: [["missing"], ["Bug", "docs"]],
          excludedLabels: ["docs", "missing"],
          author: "bob",
        },
      });
      const listing = server.sent.at(-1)!;
      assert.strictEqual(listing.path, "/repos/owner/repo/pulls");
      assert.strictEqual(listing.query.get("labels"), '["label_bug","label_docs"]');
      assert.strictEqual(listing.query.get("labelNots"), '["label_docs"]');
      assert.strictEqual(listing.query.get("stateNots"), '["draft"]');
      assert.strictEqual(listing.query.get("authors"), '["act_bob"]');
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("finds a GitHub-synced author's actor on their pull requests to narrow by it", () => {
    const synced = {
      ...pull,
      number: 8,
      author: { kind: "github", actorId: "act_synced", login: "Synced", avatarUrl: null },
    };
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls": (request: SentRequest) =>
        request.query.get("authors") === '["act_synced"]'
          ? { items: [synced], next: null }
          : request.query.get("after") === null
            ? { items: [pull], next: "o1" }
            : { items: [synced], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const list = (author: string) =>
        provider.listChangeRequests({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "alice",
          limit: 10,
          filters: { author },
        });
      const page = yield* list("synced");
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [8],
      );
      assert.strictEqual(server.sent.at(-1)!.query.get("authors"), '["act_synced"]');
      // Once seen, the actor is narrowed by straight away.
      const sentBefore = server.sent.length;
      yield* list("synced");
      assert.deepStrictEqual(
        server.sent.slice(sentBefore).map((request) => request.query.get("authors")),
        [null, '["act_synced"]'],
      );
      // An author on none of the pages it reads gets nothing rather than unnarrowed rows a
      // continuation would count against a different listing.
      const missing = yield* list("nobody");
      assert.deepStrictEqual(missing, { items: [], truncated: false, continues: false });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("carries a listing on after the last row delivered when rows above it close", () => {
    const created = (number: number) => `2026-09-12T12:00:0${9 - number}Z`;
    let pulls = [1, 2, 3, 4, 5].map((number) => ({ ...pull, number, createdAt: created(number) }));
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls": (request: SentRequest) => {
        const offset = Number(request.query.get("after")?.slice(1) ?? 0);
        const end = offset + Number(request.query.get("limit"));
        return { items: pulls.slice(offset, end), next: end < pulls.length ? `o${end}` : null };
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const list = (cursor?: { readonly resumeAfter?: string }) =>
        provider.listChangeRequests({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "alice",
          limit: 2,
          ...(cursor === undefined
            ? {}
            : { cursor: { updatedBefore: timestamp, delivered: 2, ...cursor } }),
        });
      const first = yield* list();
      assert.deepStrictEqual(
        first.items.map((item) => item.number),
        [1, 2],
      );
      pulls = pulls.filter((candidate) => candidate.number !== 1);
      const next = yield* list({ resumeAfter: first.resumeAfter! });
      assert.deepStrictEqual(
        next.items.map((item) => item.number),
        [3, 4],
      );
      assert.isTrue(next.truncated);
      assert.isTrue(next.continues);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("lists nothing for a viewer the token does not belong to", () => {
    const server = fakeGitCafe({
      "GET /auth/principal": { actorId: "act_two", handle: "bob" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "authored",
        viewer: "alice",
        limit: 10,
      });
      assert.deepStrictEqual(page.items, []);
      assert.deepStrictEqual(
        server.sent.map((request) => request.path),
        ["/auth/principal"],
      );
    }).pipe(Effect.provide(server.layer));
  });
});

