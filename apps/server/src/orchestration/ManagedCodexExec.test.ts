import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  it.effect("launches an owned codex exec and cancels its exact process handle", () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const terminal = yield* Deferred.make<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      let killed = false;
      let spawnedCommand: unknown;
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1234),
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => !killed),
        kill: () =>
          Effect.gen(function* () {
            killed = true;
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143));
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawnedCommand = command;
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
                ? Deferred.succeed(terminal, event).pipe(Effect.asVoid)
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
      expect(yield* Deferred.await(terminal)).toMatchObject({
        type: "task.completed",
        payload: { taskId: launched.agentId, status: "stopped" },
      });
    }).pipe(Effect.scoped),
  );
});
