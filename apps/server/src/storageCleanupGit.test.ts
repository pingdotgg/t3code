import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { resolveBaseRef } from "./storageCleanupGit.ts";

for (const scenario of ["primary", "fallback", "ambiguous", "target", "missing-target"] as const) {
  it.effect(`resolves cleanup base (${scenario})`, () =>
    Effect.gen(function* () {
      const result = yield* resolveBaseRef(
        "/repo",
        scenario.includes("target")
          ? { url: "https://github.com/upstream/repo/pull/42", baseBranch: "release" }
          : undefined,
      );
      assert.deepStrictEqual(
        result,
        scenario === "primary"
          ? { remote: "origin", branch: "main" }
          : scenario === "fallback"
            ? { remote: "upstream", branch: "main" }
            : scenario === "target"
              ? { remote: "upstream", branch: "release" }
              : null,
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolvePrimaryRemoteName: () => Effect.succeed("origin"),
          resolveDefaultBranchName: (_cwd, remote) =>
            Effect.succeed(scenario === "primary" || remote !== "origin" ? "main" : null),
          execute: ({ args }) =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
              stderr: "",
              stdout:
                args.length === 1
                  ? scenario === "ambiguous"
                    ? "origin\nupstream\nother\n"
                    : "origin\nupstream\n"
                  : args.at(-1) === "upstream" && scenario !== "missing-target"
                    ? "git@github.com:upstream/repo.git\n"
                    : "https://github.com/fork/repo.git\n",
            }),
        }),
      ),
    ),
  );
}
