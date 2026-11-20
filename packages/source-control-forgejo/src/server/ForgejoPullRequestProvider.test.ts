import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { ChildProcessSpawner } from "effect/process";
import type { ForgejoApiInput } from "./ForgejoCli.ts";

import { ForgejoCli, ForgejoCliError } from "./ForgejoCli.ts";
import * as ForgejoPullRequestApi from "./ForgejoPullRequestApi.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const layer = it.layer(Layer.mock(ForgejoCli)({}));

function apiError(status?: number) {
  return new ForgejoPullRequestApi.ForgejoPullRequestApiError({
    operation: "listChangeRequests",
    detail: "Forgejo said no.",
    ...(status === undefined ? {} : { status }),
  });
}

it("treats a refused token as the instance not being set up", () => {
  // A token with too few scopes is refused with 403, and the fix is the same as for 401: sign
  // in again with the access this needs. Both therefore report as unauthenticated rather than
  // as one request having gone wrong.
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(401)), {
    reason: "unauthenticated",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(403)), {
    reason: "unauthenticated",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(429)), {
    reason: "rate-limited",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError(404)), {
    reason: "failed",
  });
  assert.deepStrictEqual(ForgejoPullRequestProvider.forgejoProviderFailure(apiError()), {
    reason: "failed",
  });
});

it.effect(
  "keeps draft conversion, automatic merge and line replies on the shared fj/tea transport",
  () => {
    const requests: ForgejoApiInput[] = [];
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const target = { cwd: "/repo", host: "forgejo.test", repository: "acme/web", number: 7 };
      yield* provider.runAction({ ...target, action: "ready" });
      yield* provider.runAction({ ...target, action: "enable-auto-merge", mergeMethod: "squash" });
      yield* provider.runAction({ ...target, action: "disable-auto-merge" });
      yield* provider.replyToThread({ ...target, threadId: "12:src/app.ts", body: "Follow-up" });
      const writes = requests.filter((request) => request.method !== "GET");
      assert.deepStrictEqual(
        writes.map(({ method, path, body }) => ({ method, path, body })),
        [
          {
            method: "PATCH",
            path: "repos/acme/web/pulls/7",
            body: { title: "Keep review features" },
          },
          {
            method: "POST",
            path: "repos/acme/web/pulls/7/merge",
            body: { Do: "squash", merge_when_checks_succeed: true },
          },
          { method: "DELETE", path: "repos/acme/web/pulls/7/merge", body: undefined },
          {
            method: "POST",
            path: "repos/acme/web/pulls/7/reviews",
            body: {
              event: "COMMENT",
              body: "",
              comments: [{ path: "src/app.ts", body: "Follow-up", new_position: 12 }],
            },
          },
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: (input) => {
            requests.push(input);
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify({ number: 7, title: "WIP: Keep review features" }),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
      ),
    );
  },
);

it.effect(
  "searches pull request descriptions without repeating filtered rows on the next page",
  () => {
    const rows = [1, 2, 3, 4].map((number) => ({
      number,
      title: "Change",
      body: number % 2 === 0 ? "Repair reconnect" : "Unrelated",
      state: "open",
      merged: false,
      html_url: `https://forgejo.test/acme/web/pulls/${number}`,
      user: { login: "chris" },
      head: { ref: "feature", sha: "head", repo: null },
      base: { ref: "main", sha: "base", repo: null },
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      closed_at: null,
      merged_at: null,
      labels: [],
    }));
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const target = {
        cwd: "/repo",
        host: "forgejo.test",
        repository: "acme/web",
        state: "open" as const,
        involvement: "all" as const,
        viewer: "chris",
        query: "reconnect",
        limit: 1,
      };
      const first = yield* provider.listChangeRequests(target);
      assert.deepStrictEqual(
        first.items.map((row) => row.number),
        [2],
      );
      assert.strictEqual(first.cursorAdvance, 2);
      assert.strictEqual(first.truncated, true);
      const second = yield* provider.listChangeRequests({
        ...target,
        cursor: { delivered: 2, updatedBefore: "2026-09-01T00:00:00Z" },
      });
      assert.deepStrictEqual(
        second.items.map((row) => row.number),
        [4],
      );
      assert.strictEqual(second.cursorAdvance, 2);
      assert.strictEqual(second.truncated, false);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify(rows),
              stderr: 'link: <https://forgejo.test/>; rel="last"',
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    );
  },
);

