import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { runGitHubStackAction as runStackAction } from "./githubStackActions.ts";

const runGitHubStackAction = (
  execute: GitHubCli.GitHubCli["Service"]["execute"],
  input: Parameters<typeof runStackAction>[0],
) => runStackAction(input).pipe(Effect.provide(Layer.mock(GitHubCli.GitHubCli)({ execute })));

const stack = [
  {
    number: 50,
    url: "https://api.github.com/repos/acme/web/stacks/50",
    base: { ref: "main" },
    pull_requests: [
      {
        number: 1,
        title: "Base",
        head: { ref: "base", sha: "aaa" },
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
      },
      {
        number: 2,
        title: "Middle",
        head: { ref: "middle", sha: "bbb" },
        state: "open",
        draft: false,
      },
      { number: 3, title: "Top", head: { ref: "top", sha: "ccc" }, state: "open", draft: false },
    ],
  },
];
const input = {
  cwd: "/repo",
  repository: "acme/web",
  host: "github.com",
  number: 3,
  stackNumber: 50,
  expectedStackHeads: [
    { number: 2, headSha: "bbb" },
    { number: 3, headSha: "ccc" },
  ],
  action: "merge" as const,
};
const access = {
  data: {
    repository: {
      pr2: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false },
      pr3: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false },
    },
  },
};

const branch = (number: number, headRefOid: string, behindBy = 1) => ({
  data: {
    repository: {
      pullRequest: { id: `PR_${number}`, headRefOid, baseRef: { compare: { behindBy } } },
    },
  },
});
const rebased = {
  data: { updatePullRequestBranch: { pullRequest: { headRefOid: "rebased-sha" } } },
};
const rebaseResponses = [branch(2, "bbb"), rebased, branch(3, "ccc"), rebased];

function fake(responses: readonly unknown[]) {
  const calls: ReadonlyArray<string>[] = [];
  const execute: GitHubCli.GitHubCli["Service"]["execute"] = (request) =>
    Effect.sync(() => {
      calls.push(request.args);
      const value = responses[calls.length - 1];
      if (value === undefined) throw new Error("Unexpected GitHub request");
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        stdout: JSON.stringify(value),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
      };
    });
  return { execute, calls };
}

it.effect("submits one atomic merge with the reviewed head and respects the merge queue", () =>
  Effect.gen(function* () {
    const api = fake([stack, { status: "enqueued", details: {} }]);
    yield* runGitHubStackAction(api.execute, { ...input, mergeMethod: "squash" });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toContain("repos/acme/web/pulls/3/merge-async");
    expect(api.calls[1]).toContain("sha=ccc");
    expect(api.calls[1]).toContain("merge_action=default");
    expect(api.calls[1]).toContain("merge_method=squash");
  }),
);

it.effect("polls an accepted merge and reports a later rule rejection", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      { status: "pending", details: { uuid: "operation" } },
      { status: "failed", details: { message: "Required checks have not passed" } },
    ]);
    const fiber = yield* runGitHubStackAction(api.execute, input).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackMergeRejectedError" },
    });
    expect(api.calls[2]).toContain("repos/acme/web/pulls/3/merge-async/operation");
  }),
);

it.effect("retains stack identity and a rejection response without a message", () =>
  Effect.gen(function* () {
    const rejection = { status: "failed", details: {} };
    const api = fake([stack, rejection]);
    const result = yield* runGitHubStackAction(api.execute, input).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "GitHubStackMergeRejectedError",
        repository: input.repository,
        number: input.number,
        stackNumber: input.stackNumber,
        cause: rejection,
      },
    });
  }),
);

it.effect("refuses a changed stack before performing any mutation", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      expectedStackHeads: [
        { number: 2, headSha: "old" },
        { number: 3, headSha: "ccc" },
      ],
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GitHubStackChangedError" } });
    expect(api.calls).toHaveLength(1);
  }),
);

