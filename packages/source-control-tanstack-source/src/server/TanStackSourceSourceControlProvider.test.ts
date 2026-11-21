import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as TanStackSourceSourceControlProvider from "./TanStackSourceSourceControlProvider.ts";

const REMOTE = "https://source.tanstack.com/@acme/web.git";
const OWNER_KEY = "branch.pr-42.t3TanstackSourcePull";

/** Pull request #42 of acme/web, opened from a fork, so it checks out as `pr-42`. */
const PULL = {
  number: 42,
  title: "Fix the thing",
  state: "open",
  draft: false,
  author: "bob",
  head: "fix-thing",
  createdAt: 1_000,
  body: null,
  base: "main",
  headRepo: "bob/web",
  headSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  mergeCommitSha: null,
  mergedAt: null,
  mergedBy: null,
  mergeable: null,
  changedFiles: null,
};

function checkout(options: {
  readonly recordedOwner: string | null;
  readonly isAncestor: boolean;
}) {
  const git: Array<string> = [];
  const config = new Map<string, string>(
    options.recordedOwner === null ? [] : [[OWNER_KEY, options.recordedOwner]],
  );
  const api = TanStackSourceApi.TanStackSourceApi.of({
    request: (input) =>
      input.path === "/repos/acme/web/pulls/42"
        ? Effect.succeed(JSON.stringify(PULL))
        : Effect.die(`unexpected ${input.path}`),
    response: () => Effect.die("unexpected response read"),
  });
  const host = TestSourceControlHost.layer({
    git: {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      ensureRemote: () => Effect.succeed("origin"),
      readConfigValue: (_cwd, key) =>
        Effect.succeed(key === "remote.origin.url" ? REMOTE : (config.get(key) ?? null)),
      writeConfigValue: (input) => Effect.sync(() => void config.set(input.key, input.value)),
      listLocalBranchNames: () => Effect.succeed(["main", "pr-42"]),
      createBranch: (input) => Effect.sync(() => void git.push(`create ${input.branch}`)),
      switchRef: (input) =>
        Effect.sync(() => {
          git.push(`switch ${input.refName}`);
          return { refName: input.refName };
        }),
      execute: (input) =>
        input.args[0] === "merge-base" && !options.isAncestor
          ? Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git",
                cwd: input.cwd,
                argumentCount: input.args.length,
                exitCode: 1,
                detail: "not an ancestor",
              }),
            )
          : Effect.sync(() => {
              git.push(input.args.join(" "));
              return {
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } as never;
            }),
    },
  });
  const run = TanStackSourceSourceControlProvider.make.pipe(
    Effect.flatMap((provider) => provider.checkoutChangeRequest({ cwd: "/repo", reference: "42" })),
    Effect.provideService(TanStackSourceApi.TanStackSourceApi, api),
    Effect.provide(Layer.merge(host, FileSystem.layerNoop({}))),
  );
  return { run, git, config };
}

describe("TanStackSourceSourceControlProvider.checkoutChangeRequest", () => {
  it.effect(
    "refuses a pr-<n> branch T3 did not make for this pull request, and leaves it alone",
    () => {
      // An unrelated branch at the pull request's base is an ancestor of its head.
      const { run, git, config } = checkout({ recordedOwner: null, isAncestor: true });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(run);
        assert.include(error.detail, "pr-42 was not made for pull request #42");
        assert.isFalse(
          git.some((command) => command.startsWith("checkout") || command.startsWith("switch")),
        );
        assert.isFalse(config.has(OWNER_KEY));
      });
    },
  );

  it.effect("moves the branch it made for the pull request up to the new head", () => {
    const { run, git } = checkout({ recordedOwner: "acme/web#42", isAncestor: true });
    return Effect.gen(function* () {
      yield* run;
      assert.deepStrictEqual(
        git.filter((command) => /^(checkout|switch|create) /u.test(command)),
        ["checkout --no-track -B pr-42 refs/remotes/origin/pull/42 --", "switch pr-42"],
      );
    });
  });

  it.effect("keeps local commits on its own branch rather than moving it", () => {
    const { run, git } = checkout({ recordedOwner: "acme/web#42", isAncestor: false });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run);
      assert.include(error.detail, "has commits pull request #42 does not");
      assert.isFalse(git.some((command) => command.startsWith("checkout")));
    });
  });
});