layer("declares what Forgejo can do", (it) => {
  it.effect("offers no conversation resolution, because Forgejo exposes no route for it", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      assert.strictEqual(provider.kind, "forgejo");
      assert.strictEqual(provider.capabilities.review.resolve, false);
      // Everything else on a review is there.
      assert.strictEqual(provider.capabilities.review.inlineComment, true);
      assert.strictEqual(provider.capabilities.review.reply, true);
      assert.deepStrictEqual(provider.capabilities.review.verdicts, [
        "comment",
        "approve",
        "request-changes",
      ]);
    }),
  );

  it.effect("offers both ways of bringing a stale branch up to date", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      assert.deepStrictEqual(provider.capabilities.updateMethods, ["merge", "rebase"]);
      assert.deepStrictEqual(provider.capabilities.mergeMethods, [
        "merge",
        "squash",
        "rebase",
        "fast-forward",
      ]);
      assert.ok(provider.capabilities.actions.includes("enable-auto-merge"));
      assert.strictEqual(provider.capabilities.reactions, true);
    }),
  );

  it.effect("refuses to resolve a conversation if it is ever asked to", () =>
    Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const exit = yield* Effect.exit(
        provider.setThreadResolution({
          cwd: "/repo",
          host: "git.example.org",
          repository: "acme/web",
          number: 7,
          threadId: "12:src/app.ts",
          resolved: true,
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});

const reference = {
  cwd: "/repo",
  repository: "acme/project",
  host: "https://forgejo.example.com",
  number: 42,
};
const output = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const cliError = (detail: string, httpStatus?: number) =>
  new ForgejoCliError({
    command: "fj",
    cwd: reference.cwd,
    detail,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(httpStatus === 403 ? { reason: "forbidden" as const } : {}),
  });
const repository = (deleteBranch: boolean | undefined) => ({
  full_name: "acme/project",
  default_branch: "main",
  default_delete_branch_after_merge: deleteBranch,
});
const headRepository = { full_name: "acme/project", default_branch: "main", push: true };
const pullRequest = (input: {
  readonly merged?: boolean;
  readonly ref?: string;
  readonly head?: { full_name: string; default_branch: string; push: boolean } | null;
}) => {
  const head = input.head === undefined ? headRepository : input.head;
  return {
    number: reference.number,
    title: "Change",
    body: null,
    html_url: "https://forgejo.example.com/acme/project/pulls/42",
    user: { login: "author" },
    state: input.merged ? "closed" : "open",
    merged: input.merged ?? false,
    head: {
      ref: input.ref ?? "feature",
      sha: "head",
      repo:
        head === null
          ? null
          : {
              full_name: head.full_name,
              default_branch: head.default_branch,
              permissions: { push: head.push, admin: false },
            },
    },
    base: { ref: "main", sha: "base", repo: { full_name: "acme/project" } },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    labels: [],
  };
};
const isForgejoCliError = Schema.is(ForgejoCliError);
const REPO_PATH = "repos/acme/project";
const PULL_PATH = "repos/acme/project/pulls/42";
const MERGE_PATH = "repos/acme/project/pulls/42/merge";

it.effect("keeps branch-policy checks on both summary and detail reads", () => {
  const requests: ForgejoApiInput[] = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    if (!provider.getChangeRequestChecks) return yield* Effect.die("checks read missing");
    const summary = yield* provider.getChangeRequestChecks(reference);
    const detail = yield* provider.getChangeRequest(reference);
    for (const result of [summary, detail]) {
      expect(
        result.checks.map(({ name, status, required }) => ({ name, status, required })),
      ).toEqual([
        { name: "optional", status: "failure", required: undefined },
        { name: "build/linux", status: "success", required: true },
        { name: "security", status: "pending", required: true },
      ]);
    }
    expect(detail.viewerPermissions.actions).toContain("draft");
    expect(detail.viewerPermissions.actions).toContain("enable-auto-merge");
    expect(requests.filter(({ path }) => path === `${REPO_PATH}/branches/main`)).toHaveLength(2);
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli)({
        api: (request) => {
          requests.push(request);
          const uri = new URL(request.path, "https://forgejo.example.com/");
          const endpoint = uri.pathname.slice(1);
          let body: unknown;
          switch (endpoint) {
            case PULL_PATH:
              body = pullRequest({});
              break;
            case REPO_PATH:
              body = { ...repository(true), permissions: { push: true, admin: false } };
              break;
            case "user":
              body = { login: "reviewer" };
              break;
            case `${REPO_PATH}/branches/main`:
              body = { enable_status_check: true, status_check_contexts: ["build/*", "security"] };
              break;
            case `${REPO_PATH}/statuses/head`:
              body =
                uri.searchParams.get("page") === "1"
                  ? ["build/linux", "optional"].map((context) => ({
                      context,
                      status: context === "optional" ? "failure" : "success",
                      description: null,
                      target_url: null,
                      updated_at: "2026-01-01T00:00:00Z",
                    }))
                  : [];
              break;
            default:
              return Effect.die(`unexpected request ${request.path}`);
          }
          return Effect.succeed(output(JSON.stringify(body)));
        },
      }),
    ),
  );
});

