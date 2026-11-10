import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();
const mockedExists = vi.fn((_path: string) => false);

const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
    Layer.provide(
      FileSystem.layerNoop({ exists: (path) => Effect.sync(() => mockedExists(path)) }),
    ),
  ),
);

function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}

function mergeRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

function diffPage(firstIndex: number, count = 100): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      old_path: `src/${firstIndex + index}.ts`,
      new_path: `src/${firstIndex + index}.ts`,
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    })),
  );
}

function notes(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      body: `note ${firstId + index}`,
      author: { username: "bilal" },
      created_at: "2026-07-01T00:00:00Z",
    })),
  );
}

const author = { id: 1, username: "bilal" };
const labelPermission = output(
  JSON.stringify({
    data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: false } } } },
  }),
);
const reviewer = { id: 5, username: "octocat" };

function mergeRequestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author,
    ...overrides,
  });
}

function sourceBranchJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      project: {
        mergeRequest: {
          state: "merged",
          sourceBranch: "feat/page",
          diffHeadSha: "head",
          sourceProject: { fullPath: "acme/web" },
          userPermissions: { removeSourceBranch: true },
          ...overrides,
        },
      },
    },
  });
}

function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

function graphqlListNode(number: number) {
  return {
    iid: String(number),
    title: `Merge request ${number}`,
    webUrl: `https://gitlab.com/acme/web/-/merge_requests/${number}`,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    sourceBranch: "feat/page",
    targetBranch: "main",
    approved: true,
    approvedBy: { nodes: [{ username: "julius" }] },
  };
}

function graphqlListPage(
  numbers: ReadonlyArray<number>,
  pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      metadata: { enterprise: true },
      project: { mergeRequests: { pageInfo, nodes: numbers.map(graphqlListNode) } },
    },
  });
}

function graphqlRequestOf(index: number) {
  return JSON.parse(callAt(index).stdin ?? "{}") as {
    readonly query: string;
    readonly variables: Record<string, unknown>;
  };
}

afterEach(() => {
  mockedExecute.mockReset();
  mockedExists.mockReset();
});

