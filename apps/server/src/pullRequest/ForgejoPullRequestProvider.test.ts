import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ForgejoCli, ForgejoCliError, type ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";
import { make } from "./ForgejoPullRequestProvider.ts";

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
          const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(Effect.provide(host.layer));

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
      const provider = yield* make.pipe(
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
