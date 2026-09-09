import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { runGitHubStackAction } from "./githubStackActions.ts";

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
  expectedHeadSha: "ccc",
  action: "merge" as const,
};
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
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "rejected" } });
    expect(api.calls[2]).toContain("repos/acme/web/pulls/3/merge-async/operation");
  }),
);

it.effect("refuses a changed stack before performing any mutation", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const result = yield* runGitHubStackAction(api.execute, {
      ...input,
      expectedHeadSha: "old",
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "changed" } });
    expect(api.calls).toHaveLength(1);
  }),
);

it.effect("rebases unmerged layers bottom to top without local git commands", () =>
  Effect.gen(function* () {
    const api = fake([stack, {}, {}]);
    yield* runGitHubStackAction(api.execute, { ...input, action: "update-branch" });
    expect(api.calls.slice(1)).toEqual([
      ["pr", "update-branch", "2", "--repo", "github.com/acme/web", "--rebase"],
      ["pr", "update-branch", "3", "--repo", "github.com/acme/web", "--rebase"],
    ]);
  }),
);

it.effect("does not update later layers after a rebase failure", () =>
  Effect.gen(function* () {
    const api = fake([stack]);
    const execute: typeof api.execute = (request) =>
      request.args[0] === "api"
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
      failure: { reason: "rebase-failed", number: 2, completed: 0 },
    });
  }),
);