it.effect("bounds commit payloads while preserving timeline and file revisions", () => {
  const requests: ForgejoApiInput[] = [];
  const commit = {
    sha: "commit-1",
    author: { login: "author" },
    commit: { message: "Fix reconnect", committer: { date: "2026-01-01T00:00:00Z" } },
    parents: [{ sha: "parent-1" }],
  };
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const activity = yield* provider.getChangeRequestActivity(reference);
    expect(activity.commits.map(({ oid }) => oid)).toEqual(["commit-1"]);
    if (!provider.getDiffFileContents) return yield* Effect.die("file contents read missing");
    const contents = yield* provider.getDiffFileContents({
      ...reference,
      commit: "commit-1",
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      changeType: "change",
    });
    expect(contents).toEqual({ oldContents: "before", newContents: "after" });
    const commitReads = requests.filter(({ path }) => path.includes("/commits"));
    expect(commitReads).toHaveLength(3);
    for (const { path } of commitReads) {
      const query = new URL(path, "https://forgejo.example.com/").searchParams;
      expect(query.get("files")).toBe("false");
      expect(query.get("verification")).toBe("false");
    }
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli)({
        api: (request) => {
          requests.push(request);
          const uri = new URL(request.path, "https://forgejo.example.com/");
          const endpoint = uri.pathname.slice(1);
          let body: unknown;
          switch (endpoint) {
            case PULL_PATH:
              body = pullRequest({});
              break;
            case "user":
              body = { login: "reviewer" };
              break;
            case `${PULL_PATH}/commits`:
              body = uri.searchParams.get("page") === "1" ? [commit] : [];
              break;
            case `${REPO_PATH}/git/commits/commit-1`:
              body = commit;
              break;
            case `${REPO_PATH}/contents/src/app.ts`:
              body = {
                encoding: "base64",
                content: Buffer.from(
                  uri.searchParams.get("ref") === "parent-1" ? "before" : "after",
                ).toString("base64"),
              };
              break;
            case `${REPO_PATH}/issues/42/comments`:
            case `${PULL_PATH}/reviews`:
            case `${REPO_PATH}/issues/42/reactions`:
              body = [];
              break;
            default:
              return Effect.die(`unexpected request ${request.path}`);
          }
          return Effect.succeed(output(JSON.stringify(body)));
        },
      }),
    ),
  );
});

/** Serves the repository, the pull request, and the merge, recording every request. */
const forgejo = (input: {
  readonly repository?: unknown;
  readonly pullRequest?: ReturnType<typeof pullRequest>;
  readonly afterMerge?: ReturnType<typeof pullRequest> | ForgejoCliError;
  readonly merge?: ForgejoCliError;
}) => {
  const requests: ForgejoApiInput[] = [];
  let merged = false;
  const layer = Layer.mock(ForgejoCli)({
    api: (request) => {
      requests.push(request);
      switch (request.path) {
        case REPO_PATH:
          return Effect.succeed(output(JSON.stringify(input.repository ?? repository(true))));
        case PULL_PATH: {
          const pull = merged
            ? (input.afterMerge ?? pullRequest({ merged: true }))
            : (input.pullRequest ?? pullRequest({}));
          return isForgejoCliError(pull)
            ? Effect.fail(pull)
            : Effect.succeed(output(JSON.stringify(pull)));
        }
        case MERGE_PATH:
          merged = true;
          return input.merge ? Effect.fail(input.merge) : Effect.succeed(output(""));
        default:
          return Effect.die(`unexpected request ${request.path}`);
      }
    },
  });
  return { requests, layer };
};

