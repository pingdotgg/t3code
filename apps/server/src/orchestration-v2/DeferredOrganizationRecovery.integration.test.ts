import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { runV2RecoveryPhase } from "../serverRuntimeStartup.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderRuntimeRecoveryService } from "./ProviderRuntimeRecoveryService.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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

it.effect("retries one typed deferred repair failure without swallowing interruption", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    yield* Orchestrator.runDeferredOrganizationRepair(
      ThreadId.make("thread:deferred-organization-transient-repair"),
      Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(attempts, (current) => current + 1);
        if (attempt === 1) {
          return yield* new ProjectionStore.ProjectionStoreReadError({
            threadId: ThreadId.make("thread:deferred-organization-transient-repair"),
            cause: "transient projection failure",
          });
        }
      }),
    );
    assert.equal(yield* Ref.get(attempts), 2);

    const interruption = yield* Orchestrator.runDeferredOrganizationRepair(
      ThreadId.make("thread:deferred-organization-interruption"),
      Effect.interrupt,
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(interruption));
    if (Exit.isFailure(interruption)) {
      assert.isTrue(Cause.hasInterruptsOnly(interruption.cause));
    }
  }),
);

it.effect("retries a transient deferred apply read before recording its receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-deferred-organization-receipt-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const registryLayer = makeProviderAdapterRegistryLayer([adapter]);
      const threadId = ThreadId.make("thread:deferred-organization-receipt");

      const runId = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-organization-receipt:create"),
            threadId,
            projectId: ProjectId.make("project:deferred-organization-receipt"),
            title: "Deferred organization receipt",
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
            commandId: CommandId.make("command:deferred-organization-receipt:active"),
            threadId,
            messageId: MessageId.make("message:deferred-organization-receipt:active"),
            text: "Keep this run active.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
          assert.isDefined(activeRun);
          yield* orchestrator.dispatch({
            type: "thread.organization.defer",
            commandId: CommandId.make("command:deferred-organization-receipt:schedule"),
            threadId,
            runId: activeRun.id,
            action: "settle",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-organization-receipt:queued"),
            threadId,
            messageId: MessageId.make("message:deferred-organization-receipt:queued"),
            text: "Make the deferred intent stale.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          return activeRun.id;
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "deferred-organization-receipt:first-runtime",
                runtimePolicyOverride: { cwd: tempDir },
              },
              registryLayer,
              { databaseLayer, runEffectWorker: false },
            ),
          ),
        ),
      );
      const commandId = CommandId.make(
        `command:system:thread-organization-defer:${threadId}:${runId}`,
      );

      const armed = yield* Ref.make(false);
      const projectionReads = yield* Ref.make(0);
      const decorateProjectionStore = (store: ProjectionStore.ProjectionStoreV2["Service"]) =>
        ProjectionStore.ProjectionStoreV2.of({
          ...store,
          getThreadProjection: (requestedThreadId) =>
            Ref.get(armed).pipe(
              Effect.flatMap((isArmed) =>
                isArmed
                  ? Ref.updateAndGet(projectionReads, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count === 3
                          ? Effect.fail(
                              new ProjectionStore.ProjectionStoreReadError({
                                threadId: requestedThreadId,
                                cause: "simulated transient deferred apply read failure",
                              }),
                            )
                          : store.getThreadProjection(requestedThreadId),
                      ),
                    )
                  : store.getThreadProjection(requestedThreadId),
              ),
            ),
        });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const receipts = yield* CommandReceiptStoreV2;
          yield* Ref.set(armed, true);
          yield* orchestrator.recoverDeferredOrganization;

          const receipt = yield* receipts.getByCommandId(commandId);
          assert.isTrue(Option.isSome(receipt));
          if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
          assert.equal(yield* Ref.get(projectionReads), 4);
          assert.isNull(
            (yield* orchestrator.getThreadProjection(threadId)).thread.deferredOrganization,
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "deferred-organization-receipt:second-runtime",
                runtimePolicyOverride: { cwd: tempDir },
              },
              registryLayer,
              { databaseLayer, runEffectWorker: false, decorateProjectionStore },
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("promotes queued work when terminal deferred apply fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-deferred-organization-terminal-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const databaseLayer = makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const registryLayer = makeProviderAdapterRegistryLayer([adapter]);
      const threadId = ThreadId.make("thread:deferred-organization-terminal");

      const seeded = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-organization-terminal:create"),
            threadId,
            projectId: ProjectId.make("project:deferred-organization-terminal"),
            title: "Deferred organization terminal failure",
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
            commandId: CommandId.make("command:deferred-organization-terminal:active"),
            threadId,
            messageId: MessageId.make("message:deferred-organization-terminal:active"),
            text: "Complete this run before applying organization.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
          assert.isDefined(activeRun);
          yield* orchestrator.dispatch({
            type: "thread.organization.defer",
            commandId: CommandId.make("command:deferred-organization-terminal:schedule"),
            threadId,
            runId: activeRun.id,
            action: "settle",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:deferred-organization-terminal:queued"),
            threadId,
            messageId: MessageId.make("message:deferred-organization-terminal:queued"),
            text: "Promote this run after the active run ends.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const queuedRun = projection.runs.find((run) => run.status === "queued");
          assert.isDefined(queuedRun);
          return { activeRun, queuedRun };
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "deferred-organization-terminal:first-runtime",
                runtimePolicyOverride: { cwd: tempDir },
              },
              registryLayer,
              { databaseLayer, runEffectWorker: false },
            ),
          ),
        ),
      );

      const armed = yield* Ref.make(false);
      const projectionReads = yield* Ref.make(0);
      const decorateProjectionStore = (store: ProjectionStore.ProjectionStoreV2["Service"]) =>
        ProjectionStore.ProjectionStoreV2.of({
          ...store,
          getThreadProjection: (requestedThreadId) =>
            Ref.get(armed).pipe(
              Effect.flatMap((isArmed) =>
                isArmed
                  ? Ref.updateAndGet(projectionReads, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count === 3
                          ? Effect.fail(
                              new ProjectionStore.ProjectionStoreReadError({
                                threadId: requestedThreadId,
                                cause: "simulated terminal deferred apply failure",
                              }),
                            )
                          : store.getThreadProjection(requestedThreadId),
                      ),
                    )
                  : store.getThreadProjection(requestedThreadId),
              ),
            ),
        });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSinkV2;
          const receipts = yield* CommandReceiptStoreV2;
          const afterSequence = yield* eventSink.latestSequence({ threadId });
          const promoted = yield* eventSink.stream({ threadId, afterSequence }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === seeded.queuedRun.id &&
                stored.event.payload.status === "starting",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* Ref.set(armed, true);
          const completedAt = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:deferred-organization-terminal:completed"),
                type: "run.updated",
                threadId,
                runId: seeded.activeRun.id,
                ...(seeded.activeRun.rootNodeId === null
                  ? {}
                  : { nodeId: seeded.activeRun.rootNodeId }),
                providerInstanceId: seeded.activeRun.providerInstanceId,
                occurredAt: completedAt,
                payload: {
                  ...seeded.activeRun,
                  status: "completed",
                  completedAt,
                },
              },
            ],
          });
          assert.isTrue(Option.isSome(yield* Fiber.join(promoted)));
          yield* Ref.set(armed, false);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            projection.runs.find((run) => run.id === seeded.queuedRun.id)?.status,
            "starting",
          );
          assert.equal(yield* Ref.get(projectionReads), 4);
          assert.isTrue(
            Option.isNone(
              yield* receipts.getByCommandId(
                CommandId.make(
                  `command:system:thread-organization-defer:${threadId}:${seeded.activeRun.id}`,
                ),
              ),
            ),
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "deferred-organization-terminal:second-runtime",
                runtimePolicyOverride: { cwd: tempDir },
              },
              registryLayer,
              { databaseLayer, runEffectWorker: false, decorateProjectionStore },
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
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
          const orchestrator = yield* Orchestrator.OrchestratorV2;
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