it.effect("rebases unmerged layers bottom to top without local git commands", () =>
  Effect.gen(function* () {
    const api = fake([stack, access, ...rebaseResponses]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    const mutations = api.calls.filter((args) =>
      args.some((arg) => arg.startsWith("query=mutation")),
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toContain("id=PR_2");
    expect(mutations[0]).toContain("sha=bbb");
    expect(mutations[1]).toContain("id=PR_3");
    expect(mutations[1]).toContain("sha=ccc");
    expect(api.calls.every((args) => args[0] === "api")).toBe(true);
  }),
);

it.effect("does not update later layers after a rebase failure", () =>
  Effect.gen(function* () {
    const api = fake([stack, access, branch(2, "bbb")]);
    const execute: typeof api.execute = (request) =>
      !request.args.some((arg) => arg.startsWith("query=mutation"))
        ? api.execute(request)
        : Effect.fail(
            new GitHubCli.GitHubCliAuthenticationError({
              command: "gh",
              cwd: "/repo",
              cause: new Error("denied"),
            }),
          );
    const result = yield* runGitHubStackAction(execute, { ...input, action: "update-branch" }).pipe(
      Effect.result,
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackRebaseFailedError", number: 2, completed: 0 },
    });
  }),
);

it.effect("refuses the entire rebase before mutation when a later fork denies write access", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      {
        data: {
          repository: {
            ...access.data.repository,
            pr3: { headRepository: { viewerPermission: "READ" }, maintainerCanModify: false },
          },
        },
      },
    ]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      action: "update-branch",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackPermissionError" },
    });
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((args) => args[0] === "api")).toBe(true);
  }),
);

it.effect("allows a fork that explicitly permits maintainer updates", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      {
        data: {
          repository: {
            ...access.data.repository,
            pr3: { headRepository: { viewerPermission: "READ" }, maintainerCanModify: true },
          },
        },
      },
      ...rebaseResponses,
    ]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(api.calls.at(-1)).toContain("id=PR_3");
  }),
);

it.effect("bounds polling and reports a still-running merge without claiming success", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      ...Array.from({ length: 40 }, () => ({ status: "pending", details: { uuid: "operation" } })),
    ]);
    const fiber = yield* runGitHubStackAction(api.execute, input).pipe(
      Effect.result,
      Effect.forkChild,
    );
    yield* TestClock.adjust("6 minutes");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackMergePendingError" },
    });
    expect(api.calls.length).toBeLessThan(40);
  }),
);

it.effect("rejects a push after preflight without rebasing the new revision", () =>
  Effect.gen(function* () {
    const api = fake([stack, access, branch(2, "new-head")]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      action: "update-branch",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackChangedError", number: 2, completed: 0 },
    });
    expect(api.calls).toHaveLength(3);
  }),
);

it.effect("skips current layers without submitting a rebase mutation", () =>
  Effect.gen(function* () {
    const api = fake([stack, access, branch(2, "bbb", 0), branch(3, "ccc", 0)]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(api.calls.some((args) => args.some((arg) => arg.startsWith("query=mutation")))).toBe(
      false,
    );
  }),
);

it.effect("keeps earlier progress and stops after a later layer fails", () =>
  Effect.gen(function* () {
    const api = fake([
      stack,
      access,
      branch(2, "bbb"),
      rebased,
      branch(3, "ccc"),
      { data: { updatePullRequestBranch: null } },
    ]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      action: "update-branch",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackRebaseFailedError", number: 3, completed: 1 },
    });
  }),
);

it.effect("reports partial progress when a later head changes during the rebase", () =>
  Effect.gen(function* () {
    const api = fake([stack, access, branch(2, "bbb"), rebased, branch(3, "concurrent-head")]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      action: "update-branch",
    }).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "GitHubStackChangedError", number: 3, completed: 1 },
    });
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("Earlier updates remain on GitHub");
    }
    expect(
      api.calls.filter((args) => args.some((arg) => arg.startsWith("query=mutation"))),
    ).toHaveLength(1);
  }),
);