describe("Forgejo merge branch deletion", () => {
  for (const mergeMethod of [undefined, "merge", "squash", "rebase"] as const) {
    it.effect.each([true, false, undefined])(
      `respects repository deletion setting %s when merging with ${mergeMethod ?? "the default"}`,
      (deleteBranch) =>
        Effect.gen(function* () {
          const host = forgejo({ repository: repository(deleteBranch) });
          const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

          yield* provider.runAction({
            ...reference,
            action: "merge",
            ...(mergeMethod === undefined ? {} : { mergeMethod }),
          });

          expect(host.requests.map((request) => request.path)).toEqual(
            deleteBranch ? [REPO_PATH, PULL_PATH, MERGE_PATH] : [REPO_PATH, MERGE_PATH],
          );
          expect(host.requests[0]).toMatchObject({ ...reference, path: REPO_PATH });
          expect(host.requests[0]?.method ?? "GET").toBe("GET");
          expect(host.requests.at(-1)).toMatchObject({
            ...reference,
            path: MERGE_PATH,
            method: "POST",
            body: {
              Do: mergeMethod ?? "merge",
              delete_branch_after_merge: deleteBranch ?? false,
            },
          });
        }),
    );
  }

  it.effect.each([
    {
      name: "a fork the viewer cannot push to",
      pullRequest: pullRequest({
        head: { full_name: "contributor/project", default_branch: "main", push: false },
      }),
    },
    {
      name: "the head repository's default branch",
      pullRequest: pullRequest({
        ref: "main",
        head: { full_name: "contributor/project", default_branch: "main", push: true },
      }),
    },
    { name: "a deleted head repository", pullRequest: pullRequest({ head: null }) },
  ])("keeps the head branch when it is $name", ({ pullRequest }) =>
    Effect.gen(function* () {
      const host = forgejo({ pullRequest });
      const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

      yield* provider.runAction({ ...reference, action: "merge" });

      expect(host.requests.at(-1)).toMatchObject({
        path: MERGE_PATH,
        body: { Do: "merge", delete_branch_after_merge: false },
      });
    }),
  );

  it.effect("deletes a branch in a fork the viewer can push to", () =>
    Effect.gen(function* () {
      const host = forgejo({
        pullRequest: pullRequest({
          head: { full_name: "contributor/project", default_branch: "main", push: true },
        }),
      });
      const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

      yield* provider.runAction({ ...reference, action: "merge" });

      expect(host.requests.at(-1)).toMatchObject({
        path: MERGE_PATH,
        body: { delete_branch_after_merge: true },
      });
    }),
  );

  it.effect("reports a merge that landed when Forgejo refuses to delete the branch", () =>
    Effect.gen(function* () {
      const host = forgejo({ merge: cliError("the head branch is protected", 403) });
      const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

      yield* provider.runAction({ ...reference, action: "merge" });

      expect(host.requests.map((request) => request.path)).toEqual([
        REPO_PATH,
        PULL_PATH,
        MERGE_PATH,
        PULL_PATH,
      ]);
    }),
  );

  it.effect.each([
    { name: "the pull request is still open", afterMerge: pullRequest({ merged: false }) },
    { name: "the merge cannot be confirmed", afterMerge: cliError("Unavailable", 503) },
  ])("reports a failed merge when $name", ({ afterMerge }) =>
    Effect.gen(function* () {
      const host = forgejo({ afterMerge, merge: cliError("Merge conflict", 409) });
      const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

      const result = yield* Effect.result(provider.runAction({ ...reference, action: "merge" }));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PullRequestProviderError",
          operation: MERGE_PATH,
          detail: "Merge conflict",
        },
      });
      expect(host.requests.map((request) => request.path)).toEqual([
        REPO_PATH,
        PULL_PATH,
        MERGE_PATH,
        PULL_PATH,
      ]);
    }),
  );

  it.effect("does not reread a failed merge that never asked to delete the branch", () =>
    Effect.gen(function* () {
      const host = forgejo({
        repository: repository(false),
        merge: cliError("Merge conflict", 409),
      });
      const provider = yield* ForgejoPullRequestProvider.make.pipe(Effect.provide(host.layer));

      const result = yield* Effect.result(provider.runAction({ ...reference, action: "merge" }));

      expect(result).toMatchObject({ _tag: "Failure", failure: { detail: "Merge conflict" } });
      expect(host.requests.map((request) => request.path)).toEqual([REPO_PATH, MERGE_PATH]);
    }),
  );

  it.effect.each([
    "repository request failure",
    "invalid repository",
    "truncated repository",
    "pull request request failure",
  ] as const)("does not merge when reading branch deletion settings fails: %s", (failure) =>
    Effect.gen(function* () {
      const requests: ForgejoApiInput[] = [];
      const provider = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ForgejoCli)({
            api: (input) => {
              requests.push(input);
              if (
                failure ===
                (input.path === REPO_PATH
                  ? "repository request failure"
                  : "pull request request failure")
              ) {
                return Effect.fail(cliError("Repository settings unavailable"));
              }
              return Effect.succeed({
                ...output(
                  JSON.stringify(
                    input.path === REPO_PATH
                      ? {
                          ...repository(true),
                          default_delete_branch_after_merge:
                            failure === "invalid repository" ? "true" : true,
                        }
                      : pullRequest({}),
                  ),
                ),
                stdoutTruncated: failure === "truncated repository",
              });
            },
          }),
        ),
      );

      const result = yield* Effect.result(provider.runAction({ ...reference, action: "merge" }));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PullRequestProviderError", provider: "forgejo", operation: "merge" },
      });
      expect(result._tag === "Failure" && result.failure.detail).toMatch(
        /^The pull request was not merged because its branch deletion setting could not be read\./,
      );
      expect(requests.map((request) => request.path)).not.toContain(MERGE_PATH);
    }),
  );
});

