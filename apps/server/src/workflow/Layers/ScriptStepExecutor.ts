import { ThreadId, type StepOutcome, type WorkflowEventId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { ScriptCommandRunner } from "../Services/ScriptCommandRunner.ts";
import {
  ScriptStepExecutor,
  type ScriptStepExecutorShape,
} from "../Services/ScriptStepExecutor.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { type WorkflowEventInput } from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import type { WorktreeHandle } from "../Services/WorktreePort.ts";

const DEFAULT_SCRIPT_TIMEOUT = Duration.minutes(10);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const toScriptExecutorError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const isContainedPath = (
  path: Path.Path,
  input: {
    readonly root: string;
    readonly candidate: string;
  },
) => {
  const relative = path.relative(input.root, input.candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const mapCommandResult = (
  result: {
    readonly outcome: "exited" | "timeout" | "cancelled";
    readonly exitCode: number | null;
  },
  allowFailure: boolean,
): StepOutcome => {
  if (result.outcome === "timeout") {
    return { _tag: "failed", error: "script timed out" };
  }
  if (result.outcome === "cancelled") {
    // User-initiated cancellation: never auto-retried.
    return { _tag: "failed", error: "script cancelled", retryable: false };
  }
  if (result.exitCode === 0 || allowFailure) {
    return { _tag: "completed" };
  }
  return { _tag: "failed", error: `script exited with code ${result.exitCode ?? 1}` };
};

const make = Effect.gen(function* () {
  const cancels = yield* ScriptCancelRegistry;
  const commands = yield* ScriptCommandRunner;
  const committer = yield* WorkflowEventCommitter;
  const fileSystem = yield* FileSystem.FileSystem;
  const ids = yield* WorkflowIds;
  const path = yield* Path.Path;

  const commit = (
    event: Omit<WorkflowEventInput, "eventId" | "occurredAt">,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const eventId = yield* ids.eventId();
      yield* committer.commit({
        ...event,
        eventId: eventId as WorkflowEventId,
        occurredAt: (yield* nowIso) as never,
      } as WorkflowEventInput);
    });

  const resolveContainedCwd = (worktree: WorktreeHandle, cwd: string | undefined) =>
    Effect.gen(function* () {
      const requested = cwd ?? ".";
      const absolute = path.resolve(worktree.path, requested);
      const worktreeRoot = yield* fileSystem
        .realPath(worktree.path)
        .pipe(Effect.mapError(toScriptExecutorError("script worktree realpath failed")));
      const resolved = yield* fileSystem
        .realPath(absolute)
        .pipe(Effect.mapError(toScriptExecutorError("script cwd realpath failed")));
      if (!isContainedPath(path, { root: worktreeRoot, candidate: resolved })) {
        return { _tag: "failed", error: "script cwd escapes worktree" } as const;
      }
      return { _tag: "success", cwd: resolved } as const;
    }).pipe(Effect.orElseSucceed(() => ({ _tag: "failed", error: "script cwd invalid" }) as const));

  const execute: ScriptStepExecutorShape["execute"] = (input) =>
    Effect.gen(function* () {
      const cwd = yield* resolveContainedCwd(input.worktree, input.step.cwd);
      if (cwd._tag === "failed") {
        return { _tag: "failed", error: cwd.error } satisfies StepOutcome;
      }

      const scriptRunId = yield* ids.scriptRunId();
      const scriptThreadId = ThreadId.make(`workflow-script:${scriptRunId}`);
      const terminalId = `script-${scriptRunId}`;

      yield* cancels.register(input.ctx.stepRunId, { scriptThreadId, terminalId });

      const result = yield* Effect.gen(function* () {
        yield* commit({
          type: "ScriptStepStarted",
          ticketId: input.ctx.ticketId,
          payload: {
            scriptRunId,
            stepRunId: input.ctx.stepRunId,
            scriptThreadId,
            terminalId,
          },
        });

        const commandResult = yield* commands.run({
          scriptThreadId,
          terminalId,
          cwd: cwd.cwd,
          run: input.step.run,
          timeout: input.step.timeout ?? DEFAULT_SCRIPT_TIMEOUT,
        });

        yield* commit({
          type: "ScriptStepExited",
          ticketId: input.ctx.ticketId,
          payload: {
            scriptRunId,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            outcome: commandResult.outcome,
          },
        });

        return commandResult;
      }).pipe(Effect.ensuring(cancels.unregister(input.ctx.stepRunId)));

      return mapCommandResult(result, input.step.allowFailure ?? false);
    });

  return { execute } satisfies ScriptStepExecutorShape;
});

export const ScriptStepExecutorLive = Layer.effect(ScriptStepExecutor, make);
