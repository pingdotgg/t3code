import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { GitCommandError } from "../Errors.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitService } from "../Services/GitService.ts";

const layer = it.layer(Layer.provideMerge(GitServiceLive, NodeServices.layer));

layer("GitServiceLive", (it) => {
  it.effect("runGit executes successful git commands", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.version",
        cwd: process.cwd(),
        args: ["--version"],
      });

      assert.equal(result.code, 0);
      assert.ok(result.stdout.toLowerCase().includes("git version"));
    }),
  );

  it.effect("runGit can return non-zero exit codes when allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({
        operation: "GitProcess.test.allowNonZero",
        cwd: process.cwd(),
        args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        allowNonZeroExit: true,
      });

      assert.notEqual(result.code, 0);
    }),
  );

  it.effect("runGit fails with GitCommandError when non-zero exits are not allowed", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* Effect.result(
        gitService.execute({
          operation: "GitProcess.test.failOnNonZero",
          cwd: process.cwd(),
          args: ["rev-parse", "--verify", "__definitely_missing_ref__"],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(GitCommandError)(result.failure));
        assert.equal(result.failure.operation, "GitProcess.test.failOnNonZero");
        assert.equal(result.failure.command, "git rev-parse --verify __definitely_missing_ref__");
      }
    }),
  );
});
