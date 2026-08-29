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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { runV2RecoveryPhase } from "../serverRuntimeStartup.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProviderRuntimeRecoveryService } from "./ProviderRuntimeRecoveryService.ts";
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
      const unreadableThreadId = ThreadId.make("thread:deferred-organization-recovery-unreadable");

      const runIds = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const seed = (targetThreadId: ThreadId, suffix: string) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:deferred-recovery:${suffix}:create`),
                threadId: targetThreadId,
                projectId: ProjectId.make("project:deferred-organization-recovery"),
                title: `Deferred organization recovery ${suffix}`,
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
                commandId: CommandId.make(`command:deferred-recovery:${suffix}:active`),
                threadId: targetThreadId,
                messageId: MessageId.make(`message:deferred-recovery:${suffix}:active`),
                text: "Keep this run active.",
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              });
              const activeRun = (yield* orchestrator.getThreadProjection(targetThreadId)).runs[0];
              assert.isDefined(activeRun);
              yield* orchestrator.dispatch({
                type: "thread.organization.defer",
                commandId: CommandId.make(`command:deferred-recovery:${suffix}:schedule`),
                threadId: targetThreadId,
                runId: activeRun.id,
                action: "settle",
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:deferred-recovery:${suffix}:queued`),
                threadId: targetThreadId,
                messageId: MessageId.make(`message:deferred-recovery:${suffix}:queued`),
                text: "This newer run makes the intent stale.",
                attachments: [],
                modelSelection,
                dispatchMode: { type: "queue_after_active" },
              });
              const seeded = yield* orchestrator.getThreadProjection(targetThreadId);
              assert.equal(seeded.thread.deferredOrganization?.runId, activeRun.id);
              const queuedRun = seeded.runs.find((run) => run.status === "queued");
              assert.isDefined(queuedRun);
              return { activeRunId: activeRun.id, queuedRunId: queuedRun.id };
            });

          const unreadable = yield* seed(unreadableThreadId, "unreadable");
          const recoverable = yield* seed(threadId, "recoverable");
          return { unreadable, recoverable };
        }).pipe(Effect.provide(runtimeLayer("deferred-organization:first-runtime"))),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET payload_json = '{not-json'
          WHERE run_id = ${runIds.unreadable.activeRunId}
        `;
      }).pipe(Effect.provide(databaseLayer));

      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.recoverDeferredOrganization;
          return yield* orchestrator.getThreadProjection(threadId);
        }).pipe(Effect.provide(runtimeLayer("deferred-organization:second-runtime"))),
      );

      assert.isNull(recovered.thread.deferredOrganization);
      assert.isNull(recovered.thread.settledOverride);
      assert.equal(
        recovered.runs.find((run) => run.id === runIds.recoverable.activeRunId)?.status,
        "starting",
      );
      assert.equal(
        recovered.runs.find((run) => run.id === runIds.recoverable.queuedRunId)?.status,
        "queued",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("discards an active-run intent after startup runtime reconciliation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-deferred-organization-runtime-recovery-" }),
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
      const threadId = ThreadId.make("thread:deferred-organization-runtime-recovery");

      const runId = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-runtime-recovery:create"),
            threadId,
            projectId: ProjectId.make("project:deferred-organization-runtime-recovery"),
            title: "Deferred organization runtime recovery",
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
            commandId: CommandId.make("command:deferred-runtime-recovery:active"),
            threadId,
            messageId: MessageId.make("message:deferred-runtime-recovery:active"),
            text: "Settle only after this run completes.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
          assert.isDefined(activeRun);
          yield* orchestrator.dispatch({
            type: "thread.organization.defer",
            commandId: CommandId.make("command:deferred-runtime-recovery:schedule"),
            threadId,
            runId: activeRun.id,
            action: "settle",
          });
          return activeRun.id;
        }).pipe(Effect.provide(runtimeLayer("deferred-runtime-recovery:first-runtime"))),
      );

      const recovered = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const providerRuntimeRecovery = yield* ProviderRuntimeRecoveryService;
          yield* runV2RecoveryPhase({
            recoverProviderRuntime: providerRuntimeRecovery.recover,
            recoverDeferredOrganization: orchestrator.recoverDeferredOrganization,
          });
          return yield* orchestrator.getThreadProjection(threadId);
        }).pipe(Effect.provide(runtimeLayer("deferred-runtime-recovery:second-runtime"))),
      );

      assert.equal(recovered.runs.find((run) => run.id === runId)?.status, "cancelled");
      assert.isNull(recovered.thread.deferredOrganization);
      assert.isNull(recovered.thread.settledOverride);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
