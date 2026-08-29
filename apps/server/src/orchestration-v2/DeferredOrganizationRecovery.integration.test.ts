import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("provider sessions are not used in recovery coverage"),
} as ProviderAdapterV2Shape;

it.effect("discards a stale deferred organization intent after runtime restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-deferred-organization-recovery-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const registryLayer = makeProviderAdapterRegistryLayer([adapter]);
      const runtimeLayer = (name: string) =>
        makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd: tempDir } },
          registryLayer,
          { databaseLayer, runEffectWorker: false },
        );
      const threadId = ThreadId.make("thread:deferred-organization-recovery");

      const runIds = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-recovery:create"),
            threadId,
            projectId: ProjectId.make("project:deferred-organization-recovery"),
            title: "Deferred organization recovery",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: tempDir,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-recovery:active"),
            threadId,
            messageId: MessageId.make("message:deferred-recovery:active"),
            text: "Keep this run active.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
          assert.isDefined(activeRun);
          yield* orchestrator.dispatch({
            type: "thread.organization.defer",
            commandId: CommandId.make("command:deferred-recovery:schedule"),
            threadId,
            runId: activeRun.id,
            action: "settle",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-recovery:queued"),
            threadId,
            messageId: MessageId.make("message:deferred-recovery:queued"),
            text: "This newer run makes the intent stale.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const seeded = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(seeded.thread.deferredOrganization?.runId, activeRun.id);
          const queuedRun = seeded.runs.find((run) => run.status === "queued");
          assert.isDefined(queuedRun);
          return { activeRunId: activeRun.id, queuedRunId: queuedRun.id };
        }).pipe(Effect.provide(runtimeLayer("deferred-organization:first-runtime"))),
      );

      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          return yield* orchestrator.getThreadProjection(threadId);
        }).pipe(Effect.provide(runtimeLayer("deferred-organization:second-runtime"))),
      );

      assert.isNull(recovered.thread.deferredOrganization);
      assert.isNull(recovered.thread.settledOverride);
      assert.equal(recovered.runs.find((run) => run.id === runIds.activeRunId)?.status, "starting");
      assert.equal(recovered.runs.find((run) => run.id === runIds.queuedRunId)?.status, "queued");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
