import {
  EventId,
  ManagedAgentRunError,
  ProviderDriverKind,
  RuntimeTaskId,
  type ManagedAgentCancelInput,
  type ManagedCodexExecLaunchInput,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

interface ManagedRun {
  readonly threadId: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly cancellationLock: Semaphore.Semaphore;
  cancelled: boolean;
}

export interface ManagedCodexExecShape {
  readonly launch: (
    input: ManagedCodexExecLaunchInput,
  ) => Effect.Effect<{ readonly agentId: string }, ManagedAgentRunError>;
  readonly cancel: (
    input: ManagedAgentCancelInput,
  ) => Effect.Effect<{ readonly cancelled: boolean }, ManagedAgentRunError>;
}

export class ManagedCodexExec extends Context.Service<ManagedCodexExec, ManagedCodexExecShape>()(
  "t3/orchestration/ManagedCodexExec",
) {}

function outputSummary(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown))(trimmed);
  if (Exit.isSuccess(decoded) && typeof decoded.value === "object" && decoded.value !== null) {
    const value = decoded.value as Record<string, unknown>;
    const item =
      typeof value.item === "object" && value.item !== null
        ? (value.item as Record<string, unknown>)
        : undefined;
    return (
      (typeof item?.command === "string" ? item.command : undefined) ??
      (typeof item?.text === "string" ? item.text : undefined) ??
      (typeof value.message === "string" ? value.message : undefined) ??
      (typeof value.type === "string" ? value.type.replaceAll(".", " ") : undefined)
    );
  }
  return trimmed;
}