it.effect("reads file revisions from the pull request diff and refuses a truncated one", () =>
  Effect.gen(function* () {
    let truncated = false;
    const diff = [
      "diff --git a/alpha.ts b/alpha.ts",
      "index eb2d7c5..b485fe5 100644",
      "diff --git a/beta.ts b/beta.ts",
      "index b39e8b3..5851425 100644",
      'diff --git "a/caf\\303\\251 notes.txt" "b/caf\\303\\251 notes.txt"',
      "index ffd99ce..6dd9855 100644",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "index 233f5c6..0000000",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "",
    ].join("\n");
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: (input) => {
            assert.strictEqual(input.host, "forge.example:3000");
            assert.strictEqual(input.repository, "reviewer/project");
            assert.strictEqual(input.path, "repos/reviewer/project/pulls/1.diff");
            return Effect.succeed({
              ...TestSourceControlHost.processOutput(diff),
              stdoutTruncated: truncated,
            });
          },
        }),
      ),
    );
    const reference = {
      cwd: "/forgejo",
      repository: "reviewer/project",
      host: "forge.example:3000",
      number: 1,
    };
    const paths = ["alpha.ts", "beta.ts", "café notes.txt", "deleted.txt", "renamed.txt"];
    assert.isDefined(provider.getFileRevisions);
    const answer = yield* provider.getFileRevisions!({ ...reference, paths });
    assert.isTrue(answer.complete);
    assert.deepStrictEqual(
      paths.map((path) => [path, answer.revisions.get(path)]),
      [
        ["alpha.ts", "b485fe5"],
        ["beta.ts", "5851425"],
        ["café notes.txt", "6dd9855"],
        ["deleted.txt", "0000000"],
        ["renamed.txt", ""],
      ],
    );

    truncated = true;
    const refused = yield* Effect.flip(provider.getFileRevisions!({ ...reference, paths }));
    assert.strictEqual(refused._tag, "PullRequestProviderError");
  }),
);

