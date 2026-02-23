import { NodeServices } from "@effect/platform-node";
import { it, assert } from "@effect/vitest";
import { Effect } from "effect";

import { GitCommandError } from "./Errors.ts";
import { runGit } from "./Process.ts";

it.effect("runGit executes successful git commands", () =>
  Effect.gen(function* () {
    const result = yield* runGit({
      operation: "GitProcess.test.version",
      cwd: process.cwd(),
      args: ["--version"],
    });

    assert.equal(result.code, 0);
    assert.ok(result.stdout.toLowerCase().includes("git version"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runGit can return non-zero exit codes when allowed", () =>
  Effect.gen(function* () {
    const result = yield* runGit({
      operation: "GitProcess.test.allowNonZero",
      cwd: process.cwd(),
      args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
      allowNonZeroExit: true,
    });

    assert.notEqual(result.code, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runGit fails with GitCommandError when non-zero exits are not allowed", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      runGit({
        operation: "GitProcess.test.failOnNonZero",
        cwd: process.cwd(),
        args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
      }),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof GitCommandError);
      assert.equal(result.failure.operation, "GitProcess.test.failOnNonZero");
      assert.equal(result.failure.command, "git rev-parse --verify __definitely_missing_ref__");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