layer("GitLabPullRequestCli.layer", (it) => {
  it.effect("batches approval reads at GitLab's page limit and skips an empty list", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ stdin }) => {
        const { variables } = JSON.parse(stdin ?? "{}");
        return Effect.succeed(
          output(
            JSON.stringify({
              data: {
                metadata: { enterprise: true },
                project: {
                  mergeRequests: {
                    nodes: variables.iids.map((iid: string) => ({
                      iid,
                      approved: true,
                      approvedBy: { nodes: [{ username: "reviewer" }] },
                    })),
                  },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.internal" };
      expect(yield* cli.getListStates({ ...reference, numbers: [] })).toEqual(new Map());
      expect(mockedExecute).not.toHaveBeenCalled();
      const decisions = yield* cli.getListStates({
        ...reference,
        numbers: Array.from({ length: 101 }, (_, index) => index + 1),
      });
      expect(callAt(0).host).toBe(reference.host);
      expect(callAt(1).host).toBe(reference.host);
      expect(decisions.size).toBe(101);
      expect(decisions.get(101)).toEqual({ reviewDecision: "approved", checksState: null });
      expect(mockedExecute).toHaveBeenCalledTimes(2);
      expect(
        [0, 1].map((index) => JSON.parse(callAt(index).stdin ?? "{}").variables.iids.length),
      ).toEqual([100, 1]);
      expect(argsOfCall(0)).toEqual([
        "api",
        "graphql",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
    }),
  );

  it.effect("asks GitLab for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 3);
      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("projects/acme%2Fweb/merge_requests");
      expect(path).toContain("per_page=11");
      expect(path).toContain("state=opened");
    }),
  );

  it.effect("walks pages at a fixed size, because GitLab pages by offset", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 1))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 150);
      assert.isTrue(batch.truncated);
      for (const index of [0, 1]) {
        expect(argsOfCall(index)[1]).toContain("per_page=100");
      }
      expect(argsOfCall(0)[1]).toContain("page=1");
      expect(argsOfCall(1)[1]).toContain("page=2");
    }),
  );

  it.effect("asks GitLab for the labels, author and draft state it can filter on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        filters: {
          labels: [["bug"], ["size:S", "size:XS"], ["a,b"], ["None"]],
          excludedLabels: ["wontfix", "stale", "any"],
          author: "@me",
          draft: "only",
          review: "approved",
        },
      });

      const params = new URLSearchParams((argsOfCall(0)[1] ?? "").split("?")[1]);
      expect(params.get("labels")).toBe("bug");
      expect(params.get("not[labels]")).toBe("wontfix,stale");
      expect(params.get("author_username")).toBe("bilal");
      expect(params.get("wip")).toBe("yes");
      expect(params.get("approved_by_usernames[]")).toBe("Any");
    }),
  );

  it.effect("narrows by approval only where GitLab returns every row the decision keeps", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const reviews = ["none", "review-required", "changes-requested"] as const;
      for (const review of reviews) {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))));
        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { review },
        });
      }

      const sent = reviews.map((_, call) => {
        const params = new URLSearchParams((argsOfCall(call)[1] ?? "").split("?")[1]);
        return [params.get("approved_by_ids[]"), params.get("approved_by_usernames[]")];
      });
      expect(sent).toEqual([
        ["None", null],
        [null, null],
        [null, null],
      ]);
    }),
  );

  it.effect(
    "lists through GraphQL with the filters GitLab narrows there, declaring only those",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(output(graphqlListPage([1], { hasNextPage: false, endCursor: null }))),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          query: " page ",
          graphql: true,
          cursor: {
            updatedBefore: "2026-07-03T00:00:00Z",
            delivered: 10,
            resumeAfter: "eyJpZCI6IjEifQ",
          },
          filters: {
            labels: [["bug"], ["size:S", "size:XS"]],
            excludedLabels: ["wontfix"],
            author: "octocat",
            draft: "hide",
            review: "changes-requested",
          },
        });

        const { query, variables } = graphqlRequestOf(0);
        expect(variables).toEqual({
          fullPath: "acme/web",
          first: 10,
          after: "eyJpZCI6IjEifQ",
          state: "opened",
          authorUsername: "octocat",
          search: "page",
          labels: ["bug"],
          draft: false,
          reviewStates: ["REQUESTED_CHANGES"],
          notLabels: ["wontfix"],
        });
        expect(query).toContain("reviewStates: $reviewStates");
        expect(query).toContain("not: { labels: $notLabels }");
        expect(query).not.toContain("$approvedBy");

        // Beside a reviewer, GitLab would match only that reviewer's own state.
        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "reviewing",
          viewer: "bilal",
          limit: 10,
          graphql: true,
          filters: { review: "changes-requested" },
        });
        expect(graphqlRequestOf(1).variables).toMatchObject({ reviewerUsername: "bilal" });
        expect(graphqlRequestOf(1).variables).not.toHaveProperty("reviewStates");
      }),
  );

  it.effect("walks GraphQL pages by GitLab's cursor and hands the last one back", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(graphqlListPage([1, 2], { hasNextPage: true, endCursor: "c1" }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(graphqlListPage([3], { hasNextPage: true, endCursor: "c2" }))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 3,
        graphql: true,
        filters: { review: "approved" },
      });

      expect(batch).toMatchObject({ truncated: true, cursorAdvance: 3, resumeAfter: "c2" });
      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3]);
      expect(batch.listStates?.get(3)).toEqual({ reviewDecision: "approved", checksState: null });
      expect([0, 1].map((call) => graphqlRequestOf(call).variables)).toMatchObject([
        { first: 3, after: null, approvedBy: ["Any"] },
        { first: 1, after: "c1" },
      ]);
    }),
  );

  it.effect("leaves out a project whose batched page is null, loses rows, or signs in apart", () =>
    Effect.gen(function* () {
      // glab reads /w/own as the account in its own config, so it is read on its own.
      mockedExists.mockImplementation((path) => {
        const parts = path.split(/[\\/]/u);
        return parts.at(-1) === ".git" || (parts.includes("own") && parts.at(-1) === "config.yml");
      });
      const page = (nodes: ReadonlyArray<unknown>, hasNextPage: boolean) => ({
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : null },
        nodes,
      });
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                metadata: { enterprise: true },
                projects: {
                  nodes: [
                    { fullPath: "acme/web", mergeRequests: page([graphqlListNode(1)], true) },
                    { fullPath: "acme/docs", mergeRequests: null },
                    { fullPath: "acme/api", mergeRequests: page([null, graphqlListNode(3)], true) },
                    { fullPath: "acme/ops", mergeRequests: page([null], false) },
                  ],
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const pages = yield* cli.listMergeRequestsInProjects({
        repositories: [
          { repository: "acme/own", cwd: "/w/own" },
          ...["acme/web", "acme/docs", "acme/api", "acme/ops"].map((repository) => ({
            repository,
            cwd: "/w/shared",
          })),
        ],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        first: 2,
      });

      expect(pages.map(({ repository, batch }) => [repository, batch.items.length])).toEqual([
        ["acme/web", 1],
        ["acme/ops", 0],
      ]);
      const [request] = mockedExecute.mock.calls[0]!;
      expect(request.cwd).toBe("/w/shared");
      expect(JSON.parse(request.stdin ?? "{}").variables.fullPaths).toEqual([
        "acme/web",
        "acme/docs",
        "acme/api",
        "acme/ops",
      ]);
    }),
  );

  it.effect("reads a batched answer larger than one project's output allowance", () =>
    Effect.gen(function* () {
      const repositories = Array.from({ length: 10 }, (_, index) => `acme/p${index}`);
      const body = JSON.stringify({
        data: {
          metadata: { enterprise: true },
          projects: {
            nodes: repositories.map((fullPath) => ({
              fullPath,
              mergeRequests: {
                pageInfo: { hasNextPage: true, endCursor: "c1" },
                nodes: Array.from({ length: 99 }, (_, index) => ({
                  ...graphqlListNode(index + 1),
                  title: "x".repeat(1_100),
                })),
              },
            })),
          },
        },
      });
      // VcsProcess truncates stdout at the caller's allowance, 1 MB unless one is given.
      mockedExecute.mockImplementation((request) => {
        const allowance = request.maxOutputBytes ?? 1_000_000;
        return Effect.succeed(output(body.slice(0, allowance), body.length > allowance));
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const pages = yield* cli.listMergeRequestsInProjects({
        repositories: repositories.map((repository) => ({ repository, cwd: "/w" })),
        state: "open",
        involvement: "all",
        viewer: "bilal",
        first: 99,
      });

      expect(body.length).toBeGreaterThan(1_000_000);
      expect(pages.map(({ batch }) => batch.items.length)).toEqual(repositories.map(() => 99));
    }),
  );

  it.effect("reads REST for a REST cursor, and when a first GraphQL read or command fails", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(JSON.stringify({ errors: [{ message: "Field 'search' doesn't exist" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))))
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ errors: [] }))))
        .mockReturnValueOnce(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("502 Bad Gateway"),
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 2))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const list = (cursor?: { updatedBefore: string; delivered: number; resumeAfter?: string }) =>
        cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          // A cursor, not the host's current answer, picks the API.
          graphql: cursor?.resumeAfter === undefined,
          ...(cursor === undefined ? {} : { cursor }),
        });

      yield* list({ updatedBefore: "2026-07-03T00:00:00Z", delivered: 10 });
      const fellBack = yield* list();
      // A resumed GraphQL read stays on GraphQL and fails, since REST would read `delivered` as an offset.
      const resumed = yield* Effect.result(
        list({ updatedBefore: "2026-07-03T00:00:00Z", delivered: 10, resumeAfter: "c1" }),
      );
      const commandFailed = yield* list();

      expect(fellBack.items.map((item) => item.number)).toEqual([1]);
      expect(fellBack).not.toHaveProperty("resumeAfter");
      expect(mockedExecute.mock.calls.map(([request]) => request.args[1]?.split("?")[0])).toEqual([
        "projects/acme%2Fweb/merge_requests",
        "graphql",
        "projects/acme%2Fweb/merge_requests",
        "graphql",
        "graphql",
        "projects/acme%2Fweb/merge_requests",
      ]);
      expect(commandFailed.items.map((item) => item.number)).toEqual([2]);
      expect(resumed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GitLabMergeRequestReadError" },
      });
    }),
  );

  it.effect("carries on from the number of rows already delivered", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      const path = argsOfCall(0)[1] ?? "";
      expect(path).not.toContain("updated_before=");
      expect(path).toContain("order_by=updated_at");
      expect(path).toContain("per_page=11");
      expect(path).toContain("page=1");
    }),
  );

  it.effect("advances beyond several pages sharing the cursor timestamp", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 144))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 155))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 150 },
      });

      expect(argsOfCall(0)[1]).toContain("per_page=11");
      expect(argsOfCall(0)[1]).toContain("page=14");
      expect(argsOfCall(1)[1]).toContain("page=15");
      expect(batch.items.map((item) => item.number)).toEqual([
        151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
      ]);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("advances the cursor through malformed raw rows", () =>
    Effect.gen(function* () {
      const rows = JSON.parse(mergeRequests(2, 1)) as ReadonlyArray<unknown>;
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify([{ iid: "malformed" }, ...rows]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("URL-encodes a search, so it cannot add a parameter of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-a&per_page=1 "b"',
      });

      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("search=-a%26per_page%3D1%20%22b%22");
      assert.strictEqual(path.match(/per_page=/g)?.length, 1);
    }),
  );

  it.effect("stops walking on a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(40, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 40);
      assert.isFalse(batch.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("stops walking when every row on a page fails to decode", () =>
    Effect.gen(function* () {
      const unusable = JSON.stringify(Array.from({ length: 100 }, () => ({ iid: "nope" })));
      mockedExecute.mockReturnValue(Effect.succeed(output(unusable)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect.each([
    { action: "merge", autoMerge: "false", mergeMethod: "squash" },
    { action: "enable-auto-merge", autoMerge: "true", mergeMethod: "squash" },
    { action: "merge", autoMerge: "false", mergeMethod: "rebase" },
  ] as const)(
    "$action with $mergeMethod succeeds on a project requiring the current source SHA",
    ({ action, autoMerge, mergeMethod }) =>
      Effect.gen(function* () {
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        for (const headSha of ["first-head", "updated-head"]) {
          let currentHeadSha = headSha;
          mockedExecute.mockImplementation(({ cwd, args }) => {
            if (args[0] === "mr" && args[1] === "rebase") {
              return Effect.sync(() => {
                currentHeadSha = `${headSha}-rebased`;
                return output("");
              });
            }
            if (args[0] === "api") {
              return Effect.succeed(
                output(
                  mergeRequestJson({
                    diff_refs: { base_sha: "base", head_sha: currentHeadSha, start_sha: "start" },
                  }),
                ),
              );
            }
            if (args.includes("--rebase") || args[args.indexOf("--sha") + 1] !== currentHeadSha) {
              return Effect.fail(
                new GitLabCli.GitLabCliCommandError({
                  operation: "execute",
                  command: "glab",
                  cwd,
                  cause: new Error(
                    args.includes("--rebase")
                      ? "Merge must not combine --rebase with --sha: rebase changes the source HEAD"
                      : "SHA must match the current source branch HEAD",
                  ),
                }),
              );
            }
            return Effect.succeed(output(""));
          });

          yield* cli.runMergeRequestAction({
            cwd: "/w",
            repository: "acme/web",
            number: 7,
            action,
            mergeMethod,
          });

          const callsPerAction = mergeMethod === "rebase" ? 3 : 2;
          expect(
            mockedExecute.mock.calls.slice(-callsPerAction).map(([input]) => input.args),
          ).toEqual([
            ...(mergeMethod === "rebase" ? [["mr", "rebase", "7", "--repo", "acme/web"]] : []),
            ["api", "projects/acme%2Fweb/merge_requests/7"],
            [
              "mr",
              "merge",
              "7",
              "--repo",
              "acme/web",
              `--auto-merge=${autoMerge}`,
              "--yes",
              ...(mergeMethod === "squash" ? ["--squash"] : []),
              "--sha",
              mergeMethod === "rebase" ? `${headSha}-rebased` : headSha,
            ],
          ]);
        }
        expect(mockedExecute).toHaveBeenCalledTimes(mergeMethod === "rebase" ? 6 : 4);
      }),
  );

  it.effect.each([
    {
      mergeMethod: "squash",
      squashOnMerge: false,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--squash",
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash-message",
        "Add thing",
      ],
    },
    {
      mergeMethod: "merge",
      squashOnMerge: false,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
      ],
    },
    {
      mergeMethod: "merge",
      squashOnMerge: true,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash",
        "--squash-message",
        "Add thing",
      ],
    },
    {
      mergeMethod: "squash",
      squashOnMerge: false,
      squash: "Co-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--squash",
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash-message",
        "Add thing",
      ],
    },
  ] as const)(
    "removes agent credits from GitLab's default messages for a $mergeMethod (squash on merge: $squashOnMerge)",
    ({ mergeMethod, squashOnMerge, squash, flags }) =>
      Effect.gen(function* () {
        const credits =
          "Co-authored-by: Ada <ada@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>";
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              args[1] === "graphql"
                ? JSON.stringify({
                    data: {
                      project: {
                        mergeRequest: {
                          title: "Add thing",
                          squashOnMerge,
                          defaultMergeCommitMessage: `Merge branch 'feature' into 'main'\n\nAdd thing\n\n${credits}`,
                          defaultSquashCommitMessage: squash,
                        },
                      },
                    },
                  })
                : args[0] === "api"
                  ? mergeRequestJson({
                      diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
                    })
                  : "",
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        yield* cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "merge",
          mergeMethod,
          removeAgentCreditsOnMerge: true,
        });

        expect(mockedExecute.mock.calls.at(-1)?.[0].args).toEqual([
          "mr",
          "merge",
          "7",
          "--repo",
          "acme/web",
          "--auto-merge=false",
          "--yes",
          ...flags,
        ]);
      }),
  );

  it.effect("keeps GitLab's merge messages when they carry no agent credits", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[1] === "graphql"
              ? JSON.stringify({
                  data: {
                    project: {
                      mergeRequest: {
                        defaultMergeCommitMessage: "Merge branch 'feature' into 'main'",
                        defaultSquashCommitMessage: "Add thing",
                      },
                    },
                  },
                })
              : args[0] === "api"
                ? mergeRequestJson({
                    diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
                  })
                : "",
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
        removeAgentCreditsOnMerge: true,
      });

      expect(mockedExecute.mock.calls.at(-1)?.[0].args).toEqual([
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/web",
        "--auto-merge=true",
        "--yes",
        "--squash",
        "--sha",
        "head",
      ]);
    }),
  );

  it.effect.each(["merge", "enable-auto-merge"] as const)(
    "does not run %s when GitLab has no diff revisions",
    (action) =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(output(mergeRequestJson({ diff_refs: null }))),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const result = yield* Effect.result(
          cli.runMergeRequestAction({
            cwd: "/w",
            repository: "acme/web",
            number: 7,
            action,
            mergeMethod: "squash",
          }),
        );

        expect(mockedExecute.mock.calls.map(([input]) => input.args)).toEqual([
          ["api", "projects/acme%2Fweb/merge_requests/7"],
        ]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "GitLabDiffRefsUnavailableError" },
        });
      }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.commentOnMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        body: "true",
      });

      const call = mockedExecute.mock.calls[0];
      assert.isDefined(call);
      expect(call[0].args).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/notes",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      expect(call[0].stdin).toBe('{"body":"true"}');
    }),
  );

  it.effect("reads one diff page and hands back the cursor for the next", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(diffPage(0))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNotNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      expect(argsOfCall(0)[1]).toContain("merge_requests/7/diffs?per_page=30&page=1");
    }),
  );

  it.effect(
    "pages a merge request diff 30 files at a time, which GitLab 15.7 to 17.10 accept",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(Effect.succeed(output(diffPage(0, 30))))
          .mockReturnValueOnce(Effect.succeed(output(diffPage(30, 30))))
          .mockReturnValueOnce(Effect.succeed(output(diffPage(60, 5))));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
        const target = { cwd: "/w", repository: "acme/web", number: 7 };

        let patch = "";
        let cursor: string | undefined;
        do {
          const slice = yield* cli.getMergeRequestDiff({ ...target, cursor });
          patch += slice.patch;
          cursor = slice.nextCursor ?? undefined;
        } while (cursor !== undefined);

        expect(mockedExecute.mock.calls.map(([call]) => call.args[1])).toEqual([
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=1",
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=2",
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=3",
        ]);
        assert.strictEqual(patch.match(/^diff --git /gm)?.length, 65);
        expect(patch).toContain("diff --git a/src/64.ts b/src/64.ts");
      }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a query", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from its own diff, and pages inside it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(100, 3))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      };

      const first = yield* cli.getMergeRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      const second = yield* cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor });

      const commitPath =
        "projects/acme%2Fweb/repository/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/diff";
      expect(argsOfCall(0)[1]).toBe(`${commitPath}?per_page=100&page=1`);
      expect(argsOfCall(1)[1]).toBe(`${commitPath}?per_page=100&page=2`);
      assert.isNull(second.nextCursor);
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a path", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "../../merge_requests/8/diffs",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reports a commit with no parent as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitParentUnavailableError");
      if (error._tag === "GitLabDiffCommitParentUnavailableError") {
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("first contents\n")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/first.ts",
        newPath: "src/first.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "first contents\n" });
      expect(argsOfCall(1)[1]).toContain("raw?ref=a1b2c3d");
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("binary\uFFFDcontents", false, true)),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffFileContentsUnavailableError");
      if (error._tag === "GitLabDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before\uFFFDafter")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before\uFFFDafter");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("fails a diff page cut off mid-JSON rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed({ ...output('[{"old_path":"src/x.ts","new_p'), stdoutTruncated: true }),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
    }),
  );

  it.effect("offers no squash when the project does not say it allows one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ merge_method: "merge" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: true, squash: false, rebase: false });
    }),
  );

  it.effect("reads the project's merge settings as its merge capabilities", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ merge_method: "ff", squash_option: "never" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: false, squash: false, rebase: true });
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabViewerUnavailableError");
    }),
  );

  it.effect("walks the notes until GitLab answers with a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(100, 1))));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(2, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { comments, truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(0).join(" ")).toContain("page=1");
      expect(argsOfCall(1).join(" ")).toContain("page=2");
      assert.strictEqual(comments.length, 102);
      assert.isFalse(truncated);
    }),
  );

  it.effect("stops the note walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(notes(100, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect(
    "reads a positioned discussion as a thread and an open overview discussion as a finding",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                {
                  id: "abc123",
                  notes: [
                    {
                      id: 1,
                      body: "rename this",
                      author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                      created_at: "2026-07-01T00:00:00Z",
                      resolvable: true,
                      resolved: true,
                      position: {
                        position_type: "text",
                        new_path: "src/a.ts",
                        old_path: "src/a.ts",
                        new_line: 12,
                        old_line: null,
                        base_sha: "base",
                        start_sha: "start",
                        head_sha: "head",
                      },
                    },
                    {
                      id: 2,
                      body: "done",
                      author: { username: "julius" },
                      created_at: "2026-07-01T01:00:00Z",
                    },
                  ],
                },
                { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
                {
                  id: "ghi789",
                  notes: [
                    {
                      id: 4,
                      body: "mention the new flag in the README",
                      created_at: "2026-07-01T02:00:00Z",
                      resolvable: true,
                      resolved: false,
                    },
                    {
                      id: 5,
                      body: "will do",
                      created_at: "2026-07-01T03:00:00Z",
                      resolvable: true,
                      resolved: false,
                    },
                  ],
                },
                {
                  id: "jkl012",
                  notes: [
                    {
                      id: 6,
                      body: "already addressed",
                      created_at: "2026-07-01T04:00:00Z",
                      resolvable: true,
                      resolved: true,
                    },
                  ],
                },
                {
                  id: "file789",
                  notes: [
                    {
                      id: 7,
                      body: "split this file",
                      created_at: "2026-07-01Z",
                      position: {
                        position_type: "file",
                        new_path: "src/b.ts",
                        old_path: "src/b.ts",
                        new_line: null,
                        old_line: null,
                      },
                    },
                  ],
                },
                {
                  id: "img012",
                  notes: [
                    {
                      id: 8,
                      body: "logo is blurry",
                      created_at: "2026-07-01Z",
                      position: {
                        position_type: "image",
                        new_path: "logo.png",
                        old_path: "logo.png",
                        new_line: null,
                        old_line: null,
                      },
                    },
                  ],
                },
              ]),
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const { threads, diffRefsByThreadId, overviewFindingIds } = yield* cli.listDiscussions({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(overviewFindingIds).toEqual(["4"]);
        expect(threads.map(({ id, path, line, side }) => ({ id, path, line, side }))).toEqual([
          { id: "abc123", path: "src/a.ts", line: 12, side: "right" },
          { id: "file789", path: "src/b.ts", line: null, side: "right" },
          { id: "img012", path: "logo.png", line: null, side: "right" },
        ]);
        expect([...diffRefsByThreadId]).toEqual([
          ["abc123", { baseSha: "base", startSha: "start", headSha: "head" }],
        ]);
        expect(threads[0]).toMatchObject({ isResolved: true });
        assert.strictEqual(threads[0]?.comments.length, 2);
      }),
  );

  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          {
            path: "src/b.ts",
            oldPath: "src/a.ts",
            position: { kind: "deleted", oldLine: 4 },
            body: "why remove?",
          },
        ],
      });

      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "src/a.ts",
          new_path: "src/b.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );

  it.effect("requests changes as a reviewer and reports what GitLab refused", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "bilal" }))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(JSON.stringify({ data: { mergeRequestSetReviewers: { errors: [] } } })),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                data: { mergeRequestRequestChanges: { errors: ["Merge request is locked"] } },
              }),
            ),
          ),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.submitReview({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          verdict: "request-changes",
          body: "Needs work",
          comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
        }),
      );

      expect(mockedExecute).toHaveBeenCalledTimes(3);
      const target = { projectPath: "acme/web", iid: "7" };
      const setReviewers = JSON.parse(callAt(1).stdin ?? "");
      expect(setReviewers.query).toContain("operationMode: APPEND");
      expect(setReviewers.variables).toEqual({ ...target, reviewers: ["bilal"] });
      const requestChanges = JSON.parse(callAt(2).stdin ?? "");
      expect(requestChanges.query).toContain("mergeRequestRequestChanges");
      expect(requestChanges.variables).toEqual(target);
      assert.strictEqual(error._tag, "GitLabMutationRefusedError");
      expect(error.detail).toBe("GitLab refused it: Merge request is locked");
    }),
  );

  it.effect("removes an award by listing them and deleting the reader's own id", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ username: "bilal" }))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify([
              { id: 5, name: "thumbsup", user: { username: "bilal" } },
              { id: 6, name: "thumbsup", user: { username: "julius" } },
            ]),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(argsOfCall(2)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/award_emoji/5",
        "--method",
        "DELETE",
      ]);
    }),
  );

  it.effect("names a merge request with no diff revisions rather than calling it unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: null,
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.submitReview({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          verdict: "comment",
          body: "",
          comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffRefsUnavailableError");
    }),
  );

  it.effect("shows a failed child pipeline that left the head pipeline green", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((request) => {
        switch (request.args[1]) {
          case "graphql":
            return Effect.succeed(output("{}"));
          case "projects/12/pipelines/31/bridges?per_page=100":
            return Effect.succeed(
              output(
                JSON.stringify([
                  {
                    name: "deploy",
                    status: "success",
                    downstream_pipeline: {
                      status: "failed",
                      web_url: "https://gitlab.com/bilal/web/-/pipelines/32",
                    },
                  },
                  { name: "docs", status: "created", downstream_pipeline: null },
                ]),
              ),
            );
          default:
            return Effect.succeed(
              output(
                mergeRequestJson({
                  // A fork's pipeline runs in the source project, so its id is not the target's.
                  head_pipeline: {
                    id: 31,
                    project_id: 12,
                    status: "success",
                    web_url: "https://gitlab.com/bilal/web/-/pipelines/31",
                  },
                }),
              ),
            );
        }
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.checks.map((check) => [check.name, check.status, check.url])).toEqual([
        ["Pipeline", "success", "https://gitlab.com/bilal/web/-/pipelines/31"],
        ["deploy", "failure", "https://gitlab.com/bilal/web/-/pipelines/32"],
      ]);
    }),
  );

  it.effect("keeps the one pipeline check when the trigger jobs cannot be read whole", () =>
    Effect.gen(function* () {
      const detailOutput = output(
        mergeRequestJson({ head_pipeline: { id: 31, project_id: 12, status: "success" } }),
      );
      const failedChild = { name: "deploy", downstream_pipeline: { status: "failed" } };
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      for (const [scenario, bridges] of [
        [
          "read fails",
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("403 Forbidden"),
            }),
          ),
        ],
        // A full page may have left out the trigger job whose pipeline failed.
        [
          "page is full",
          Effect.succeed(output(JSON.stringify(Array.from({ length: 100 }, () => failedChild)))),
        ],
      ] as const) {
        mockedExecute.mockImplementation((request) =>
          request.args[1] === "graphql"
            ? Effect.succeed(output("{}"))
            : request.args[1]?.includes("/bridges")
              ? bridges
              : Effect.succeed(detailOutput),
        );
        const detail = yield* cli.getMergeRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });
        expect(
          detail.checks.map((check) => [check.name, check.status]),
          scenario,
        ).toEqual([["Pipeline", "success"]]);
      }
    }),
  );

  it.effect.each([
    {
      answer: JSON.stringify({
        data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: true } } } },
      }),
      expected: true,
    },
    { answer: JSON.stringify({ errors: [{ message: "Field unknown" }] }), expected: false },
  ])(
    "reads merge and label permissions without reading the trigger jobs or fork settings",
    ({ answer, expected }) =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              args[1] === "graphql"
                ? answer
                : mergeRequestJson({
                    head_pipeline: { id: 31, project_id: 12, status: "success" },
                    user: { can_merge: false },
                    source_project_id: 12,
                    target_project_id: 12,
                    allow_collaboration: null,
                  }),
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const detail = yield* cli.getMergeRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          downstreamChecks: false,
        });

        expect(detail.viewerCanMerge).toBe(false);
        expect(detail.maintainerCanModify).toBeUndefined();
        expect(detail.viewerCanEditLabels).toBe(expected);
        expect(mockedExecute).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect(
    "offers the project's and its groups' labels, marking those already applied, and keeps an applied label past the page",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              args[1]?.includes("/labels?")
                ? JSON.stringify([
                    { name: "bug", color: "#d9534f", description: "Something is broken" },
                    { name: "docs", color: null, description: null },
                    { name: "legacy", color: null, description: null, archived: true },
                    { name: "wontfix", color: null, description: null, archived: true },
                  ])
                : mergeRequestJson({ labels: ["bug", "wontfix", "stale"] }),
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const list = yield* cli.listLabelCandidates({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(
          mockedExecute.mock.calls
            .map(([call]) => call.args[1])
            .find((path) => path?.includes("/labels?")),
        ).toBe("projects/acme%2Fweb/labels?per_page=100&include_ancestor_groups=true");
        expect(list).toEqual({
          candidates: [
            { name: "stale", color: null, description: null, isApplied: true },
            { name: "bug", color: "#d9534f", description: "Something is broken", isApplied: true },
            { name: "docs", color: null, description: null, isApplied: false },
            { name: "wontfix", color: null, description: null, isApplied: true },
          ],
          truncated: false,
        });
      }),
  );

  it.effect("adds labels the project has in one write", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args.includes("PUT")
              ? "{}"
              : JSON.stringify({
                  name: decodeURIComponent(args[1]?.split("/labels/")[1]?.split("?")[0] ?? ""),
                  color: null,
                }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        labels: ["bug", "docs"],
        applied: true,
      });

      const write = mockedExecute.mock.calls.find(([call]) => call.args.includes("PUT"))?.[0];
      assert.isDefined(write);
      expect(write.args[1]).toBe("projects/acme%2Fweb/merge_requests/7");
      expect(JSON.parse(write.stdin ?? "")).toEqual({ add_labels: "bug,docs" });
      expect(argsOfCall(0)[1]).toBe("projects/acme%2Fweb/labels/bug?include_ancestor_groups=true");
    }),
  );

  it.effect("refuses to add a label the project lacks, since GitLab would create it", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(() =>
        Effect.fail(
          new GitLabCli.GitLabCliCommandError({
            operation: "execute",
            command: "glab",
            cwd: "/w",
            cause: new VcsProcessExitError({
              operation: "GitLabCli.execute",
              command: "glab",
              cwd: "/w",
              exitCode: 1,
              detail: "404 Label Not Found",
              failureKind: "not-found",
            }),
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const result = yield* cli
        .setLabels({ cwd: "/w", repository: "acme/web", number: 7, labels: ["bug"], applied: true })
        .pipe(Effect.flip);

      expect(result).toMatchObject({ _tag: "GitLabUnknownLabelError", labels: ["bug"] });
      expect(argsOfCall(0)[1]).toBe("projects/acme%2Fweb/labels/bug?include_ancestor_groups=true");
      expect(mockedExecute.mock.calls.some(([call]) => call.args.includes("PUT"))).toBe(false);
    }),
  );

  it.effect("removes labels without looking them up", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        labels: ["bug"],
        applied: false,
      });

      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ remove_labels: "bug" });
    }),
  );

  it.effect.each([
    { answer: sourceBranchJson({}), expected: true },
    { answer: "not json", expected: false },
  ])("asks GitLab whether a merged merge request's branch can be deleted", ({ answer, expected }) =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ state: "merged" }))))
        .mockReturnValueOnce(Effect.succeed(labelPermission))
        .mockReturnValueOnce(Effect.succeed(output(answer)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.viewerCanDeleteBranch).toBe(expected);
      expect(argsOfCall(2)).toContain("graphql");
    }),
  );

  it.effect("deletes the source branch in the source project once its head is the merged one", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(sourceBranchJson({ sourceProject: { fullPath: "fork/web" } }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                default: false,
                commit: { id: "head", authored_date: "2026-11-03T20:29:40.000-07:00" },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "delete-branch",
      });

      expect(argsOfCall(1)).toEqual(["api", "projects/fork%2Fweb/repository/branches/feat%2Fpage"]);
      expect(argsOfCall(2)).toEqual([
        "api",
        "projects/fork%2Fweb/repository/branches/feat%2Fpage",
        "--method",
        "DELETE",
        "--header",
        "If-Unmodified-Since: Wed, 04 Nov 2026 03:29:40 GMT",
      ]);
    }),
  );

  it.effect.each([
    { reason: "open", source: { state: "opened" }, branch: undefined },
    { reason: "open", source: { state: "locked" }, branch: undefined },
    {
      reason: "not-allowed",
      source: { userPermissions: { removeSourceBranch: false } },
      branch: undefined,
    },
    { reason: "default-branch", source: {}, branch: { default: true, commit: { id: "head" } } },
    { reason: "head-changed", source: {}, branch: { default: false, commit: { id: "newer" } } },
  ])("refuses to delete the source branch when it is $reason", ({ reason, source, branch }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(sourceBranchJson(source))));
      if (branch !== undefined) {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify(branch))));
      }
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* cli
        .runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "delete-branch",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "GitLabBranchDeletionRefusedError", reason });
      expect(mockedExecute).toHaveBeenCalledTimes(branch === undefined ? 1 : 2);
    }),
  );

  it.effect.each([
    { viewer: "the author who can push to the fork", username: "bilal", allowed: true },
    {
      viewer: "the author who turned them off",
      username: "bilal",
      allowCollaboration: false,
      allowed: true,
    },
    { viewer: "a target maintainer the fork lets push", username: "octocat", allowed: false },
    {
      viewer: "the author without push access",
      username: "bilal",
      pushToSourceBranch: false,
      allowed: false,
    },
    {
      viewer: "a viewer on a host that rejects the permission read",
      username: "bilal",
      rejected: true,
      allowed: false,
    },
    {
      viewer: "the author of a protected source branch",
      username: "bilal",
      sourceBranchProtected: true,
      allowed: false,
    },
    {
      viewer: "the author of a private fork",
      username: "bilal",
      sourceVisibility: "private",
      allowed: false,
    },
    {
      viewer: "the author targeting a private project",
      username: "bilal",
      targetVisibility: "private",
      allowed: false,
    },
  ])("reads a fork's maintainer edits and lets $viewer change them", (row) =>
    Effect.gen(function* () {
      const allowCollaboration = row.allowCollaboration ?? true;
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[1] === "graphql"
              ? JSON.stringify(
                  row.rejected === true
                    ? { errors: [{ message: "Field 'pushToSourceBranch' doesn't exist" }] }
                    : {
                        data: {
                          currentUser: { username: row.username },
                          project: {
                            visibility: row.targetVisibility ?? "public",
                            mergeRequest: {
                              author: { username: "bilal" },
                              userPermissions: {
                                pushToSourceBranch: row.pushToSourceBranch ?? true,
                              },
                              sourceBranchProtected: row.sourceBranchProtected ?? false,
                              sourceProject: { visibility: row.sourceVisibility ?? "public" },
                            },
                          },
                        },
                      },
                )
              : mergeRequestJson({
                  author,
                  source_project_id: 40,
                  target_project_id: 12,
                  allow_collaboration: allowCollaboration,
                }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
      });

      expect(detail.maintainerCanModify).toBe(allowCollaboration);
      expect(detail.viewerCanEditMaintainerEdits).toBe(row.allowed);
    }),
  );

  it.effect("skips a fork's maintainer edits permission read when the caller opts out", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                source_project_id: 40,
                target_project_id: 12,
                allow_collaboration: true,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(labelPermission));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
        maintainerEdits: false,
      });

      expect(detail.maintainerCanModify).toBe(true);
      expect(detail.viewerCanEditMaintainerEdits).toBeUndefined();
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("sends maintainer edits as allow_collaboration", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        allowCollaboration: false,
      });

      expect(argsOfCall(0)).toContain("PUT");
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ allow_collaboration: false });
    }),
  );

  it.effect.each([
    ["th", "projects/acme%2Fweb/users?per_page=100"],
    ["tho", "projects/acme%2Fweb/users?per_page=100&search=tho"],
  ] as const)("searches project users only from three characters (%s)", ([search, path]) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify([author]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listProjectUsers({ cwd: "/w", repository: "acme/web", search });

      expect(argsOfCall(0)[1]).toBe(path);
    }),
  );

  it.effect("reads who has access to the project and who is already on the merge request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify([author, reviewer, { id: 9, username: "hubot" }]))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100");
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
        ["9", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect(
    "lists the requested reviewers first, even when the users page does not reach them",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 42, username: "late" }] }))),
          )
          .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([author, reviewer]))));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const list = yield* cli.listReviewerCandidates({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(
          list.candidates.map((candidate) => [
            candidate.login,
            candidate.id,
            candidate.isRequested,
          ]),
        ).toEqual([
          ["late", "42", true],
          [reviewer.username, "5", false],
        ]);
      }),
  );

  it.effect("marks a reviewer GitLab sent without a username as requested on the users page", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 5, username: "" }] }))),
        )
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([author, reviewer]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
      ]);
    }),
  );

  it.effect("asks GitLab to search the project's users when the menu has a query", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 42, username: "unrelated" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([reviewer]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        query: "octo cat",
      });

      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        [reviewer.username, true],
      ]);
      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100&search=octo%20cat");
    }),
  );

  it.effect("writes the reviewer set back with the one being asked added to it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      expect(argsOfCall(1)).toContain("PUT");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5, 9] });
    }),
  );

  it.effect("keeps a reviewer it cannot show when writing the set back", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 3, username: "" }] }))),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [3, 9] });
    }),
  );

  it.effect("takes a reviewer out of the set rather than clearing it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 9, username: "hubot" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: false,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );

  it.effect("ignores an id GitLab could not have handed out, which names nobody", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "octocat" }],
        requested: true,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );
  it.effect("reads blob ids for the marked paths at the merge request's head", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: { repository: { blobs: { nodes: [{ path: "src/a.ts", oid: "aaa" }] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/gone.ts"],
      });

      expect([...revisions]).toEqual([
        ["src/a.ts", "aaa"],
        ["src/gone.ts", ""],
      ]);
      const body: unknown = JSON.parse(callAt(1).stdin ?? "{}");
      expect(body).toMatchObject({
        variables: { fullPath: "acme/web", ref: "head", paths: ["src/a.ts", "src/gone.ts"] },
      });
    }),
  );

  it.effect("leaves the paths out when GitLab did not answer the blobs query", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ data: { project: null } }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/b.ts"],
      });

      expect([...revisions]).toEqual([]);
    }),
  );

  it.effect("splits the paths across requests, because GitLab charges the query by how many", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 150 }, (_, index) => `src/${index}.ts`);
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockImplementation((request) => {
        const body = JSON.parse(request.stdin ?? "{}") as {
          readonly variables: { readonly paths: ReadonlyArray<string> };
        };
        return Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: {
                  repository: {
                    blobs: {
                      nodes: body.variables.paths.map((path) => ({ path, oid: `oid-${path}` })),
                    },
                  },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths,
      });

      assert.strictEqual(revisions.size, 150);
      assert.strictEqual(revisions.get("src/149.ts"), "oid-src/149.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
    }),
  );

  it.effect(
    "reads line counts a hundred at a time per project, keeping the reads that answered",
    () =>
      Effect.gen(function* () {
        const variablesOf = (stdin: string | undefined) =>
          (
            JSON.parse(stdin ?? "{}") as {
              readonly variables: {
                readonly fullPath: string;
                readonly iids: ReadonlyArray<string>;
              };
            }
          ).variables;
        mockedExecute.mockImplementation((request) => {
          const { fullPath, iids } = variablesOf(request.stdin);
          // GitLab answers only what it has (iid 3 is missing), and one project's read fails.
          const nodes = iids
            .filter((iid) => iid !== "3")
            .map((iid) => ({ iid, diffStatsSummary: { additions: Number(iid), deletions: 1 } }));
          return Effect.succeed(
            output(
              JSON.stringify(
                fullPath === "acme/api"
                  ? { errors: [{ message: "Query timed out" }] }
                  : { data: { project: { mergeRequests: { nodes } } } },
              ),
            ),
          );
        });
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const stats = yield* cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [
            ...Array.from({ length: 150 }, (_, index) => ({
              repository: "acme/web",
              number: index + 1,
            })),
            { repository: "acme/api", number: 9 },
          ],
        });

        expect(stats).toHaveLength(149);
        expect(stats).toContainEqual({
          repository: "acme/web",
          number: 150,
          additions: 150,
          deletions: 1,
        });
        expect(stats.some((stat) => stat.number === 3 || stat.repository === "acme/api")).toBe(
          false,
        );
        expect(
          mockedExecute.mock.calls.map(([request]) => {
            const { fullPath, iids } = variablesOf(request.stdin);
            return [fullPath, iids.length];
          }),
        ).toEqual([
          ["acme/web", 100],
          ["acme/web", 50],
          ["acme/api", 1],
        ]);
      }),
  );
  it.effect.each([
    GitLabCli.GitLabCliUnavailableError,
    GitLabCli.GitLabCliAuthenticationError,
    GitLabCli.GitLabCliRateLimitError,
  ])("propagates unusable CLI and account failures from stats (%s)", (ErrorType) =>
    Effect.gen(function* () {
      const error = new ErrorType({
        operation: "execute",
        command: "glab",
        cwd: "/w",
        cause: null,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(error));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [{ repository: "acme/web", number: 7 }],
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: error });
    }),
  );

  it.effect("keeps merge request references when the issue search fails", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        JSON.stringify(input).includes("/issues?")
          ? Effect.fail(
              new GitLabCli.GitLabCliCommandError({
                operation: "execute",
                command: "glab",
                cwd: "/w",
                cause: null,
              }),
            )
          : Effect.succeed(output(JSON.stringify([{ iid: 5, title: "Ship it", state: "opened" }]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const page = yield* cli.searchProjectReferences({ cwd: "/w", repository: "acme/web" });
      expect(page.items.map((item) => item.reference)).toEqual(["!5"]);
    }),
  );

  describe("the head pipeline's stages", () => {
    const pipeline = {
      id: 9,
      project_id: 12,
      status: "failed",
      web_url: "https://gitlab.com/acme/web/-/pipelines/9",
      source: "merge_request_event",
    };
    const stages = JSON.stringify({
      data: {
        project: {
          mergeRequest: {
            headPipeline: {
              path: "/acme/web/-/pipelines/9",
              stages: {
                nodes: [
                  { name: "build", status: "success", detailedStatus: { label: "passed" } },
                  {
                    name: "test",
                    status: "failed",
                    jobs: {
                      nodes: [{ name: "unit", status: "FAILED", webPath: "/acme/web/-/jobs/3" }],
                    },
                  },
                  {
                    name: "deploy",
                    status: "success",
                    jobs: {
                      nodes: [
                        // A trigger job without `strategy: depend` succeeds whatever its child does.
                        {
                          name: "child-pipeline",
                          status: "SUCCESS",
                          webPath: null,
                          downstreamPipeline: {
                            status: "FAILED",
                            path: "/acme/child/-/pipelines/10",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });

    function answer(graphql: Effect.Effect<ReturnType<typeof output>, GitLabCli.GitLabCliError>) {
      mockedExecute.mockImplementation((request) =>
        request.args[1] === "graphql"
          ? request.stdin?.includes("adminMergeRequest")
            ? Effect.succeed(labelPermission)
            : graphql
          : request.args[1]?.includes("/bridges")
            ? Effect.succeed(
                output(
                  JSON.stringify([
                    {
                      name: "child-pipeline",
                      status: "success",
                      downstream_pipeline: {
                        status: "failed",
                        web_url: "https://gitlab.com/acme/child/-/pipelines/10",
                      },
                    },
                  ]),
                ),
              )
            : Effect.succeed(output(mergeRequestJson({ head_pipeline: pipeline }))),
      );
    }

    const read = (downstreamChecks: boolean) =>
      GitLabPullRequestCli.GitLabPullRequestCli.pipe(
        Effect.flatMap((cli) =>
          cli.getMergeRequestDetail({
            cwd: "/w",
            repository: "group/acme/web",
            number: 7,
            downstreamChecks,
          }),
        ),
      );

    it.effect("shows the stage jobs, and a stage GitLab listed no jobs for", () =>
      Effect.gen(function* () {
        answer(Effect.succeed(output(stages)));

        const detail = yield* read(true);

        const graphql = mockedExecute.mock.calls.find(([call]) => call.stdin?.includes("stages"));
        assert.isDefined(graphql);
        expect(JSON.parse(graphql[0].stdin ?? "").variables).toEqual({
          fullPath: "group/acme/web",
          iid: "7",
        });
        expect(detail.checks).toEqual([
          {
            name: "build",
            status: "success",
            description: "passed",
            url: "https://gitlab.com/acme/web/-/pipelines/9",
          },
          {
            name: "test / unit",
            status: "failure",
            description: null,
            url: "https://gitlab.com/acme/web/-/jobs/3",
          },
          {
            name: "deploy / child-pipeline",
            status: "failure",
            description: "Downstream pipeline",
            url: "https://gitlab.com/acme/child/-/pipelines/10",
          },
        ]);
      }),
    );

    it.effect("keeps the pipeline check where the stages cannot be read", () =>
      Effect.gen(function* () {
        answer(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("graphql unavailable"),
            }),
          ),
        );

        const detail = yield* read(true);

        expect(detail.checks).toEqual([
          {
            name: "Pipeline",
            status: "failure",
            description: "merge_request_event",
            url: "https://gitlab.com/acme/web/-/pipelines/9",
          },
          {
            name: "child-pipeline",
            status: "failure",
            description: "Downstream pipeline",
            url: "https://gitlab.com/acme/child/-/pipelines/10",
          },
        ]);
      }),
    );

    it.effect("asks for no stages when the caller only needs the merge request", () =>
      Effect.gen(function* () {
        answer(Effect.succeed(output(stages)));

        const detail = yield* read(false);

        expect(
          mockedExecute.mock.calls.filter(([call]) => call.stdin?.includes("stages")),
        ).toHaveLength(0);
        expect(detail.checks.map((check) => check.name)).toEqual(["Pipeline"]);
      }),
    );
  });
});

it("asks for a numeric reference's iid besides the recent issues and merge requests", () => {
  const recent = [
    ["order_by", "updated_at"],
    ["sort", "desc"],
  ];
  expect(GitLabPullRequestCli.referenceSearches("12")).toEqual([
    { kind: "issue", params: [["iids[]", "12"]] },
    { kind: "change-request", params: [["iids[]", "12"]] },
    { kind: "issue", params: recent },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("crash")).toEqual([
    { kind: "issue", params: [...recent, ["search", "crash"], ["in", "title"]] },
    { kind: "change-request", params: [...recent, ["search", "crash"], ["in", "title"]] },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("cr")).toEqual([
    { kind: "issue", params: recent },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("12", "!")).toEqual([
    { kind: "change-request", params: [["iids[]", "12"]] },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches(undefined, "#")).toEqual([
    { kind: "issue", params: recent },
  ]);
});