it.effect("filters listed pull requests by the requested state", () =>
  Effect.gen(function* () {
    // Forgejo answers a `state=closed` query with merged and closed-unmerged rows alike.
    const rows = [true, false].map((merged) => ({
      number: merged ? 1 : 2,
      title: `Pull request ${merged ? 1 : 2}`,
      body: "",
      html_url: `https://forge.example:3000/maria/project/pulls/${merged ? 1 : 2}`,
      user: { login: "maria" },
      state: "closed",
      merged,
      head: { ref: "feature", sha: "head-sha", repo: null },
      base: { ref: "main", sha: "base-sha", repo: null },
      created_at: "2026-10-12T00:00:00Z",
      updated_at: "2026-10-12T00:00:00Z",
      closed_at: "2026-10-13T00:00:00Z",
      merged_at: merged ? "2026-10-13T00:00:00Z" : null,
      labels: [],
    }));
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli)({
          api: (input) => {
            const [path, query] = input.path.split("?");
            assert.strictEqual(path, "repos/maria/project/pulls");
            const params = new URLSearchParams(query);
            // A merged list asks Forgejo for closed rows and separates them itself.
            const state = params.get("state");
            assert.ok(state === "closed" || state === "open" || state === "all");
            const page = params.get("page") === "1" && state !== "open" ? rows : [];
            return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(page)));
          },
        }),
      ),
    );
    const input = {
      cwd: "/forgejo",
      repository: "maria/project",
      host: "forge.example:3000",
      involvement: "all" as const,
      viewer: "maria",
      limit: 10,
    };
    const numbers = (state: "open" | "closed" | "merged" | "all") =>
      provider
        .listChangeRequests({ ...input, state })
        .pipe(Effect.map((page) => page.items.map((item) => item.number)));

    assert.deepStrictEqual(yield* numbers("merged"), [1]);
    assert.deepStrictEqual(yield* numbers("closed"), [2]);
    assert.deepStrictEqual(yield* numbers("all"), [1, 2]);
    assert.deepStrictEqual(yield* numbers("open"), []);
  }),
);

const fastForwardOnly = {
  cwd: "/forgejo",
  repository: "maria/project",
  host: "forge.example:3000",
  number: 3,
};
const fastForwardOnlySettings = {
  allow_merge_commits: false,
  allow_squash_merge: false,
  allow_rebase: false,
  allow_rebase_explicit: false,
  allow_fast_forward_only_merge: true,
  default_merge_style: "fast-forward-only",
};
const fastForwardOnlyProvider = (
  writes: Array<{ path: string; body: unknown }>,
  mergeSettings: object = fastForwardOnlySettings,
) =>
  ForgejoPullRequestProvider.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli)({
        api: (input) => {
          const [path] = input.path.split("?");
          const reply = (value: unknown) =>
            Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(value)));
          if (input.method === "POST") {
            writes.push({ path: input.path, body: input.body });
            return reply("");
          }
          switch (path) {
            case "user":
              return reply({ login: "maria" });
            case "repos/maria/project":
              return reply({
                full_name: "maria/project",
                permissions: { push: true, admin: true },
                ...mergeSettings,
              });
            case "repos/maria/project/pulls/3":
              return reply({
                number: 3,
                title: "Fast-forward me",
                body: "",
                html_url: "https://forge.example:3000/maria/project/pulls/3",
                user: { login: "maria" },
                state: "open",
                merged: false,
                mergeable: true,
                head: { ref: "feature", sha: "head-sha", repo: null },
                base: { ref: "main", sha: "base-sha", repo: null },
                merge_base: "base-sha",
                created_at: "2026-10-12T00:00:00Z",
                updated_at: "2026-10-12T00:00:00Z",
                closed_at: null,
                merged_at: null,
                labels: [],
              });
            case "repos/maria/project/branches/main":
              return reply({});
            default:
              return reply([]);
          }
        },
      }),
    ),
  );

it.effect("offers a fast-forward merge on a repository that only allows fast-forward", () =>
  Effect.gen(function* () {
    const provider = yield* fastForwardOnlyProvider([]);
    const detail = yield* provider.getChangeRequest(fastForwardOnly);
    const allowed = provider.capabilities.mergeMethods.filter(
      (method) => detail.mergeCapabilities[method],
    );
    assert.deepStrictEqual(allowed, ["fast-forward"]);
  }),
);

it.effect("does not offer fast-forward when Forgejo omits the setting", () =>
  Effect.gen(function* () {
    const provider = yield* fastForwardOnlyProvider([], {});
    const detail = yield* provider.getChangeRequest(fastForwardOnly);
    const allowed = provider.capabilities.mergeMethods.filter(
      (method) => detail.mergeCapabilities[method],
    );
    assert.deepStrictEqual(allowed, ["merge", "squash", "rebase"]);
  }),
);

it.effect("merges with Forgejo's fast-forward-only style", () =>
  Effect.gen(function* () {
    const writes: Array<{ path: string; body: unknown }> = [];
    const provider = yield* fastForwardOnlyProvider(writes);
    yield* provider.runAction({ ...fastForwardOnly, action: "merge", mergeMethod: "fast-forward" });
    assert.deepStrictEqual(writes, [
      {
        path: "repos/maria/project/pulls/3/merge",
        body: { Do: "fast-forward-only", delete_branch_after_merge: false },
      },
    ]);
  }),
);