export const layer = Layer.effect(
  ManagedCodexExec,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const scope = yield* Scope.Scope;
    const snapshots = yield* ProjectionSnapshotQuery;
    const ingestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
    const runs = new Map<string, ManagedRun>();
    const provider = ProviderDriverKind.make("codex");

    const emit = (
      threadId: ManagedCodexExecLaunchInput["threadId"],
      type: "task.started" | "task.progress" | "task.completed",
      payload: ProviderRuntimeEvent["payload"],
    ) =>
      Effect.gen(function* () {
        const eventId = EventId.make(yield* crypto.randomUUIDv4);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const ingestionService = Option.getOrUndefined(ingestion);
        if (!ingestionService?.ingestRuntimeEvent) {
          return yield* new ManagedAgentRunError({
            reason: "spawn-failed",
            message: "Managed agent runtime ingestion is unavailable.",
          });
        }
        yield* ingestionService.ingestRuntimeEvent({
          eventId,
          provider,
          threadId,
          createdAt,
          type,
          payload,
        } as ProviderRuntimeEvent);
      });

    const launch: ManagedCodexExecShape["launch"] = Effect.fn("ManagedCodexExec.launch")(
      function* (input) {
        const threadOption = yield* snapshots.getThreadDetailById(input.threadId).pipe(
          Effect.mapError(
            () =>
              new ManagedAgentRunError({
                reason: "thread-not-found",
                message: `Thread ${input.threadId} could not be loaded.`,
              }),
          ),
        );
        const thread = Option.getOrUndefined(threadOption);
        if (!thread) {
          return yield* new ManagedAgentRunError({
            reason: "thread-not-found",
            message: `Thread ${input.threadId} does not exist.`,
          });
        }
        const projectOption = yield* snapshots.getProjectShellById(thread.projectId).pipe(
          Effect.mapError(
            () =>
              new ManagedAgentRunError({
                reason: "thread-not-found",
                message: `Project for thread ${input.threadId} could not be loaded.`,
              }),
          ),
        );
        const project = Option.getOrUndefined(projectOption);
        if (!project) {
          return yield* new ManagedAgentRunError({
            reason: "thread-not-found",
            message: `Project for thread ${input.threadId} does not exist.`,
          });
        }

        const runUuid = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            () =>
              new ManagedAgentRunError({
                reason: "spawn-failed",
                message: "Could not allocate a managed agent id.",
              }),
          ),
        );
        const agentId = RuntimeTaskId.make(`managed-codex-exec:${runUuid}`);
        const args = [
          "exec",
          "--json",
          "--color",
          "never",
          "-C",
          thread.worktreePath ?? project.workspaceRoot,
        ];
        if (input.model) args.push("--model", input.model);
        if (input.effort) args.push("-c", `model_reasoning_effort=${input.effort}`);
        if (input.sandbox) args.push("--sandbox", input.sandbox);
        args.push(input.prompt);

        const child = yield* spawner
          .spawn(
            ChildProcess.make("codex", args, {
              cwd: thread.worktreePath ?? project.workspaceRoot,
              shell: false,
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ManagedAgentRunError({
                  reason: "spawn-failed",
                  message: `Could not launch managed Codex exec: ${Cause.pretty(Cause.fail(cause))}`,
                }),
            ),
          );

        const cancellationLock = yield* Semaphore.make(1);
        const run: ManagedRun = {
          threadId: input.threadId,
          child,
          cancellationLock,
          cancelled: false,
        };
        runs.set(agentId, run);
        const linkage = {
          taskId: agentId,
          taskType: "managed_codex_exec",
          title: input.title,
          role: "codex-exec",
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
          agentSource: "managed_codex_exec" as const,
          cancellationOwner: "t3" as const,
          timelineBypass: true,
        };
        yield* emit(input.threadId, "task.started", {
          ...linkage,
          description: input.title,
        }).pipe(
          Effect.catch(() =>
            child.kill().pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  runs.delete(agentId);
                }),
              ),
              Effect.andThen(
                new ManagedAgentRunError({
                  reason: "spawn-failed",
                  message: "Managed Codex exec started but its lifecycle could not be recorded.",
                }),
              ),
            ),
          ),
        );

        const reportLines = (stream: Stream.Stream<Uint8Array, unknown>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect((line) => {
              const summary = outputSummary(line);
              return summary
                ? emit(input.threadId, "task.progress", {
                    ...linkage,
                    description: input.title,
                    summary,
                  })
                : Effect.void;
            }),
            Stream.runDrain,
            Effect.ignore,
          );

        yield* Effect.forkIn(
          Effect.gen(function* () {
            yield* Effect.all([reportLines(child.stdout), reportLines(child.stderr)], {
              concurrency: "unbounded",
            });
            const exitResult = yield* Effect.result(child.exitCode);
            const cancelled = yield* run.cancellationLock.withPermit(
              Effect.sync(() => {
                runs.delete(agentId);
                return run.cancelled;
              }),
            );
            yield* emit(input.threadId, "task.completed", {
              ...linkage,
              status: cancelled
                ? "stopped"
                : Result.isSuccess(exitResult) && Number(exitResult.success) === 0
                  ? "completed"
                  : "failed",
              summary: cancelled
                ? "Cancelled by T3"
                : Result.isFailure(exitResult)
                  ? "Managed Codex exec failed before reporting an exit code"
                  : Number(exitResult.success) === 0
                    ? "Managed Codex exec completed"
                    : `Managed Codex exec exited with code ${Number(exitResult.success)}`,
            });
          }),
          scope,
        );
        return { agentId };
      },
    );

    const cancel: ManagedCodexExecShape["cancel"] = Effect.fn("ManagedCodexExec.cancel")(
      function* (input) {
        const run = runs.get(input.agentId);
        if (!run) {
          return yield* new ManagedAgentRunError({
            reason: "run-not-found",
            message: `Managed agent ${input.agentId} is not running.`,
          });
        }
        if (run.threadId !== input.threadId) {
          return yield* new ManagedAgentRunError({
            reason: "not-owned",
            message: `Managed agent ${input.agentId} does not belong to thread ${input.threadId}.`,
          });
        }
        yield* run.cancellationLock.withPermit(
          Effect.gen(function* () {
            if (runs.get(input.agentId) !== run) {
              return yield* new ManagedAgentRunError({
                reason: "run-not-found",
                message: `Managed agent ${input.agentId} is not running.`,
              });
            }
            yield* run.child.kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" }).pipe(
              Effect.mapError(
                () =>
                  new ManagedAgentRunError({
                    reason: "not-owned",
                    message: `Managed agent ${input.agentId} could not be cancelled.`,
                  }),
              ),
            );
            run.cancelled = true;
          }),
        );
        return { cancelled: true };
      },
    );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(runs.values(), (run) => run.child.kill().pipe(Effect.ignore), {
        discard: true,
        concurrency: "unbounded",
      }),
    );
    return { launch, cancel };
  }),
);
