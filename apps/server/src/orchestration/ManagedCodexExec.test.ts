import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ManagedAgentRunError,
  ProjectId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ManagedCodexExec, layer } from "./ManagedCodexExec.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "./Services/ProviderRuntimeIngestion.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";

describe("ManagedCodexExec", () => {
  it("exposes runtime ingestion as a layer composition requirement", () => {
    type Requirements = Layer.Services<typeof layer>;
    const requiresRuntimeIngestion: unknown extends Requirements
      ? false
      : ProviderRuntimeIngestionService extends Requirements
        ? true
        : false = true;

    expect(requiresRuntimeIngestion).toBe(true);
  });

  it.effect("terminalizes signal exits and releases owned process handles", () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
      >();
      const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      let killed = false;
      let spawnedCommand: unknown;
      const signalExitError = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        description: "Process interrupted due to receipt of signal: 'SIGTERM'",
      });
      const failedKillError = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "kill",
        description: "Failed to kill child process",
      });
      const cancelledHandle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1234),
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => !killed),
        kill: () =>
          Effect.gen(function* () {
            killed = true;
            yield* Deferred.fail(exit, signalExitError);
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const unexpectedExitHandle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1235),
        exitCode: Effect.fail(signalExitError),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const failedKillExit = yield* Deferred.make<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
      >();
      const failedKillHandle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1236),
        exitCode: Deferred.await(failedKillExit),
        isRunning: Effect.succeed(true),
        kill: () =>
          Effect.gen(function* () {
            yield* Deferred.fail(failedKillExit, signalExitError);
            return yield* failedKillError;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const handles = [cancelledHandle, unexpectedExitHandle, failedKillHandle];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawnedCommand = command;
          const handle = handles.shift();
          if (!handle) throw new Error("Unexpected managed Codex spawn");
          return handle;
        }),
      );
      const snapshots = {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: ThreadId.make("thread-1"),
              projectId: ProjectId.make("project-1"),
              worktreePath: "D:/repo/worktree",
            }),
          ),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({ id: ProjectId.make("project-1"), workspaceRoot: "D:/repo" }),
          ),
      } as unknown as ProjectionSnapshotQueryShape;
      const ingestion = {
        start: () => Effect.void,
        drain: Effect.void,
        ingestRuntimeEvent: (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "task.completed"
                ? Queue.offer(terminals, event).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      } satisfies ProviderRuntimeIngestionShape;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(ProjectionSnapshotQuery, snapshots),
        Layer.succeed(ProviderRuntimeIngestionService, ingestion),
      );

      const context = yield* Layer.build(layer.pipe(Layer.provide(dependencies)));
      const manager = yield* ManagedCodexExec.pipe(Effect.provide(context));
      const launched = yield* manager.launch({
        threadId: ThreadId.make("thread-1"),
        prompt: "Review the implementation",
        title: "Reviewer",
        model: "gpt-5.6-sol",
        effort: "high",
        sandbox: "workspace-write",
        parentAgentId: "native-parent",
      });
      expect(launched.agentId).toMatch(/^managed-codex-exec:/);
      expect(spawnedCommand).toMatchObject({
        command: "codex",
        args: [
          "exec",
          "--json",
          "--color",
          "never",
          "-C",
          "D:/repo/worktree",
          "--model",
          "gpt-5.6-sol",
          "-c",
          "model_reasoning_effort=high",
          "--sandbox",
          "workspace-write",
          "Review the implementation",
        ],
      });
      expect(events[0]).toMatchObject({
        type: "task.started",
        payload: {
          taskId: launched.agentId,
          parentAgentId: "native-parent",
          model: "gpt-5.6-sol",
          effort: "high",
          cancellationOwner: "t3",
        },
      });

      expect(
        yield* manager.cancel({ threadId: ThreadId.make("thread-1"), agentId: launched.agentId }),
      ).toEqual({ cancelled: true });
      expect(killed).toBe(true);
      expect(yield* Queue.take(terminals)).toMatchObject({
        type: "task.completed",
        payload: { taskId: launched.agentId, status: "stopped" },
      });
      expect(
        yield* Effect.result(
          manager.cancel({ threadId: ThreadId.make("thread-1"), agentId: launched.agentId }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "run-not-found" } });

      const unexpectedExit = yield* manager.launch({
        threadId: ThreadId.make("thread-1"),
        prompt: "Review another implementation",
        title: "Reviewer",
      });
      expect(yield* Queue.take(terminals)).toMatchObject({
        type: "task.completed",
        payload: {
          taskId: unexpectedExit.agentId,
          status: "failed",
          summary: "Managed Codex exec failed before reporting an exit code",
        },
      });
      expect(
        yield* Effect.result(
          manager.cancel({ threadId: ThreadId.make("thread-1"), agentId: unexpectedExit.agentId }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "run-not-found" } });

      const failedCancellation = yield* manager.launch({
        threadId: ThreadId.make("thread-1"),
        prompt: "Review cancellation behavior",
        title: "Reviewer",
      });
      expect(
        yield* Effect.result(
          manager.cancel({
            threadId: ThreadId.make("thread-1"),
            agentId: failedCancellation.agentId,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "not-owned" } });
      expect(yield* Queue.take(terminals)).toMatchObject({
        type: "task.completed",
        payload: {
          taskId: failedCancellation.agentId,
          status: "failed",
          summary: "Managed Codex exec failed before reporting an exit code",
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps prompts out of spawn error messages while preserving the cause", () =>
    Effect.gen(function* () {
      const prompt = "TOP_SECRET_MANAGED_CODEX_PROMPT";
      const spawnCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: `codex exec ${prompt}`,
      });
      const spawner = ChildProcessSpawner.make(() => Effect.fail(spawnCause));
      const snapshots = {
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: ThreadId.make("thread-1"),
              projectId: ProjectId.make("project-1"),
              worktreePath: "D:/repo/worktree",
            }),
          ),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({ id: ProjectId.make("project-1"), workspaceRoot: "D:/repo" }),
          ),
      } as unknown as ProjectionSnapshotQueryShape;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(ProjectionSnapshotQuery, snapshots),
        Layer.succeed(ProviderRuntimeIngestionService, {
          start: () => Effect.void,
          drain: Effect.void,
          ingestRuntimeEvent: () => Effect.void,
        }),
      );

      const context = yield* Layer.build(layer.pipe(Layer.provide(dependencies)));
      const manager = yield* ManagedCodexExec.pipe(Effect.provide(context));
      const result = yield* Effect.result(
        manager.launch({
          threadId: ThreadId.make("thread-1"),
          prompt,
          title: "Reviewer",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) {
        return yield* Effect.die("Expected managed Codex spawn to fail");
      }

      const error = result.failure;
      expect(error).toBeInstanceOf(ManagedAgentRunError);
      expect(error).toMatchObject({
        reason: "spawn-failed",
        threadId: ThreadId.make("thread-1"),
        cause: spawnCause,
      });
      expect(error.message).toBe("Managed agent run failed (spawn-failed): thread-1");
      expect(error.message).not.toContain(prompt);
      expect(String(error)).not.toContain(prompt);
      expect(error.cause).toBe(spawnCause);
    }).pipe(Effect.scoped),
  );
});
