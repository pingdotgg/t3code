import { assert, it } from "@effect/vitest";
import {
  EnvironmentConflictError,
  EnvironmentInternalError,
  GitCommandError,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";

import { failEnvironmentDispatch } from "./http.ts";

it.effect("maps a nested worktree conflict to an actionable typed HTTP conflict", () =>
  Effect.gen(function* () {
    const error = yield* failEnvironmentDispatch(
      new OrchestrationDispatchCommandError({
        message: "bootstrap failed",
        cause: new GitCommandError({
          operation: "GitVcsDriver.createWorktree",
          command: "git",
          cwd: "/private/repo",
          argumentCount: 6,
          exitCode: 255,
          stderrLength: 161,
          detail: "git worktree add failed",
          failureKind: "worktree_branch_exists",
          safeDiagnostic: "A local branch with the requested name already exists.",
        }),
      }),
    ).pipe(Effect.flip);

    assert.instanceOf(error, EnvironmentConflictError);
    assert.equal(error.code, "conflict");
    assert.equal(error.reason, "worktree_branch_exists");
    assert.include(error.message, "branch");
    assert.include(error.message, "different branch");
    assert.isAbove(error.traceId.length, 0);
    assert.notInclude(JSON.stringify(error), "/private/repo");
    const response = yield* HttpServerRespondable.toResponse(error);
    assert.equal(response.status, 409);
  }),
);

it.effect("keeps an unknown Git failure internal while returning its trace id", () =>
  Effect.gen(function* () {
    const gitError = new GitCommandError({
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/private/repo",
      exitCode: 128,
      stderrLength: 2_000,
      detail: "git worktree add failed",
      failureKind: "unknown",
      safeDiagnostic: "fatal: [redacted-url] failed",
    });
    const error = yield* failEnvironmentDispatch(
      new OrchestrationDispatchCommandError({
        message: "bootstrap failed",
        cause: gitError,
      }),
    ).pipe(Effect.flip);

    assert.instanceOf(error, EnvironmentInternalError);
    assert.equal(error.code, "internal_error");
    assert.equal(error.reason, "orchestration_dispatch_failed");
    assert.isAbove(error.traceId.length, 0);
    assert.equal(gitError.failureKind, "unknown");
    assert.equal(gitError.safeDiagnostic, "fatal: [redacted-url] failed");
    assert.notInclude(JSON.stringify(error), gitError.safeDiagnostic ?? "");
    const response = yield* HttpServerRespondable.toResponse(error);
    assert.equal(response.status, 500);
  }),
);
