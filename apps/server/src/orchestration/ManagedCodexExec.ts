import {
  EventId,
  ManagedAgentRunError,
  ProviderDriverKind,
  RuntimeTaskId,
  type ManagedAgentCancelInput,
  type ManagedCodexExecLaunchInput,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
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

export class ManagedCodexExec extends Context.Service<
  ManagedCodexExec,
  {
    readonly launch: (
      input: ManagedCodexExecLaunchInput,
    ) => Effect.Effect<{ readonly agentId: string }, ManagedAgentRunError>;
    readonly cancel: (
      input: ManagedAgentCancelInput,
    ) => Effect.Effect<{ readonly cancelled: boolean }, ManagedAgentRunError>;
  }
>()("t3/orchestration/ManagedCodexExec") {}

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

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const snapshots = yield* ProjectionSnapshotQuery;
  const ingestion = yield* ProviderRuntimeIngestionService;
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
      yield* ingestion.ingestRuntimeEvent({
        eventId,
        provider,
        threadId,
        createdAt,
        type,
        payload,
      } as ProviderRuntimeEvent);
    });

  const launch: ManagedCodexExec["Service"]["launch"] = Effect.fn("ManagedCodexExec.launch")(
    function* (input) {
      const threadOption = yield* snapshots.getThreadDetailById(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedAgentRunError({
              reason: "thread-not-found",
              threadId: input.threadId,
              cause,
            }),
        ),
      );
      const thread = Option.getOrUndefined(threadOption);
      if (!thread) {
        return yield* new ManagedAgentRunError({
          reason: "thread-not-found",
          threadId: input.threadId,
        });
      }
      const projectOption = yield* snapshots.getProjectShellById(thread.projectId).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedAgentRunError({
              reason: "thread-not-found",
              threadId: input.threadId,
              cause,
            }),
        ),
      );
      const project = Option.getOrUndefined(projectOption);
      if (!project) {
        return yield* new ManagedAgentRunError({
          reason: "thread-not-found",
          threadId: input.threadId,
        });
      }

      const runUuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ManagedAgentRunError({
              reason: "spawn-failed",
              threadId: input.threadId,
              cause,
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
                threadId: input.threadId,
                cause,
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
        Effect.catch((cause) =>
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
                threadId: input.threadId,
                agentId,
                cause,
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

  const cancel: ManagedCodexExec["Service"]["cancel"] = Effect.fn("ManagedCodexExec.cancel")(
    function* (input) {
      const run = runs.get(input.agentId);
      if (!run) {
        return yield* new ManagedAgentRunError({
          reason: "run-not-found",
          threadId: input.threadId,
          agentId: input.agentId,
        });
      }
      if (run.threadId !== input.threadId) {
        return yield* new ManagedAgentRunError({
          reason: "not-owned",
          threadId: input.threadId,
          agentId: input.agentId,
        });
      }
      yield* run.cancellationLock.withPermit(
        Effect.gen(function* () {
          if (runs.get(input.agentId) !== run) {
            return yield* new ManagedAgentRunError({
              reason: "run-not-found",
              threadId: input.threadId,
              agentId: input.agentId,
            });
          }
          yield* run.child.kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" }).pipe(
            Effect.mapError(
              (cause) =>
                new ManagedAgentRunError({
                  reason: "not-owned",
                  threadId: input.threadId,
                  agentId: input.agentId,
                  cause,
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
});

export const layer = Layer.effect(ManagedCodexExec, make);
