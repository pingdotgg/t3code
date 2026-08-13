import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProviderTurnIntentRepository } from "../../persistence/Services/ProviderTurnIntents.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const providerTurnIntents = await runtime.runPromise(
    Effect.service(ProviderTurnIntentRepository),
  );
  return {
    engine,
    sql,
    providerTurnIntents,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

type TestOrchestrationSystem = Awaited<ReturnType<typeof createOrchestrationSystem>>;

async function seedPendingProviderTurn(system: TestOrchestrationSystem, suffix: string) {
  const createdAt = now();
  const projectId = asProjectId(`project-provider-intent-${suffix}`);
  const threadId = ThreadId.make(`thread-provider-intent-${suffix}`);
  const engine = system.engine;

  await system.run(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-provider-intent-${suffix}`),
      projectId,
      title: `Provider Intent ${suffix}`,
      workspaceRoot: `/tmp/provider-intent-${suffix}`,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    }),
  );
  await system.run(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-provider-intent-${suffix}`),
      threadId,
      projectId,
      title: `Provider Intent ${suffix}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );
  const turnStart = await system.run(
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-provider-intent-${suffix}`),
      threadId,
      message: {
        messageId: asMessageId(`message-provider-intent-${suffix}`),
        role: "user",
        text: `provider intent ${suffix}`,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    }),
  );
  await system.run(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-session-provider-intent-${suffix}-starting`),
      threadId,
      session: {
        threadId,
        status: "starting",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );

  return { createdAt, projectId, threadId, eventSequence: turnStart.sequence } as const;
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("replays only an exact accepted process-local command identity", async () => {
    const system = await createOrchestrationSystem();
    const commandId = CommandId.make("command-process-local-receipt");
    const threadId = ThreadId.make("thread-process-local-receipt");
    try {
      await system.run(
        system.engine.registerProcessLocalCommand!({ commandId, fingerprint: "fingerprint-a" }),
      );
      await system.run(system.sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        ) VALUES (
          ${commandId},
          'thread',
          ${threadId},
          ${now()},
          42,
          'accepted',
          NULL
        )
      `);

      expect(
        await system.run(
          system.engine.findAcceptedProcessLocalCommand!({
            commandId,
            fingerprint: "fingerprint-a",
            threadId,
          }),
        ),
      ).toEqual(Option.some({ sequence: 42 }));
      await expect(
        system.run(
          system.engine.findAcceptedProcessLocalCommand!({
            commandId,
            fingerprint: "fingerprint-b",
            threadId,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
      });
      expect(
        await system.run(
          system.engine.findAcceptedProcessLocalCommand!({
            commandId: CommandId.make("command-process-local-receipt-other"),
            fingerprint: "fingerprint-a",
            threadId,
          }),
        ),
      ).toEqual(Option.none());

      await system.run(system.sql`DROP TABLE process_local_command_fingerprints`);
      await expect(
        system.run(
          system.engine.registerProcessLocalCommand!({ commandId, fingerprint: "fingerprint-a" }),
        ),
      ).rejects.toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message: "Failed to persist process-local command identity",
      });
      await expect(
        system.run(
          system.engine.findAcceptedProcessLocalCommand!({
            commandId,
            fingerprint: "fingerprint-a",
            threadId,
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        message: "Failed to read process-local command identity",
      });
    } finally {
      await system.dispose();
    }
  });

  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("rejects a second turn start until the pending provider turn is adopted", async () => {
    const createdAt = now();
    const afterAdoptionGrace = "2026-01-01T00:03:00.000Z";
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents, sql } = system;
    const threadId = ThreadId.make("thread-single-pending");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-single-pending-create"),
        projectId: asProjectId("project-single-pending"),
        title: "Single Pending Project",
        workspaceRoot: "/tmp/project-single-pending",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-single-pending-create"),
        threadId,
        projectId: asProjectId("project-single-pending"),
        title: "Single Pending Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const firstCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-single-pending-first"),
      threadId,
      message: {
        messageId: asMessageId("message-single-pending-first"),
        role: "user" as const,
        text: "first pending turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };
    const firstResult = await system.run(engine.dispatch(firstCommand));
    expect(await system.run(engine.dispatch(firstCommand))).toEqual(firstResult);

    const secondCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-single-pending-second"),
      threadId,
      message: {
        messageId: asMessageId("message-single-pending-second"),
        role: "user" as const,
        text: "second pending turn",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: afterAdoptionGrace,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(system.run(engine.dispatch(secondCommand))).rejects.toMatchObject({
        _tag: "OrchestrationTurnStartPendingError",
        threadId,
      });
    }

    expect(
      await system.run(sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM orchestration_command_receipts
        WHERE command_id = ${secondCommand.commandId}
      `),
    ).toEqual([{ count: 0 }]);
    const eventsWhilePending = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      eventsWhilePending.filter((event) => event.type === "thread.turn-start-requested"),
    ).toHaveLength(1);
    expect(eventsWhilePending.some((event) => event.commandId === secondCommand.commandId)).toBe(
      false,
    );

    expect(
      await system.run(
        providerTurnIntents.deleteExact({
          eventSequence: firstResult.sequence,
          threadId,
        }),
      ),
    ).toBe(true);
    expect(await system.run(providerTurnIntents.hasPendingForThread({ threadId }))).toBe(false);

    const secondResult = await system.run(engine.dispatch(secondCommand));
    expect(secondResult.sequence).toBeGreaterThan(firstResult.sequence);
    expect(await system.run(engine.dispatch(secondCommand))).toEqual(secondResult);
    await system.dispose();
  });

  it("serializes running-session steering until the in-flight provider handoff finishes", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents } = system;
    const projectId = asProjectId("project-running-steering");
    const threadId = ThreadId.make("thread-running-steering");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-running-steering"),
        projectId,
        title: "Running Steering Project",
        workspaceRoot: "/tmp/project-running-steering",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-running-steering"),
        threadId,
        projectId,
        title: "Running Steering Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-running-steering-first"),
        threadId,
        message: {
          messageId: asMessageId("message-running-steering-first"),
          role: "user",
          text: "long-running provider prompt",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-steering-adopted"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "cursor",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("provider-turn-running-steering"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    const secondCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-running-steering-second"),
      threadId,
      message: {
        messageId: asMessageId("message-running-steering-second"),
        role: "user",
        text: "steer the running provider",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: "2026-01-01T00:00:01.000Z",
    } as const;

    await expect(system.run(engine.dispatch(secondCommand))).rejects.toMatchObject({
      _tag: "OrchestrationTurnStartPendingError",
      threadId,
    });

    const pending = (await system.run(providerTurnIntents.listPending())).filter(
      (intent) => intent.threadId === threadId,
    );
    expect(pending.map((intent) => intent.messageId)).toEqual([
      asMessageId("message-running-steering-first"),
    ]);

    expect(
      await system.run(
        providerTurnIntents.deleteExact({
          eventSequence: pending[0]!.eventSequence,
          threadId,
        }),
      ),
    ).toBe(true);
    await expect(system.run(engine.dispatch(secondCommand))).resolves.toMatchObject({
      sequence: expect.any(Number),
    });
    await system.dispose();
  });

  it("recovers a legacy orphan starting session after the durable intent migration", async () => {
    const createdAt = now();
    const afterQueueGrace = "2026-01-01T00:03:00.000Z";
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents } = system;
    const projectId = asProjectId("project-historical-queued-state");
    const threadId = ThreadId.make("thread-historical-queued-state");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-historical-queued-state"),
        projectId,
        title: "Historical Queued Project",
        workspaceRoot: "/tmp/project-historical-queued-state",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-historical-queued-state"),
        threadId,
        projectId,
        title: "Historical Queued Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const historicalResult = await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-historical-queued-state-first"),
        threadId,
        message: {
          messageId: asMessageId("message-historical-queued-state-first"),
          role: "user",
          text: "historical queued prompt",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await system.run(
      providerTurnIntents.deleteByEventSequence({ eventSequence: historicalResult.sequence }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-historical-queued-state-starting"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:02:59.000Z",
        },
        createdAt: "2026-01-01T00:02:59.000Z",
      }),
    );

    const secondCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-historical-queued-state-second"),
      threadId,
      message: {
        messageId: asMessageId("message-historical-queued-state-second"),
        role: "user",
        text: "new prompt after historical recovery",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: afterQueueGrace,
    } as const;

    const accepted = await system.run(engine.dispatch(secondCommand));
    expect(accepted.sequence).toBeGreaterThan(historicalResult.sequence);
    expect(await system.run(providerTurnIntents.hasPendingForThread({ threadId }))).toBe(true);
    await system.dispose();
  });

  it("atomically acknowledges provider handoff success and unblocks the next turn", async () => {
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents, sql } = system;
    const pending = await seedPendingProviderTurn(system, "adapter-ack-first");
    const completeProviderTurnIntent = engine.completeProviderTurnIntent;
    expect(completeProviderTurnIntent).toBeDefined();
    if (completeProviderTurnIntent === undefined) {
      throw new Error("provider intent completion API unavailable");
    }

    const acknowledgmentCommandId = CommandId.make("cmd-provider-intent-adapter-ack-running");
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: {
            kind: "exact",
            eventSequence: pending.eventSequence,
            threadId: pending.threadId,
          },
          commandPolicy: "if-consumed-and-session-starting",
          acknowledgement: {
            turnId: asTurnId("turn-adapter-ack-first"),
            acknowledgedAt: pending.createdAt,
          },
          commands: [
            {
              type: "thread.session.set",
              commandId: acknowledgmentCommandId,
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: asTurnId("turn-adapter-ack-first"),
                lastError: null,
                updatedAt: pending.createdAt,
              },
              createdAt: pending.createdAt,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ consumed: true });

    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(false);
    expect(
      (await system.readModel()).threads.find(({ id }) => id === pending.threadId)?.session,
    ).toMatchObject({
      status: "running",
      activeTurnId: asTurnId("turn-adapter-ack-first"),
    });
    expect(
      await system.run(sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM orchestration_command_receipts
        WHERE command_id = ${acknowledgmentCommandId}
          AND status = 'accepted'
      `),
    ).toEqual([{ count: 1 }]);
    expect(
      await system.run(sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_turns
        WHERE thread_id = ${pending.threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `),
    ).toEqual([{ count: 0 }]);
    expect(
      await system.run(sql<{ readonly messageId: string | null }>`
        SELECT pending_message_id AS "messageId"
        FROM projection_turns
        WHERE thread_id = ${pending.threadId}
          AND turn_id = ${"turn-adapter-ack-first"}
      `),
    ).toEqual([{ messageId: "message-provider-intent-adapter-ack-first" }]);

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-provider-intent-next-turn"),
          threadId: pending.threadId,
          message: {
            messageId: asMessageId("message-provider-intent-next-turn"),
            role: "user",
            text: "the provider acknowledgment released the serialized gate",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    await system.dispose();
  });

  it("keeps the authoritative runtime turn when runtime adoption wins the acknowledgment race", async () => {
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents, sql } = system;
    const pending = await seedPendingProviderTurn(system, "runtime-first");
    const completeProviderTurnIntent = engine.completeProviderTurnIntent;
    expect(completeProviderTurnIntent).toBeDefined();
    if (completeProviderTurnIntent === undefined) {
      throw new Error("provider intent completion API unavailable");
    }

    const runtimeCommandId = CommandId.make("cmd-provider-intent-runtime-first-running");
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: { kind: "oldest-for-thread", threadId: pending.threadId },
          commandPolicy: "always",
          commands: [
            {
              type: "thread.session.set",
              commandId: runtimeCommandId,
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: asTurnId("turn-authoritative-runtime"),
                lastError: null,
                updatedAt: pending.createdAt,
              },
              createdAt: pending.createdAt,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ consumed: true });

    const staleAcknowledgmentCommandId = CommandId.make(
      "cmd-provider-intent-runtime-first-stale-ack",
    );
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: {
            kind: "exact",
            eventSequence: pending.eventSequence,
            threadId: pending.threadId,
          },
          commandPolicy: "if-consumed-and-session-starting",
          commands: [
            {
              type: "thread.session.set",
              commandId: staleAcknowledgmentCommandId,
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: asTurnId("turn-stale-adapter-result"),
                lastError: null,
                updatedAt: pending.createdAt,
              },
              createdAt: pending.createdAt,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ consumed: false });

    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(false);
    expect(
      (await system.readModel()).threads.find(({ id }) => id === pending.threadId)?.session,
    ).toMatchObject({
      status: "running",
      activeTurnId: asTurnId("turn-authoritative-runtime"),
    });
    expect(
      await system.run(sql<{ readonly commandId: string }>`
        SELECT command_id AS "commandId"
        FROM orchestration_command_receipts
        WHERE command_id IN (${runtimeCommandId}, ${staleAcknowledgmentCommandId})
        ORDER BY command_id ASC
      `),
    ).toEqual([{ commandId: runtimeCommandId }]);

    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-provider-intent-runtime-first-next-turn"),
        threadId: pending.threadId,
        message: {
          messageId: asMessageId("message-provider-intent-runtime-first-next-turn"),
          role: "user",
          text: "a later intent must survive an old runtime event replay",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: {
            kind: "exact",
            eventSequence: pending.eventSequence,
            threadId: pending.threadId,
          },
          commandPolicy: "if-consumed-and-session-starting",
          acknowledgement: {
            turnId: asTurnId("turn-stale-adapter-result"),
            acknowledgedAt: "2026-01-01T00:00:02.000Z",
          },
          commands: [],
        }),
      ),
    ).resolves.toEqual({ consumed: false });
    expect(
      await system.run(sql<{ readonly messageId: string }>`
        SELECT pending_message_id AS "messageId"
        FROM projection_turns
        WHERE thread_id = ${pending.threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `),
    ).toEqual([{ messageId: "message-provider-intent-runtime-first-next-turn" }]);
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: { kind: "oldest-for-thread", threadId: pending.threadId },
          commandPolicy: "always",
          commands: [
            {
              type: "thread.session.set",
              commandId: runtimeCommandId,
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: asTurnId("turn-authoritative-runtime"),
                lastError: null,
                updatedAt: pending.createdAt,
              },
              createdAt: pending.createdAt,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ consumed: false });
    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(true);
    await system.dispose();
  });

  it("does not overwrite a terminal runtime lifecycle with a late provider acknowledgment", async () => {
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents } = system;
    const pending = await seedPendingProviderTurn(system, "terminal-first");
    const completeProviderTurnIntent = engine.completeProviderTurnIntent;
    expect(completeProviderTurnIntent).toBeDefined();
    if (completeProviderTurnIntent === undefined) {
      throw new Error("provider intent completion API unavailable");
    }

    await system.run(
      completeProviderTurnIntent({
        selector: { kind: "oldest-for-thread", threadId: pending.threadId },
        commandPolicy: "always",
        commands: [
          {
            type: "thread.session.set",
            commandId: CommandId.make("cmd-provider-intent-terminal-first-error"),
            threadId: pending.threadId,
            session: {
              threadId: pending.threadId,
              status: "error",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: "provider terminated before acknowledgment",
              updatedAt: pending.createdAt,
            },
            createdAt: pending.createdAt,
          },
        ],
      }),
    );
    await expect(
      system.run(
        completeProviderTurnIntent({
          selector: {
            kind: "exact",
            eventSequence: pending.eventSequence,
            threadId: pending.threadId,
          },
          commandPolicy: "if-consumed-and-session-starting",
          commands: [
            {
              type: "thread.session.set",
              commandId: CommandId.make("cmd-provider-intent-terminal-first-late-ack"),
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "approval-required",
                activeTurnId: asTurnId("turn-late-ack"),
                lastError: null,
                updatedAt: pending.createdAt,
              },
              createdAt: pending.createdAt,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ consumed: false });

    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(false);
    expect(
      (await system.readModel()).threads.find(({ id }) => id === pending.threadId)?.session,
    ).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "provider terminated before acknowledgment",
    });
    await system.dispose();
  });

  it("rolls back terminal failure projection and intent consumption as one unit", async () => {
    const system = await createOrchestrationSystem();
    const { engine, providerTurnIntents, sql } = system;
    const pending = await seedPendingProviderTurn(system, "failure-rollback");
    const completeProviderTurnIntent = engine.completeProviderTurnIntent;
    expect(completeProviderTurnIntent).toBeDefined();
    if (completeProviderTurnIntent === undefined) {
      throw new Error("provider intent completion API unavailable");
    }

    const sessionCommandId = CommandId.make("cmd-provider-intent-failure-session");
    const activityCommandId = CommandId.make("cmd-provider-intent-failure-activity");
    const completion = completeProviderTurnIntent({
      selector: {
        kind: "exact",
        eventSequence: pending.eventSequence,
        threadId: pending.threadId,
      },
      commandPolicy: "if-consumed",
      commands: [
        {
          type: "thread.session.set",
          commandId: sessionCommandId,
          threadId: pending.threadId,
          session: {
            threadId: pending.threadId,
            status: "error",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "send failed terminally",
            updatedAt: pending.createdAt,
          },
          createdAt: pending.createdAt,
        },
        {
          type: "thread.activity.append",
          commandId: activityCommandId,
          threadId: pending.threadId,
          activity: {
            id: EventId.make("activity-provider-intent-failure"),
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { detail: "send failed terminally" },
            turnId: null,
            createdAt: pending.createdAt,
          },
          createdAt: pending.createdAt,
        },
      ],
    });

    await system.run(sql`
      CREATE TRIGGER fail_provider_intent_failure_activity
      BEFORE INSERT ON projection_thread_activities
      BEGIN
        SELECT RAISE(ABORT, 'forced-provider-intent-failure-activity');
      END
    `);
    await expect(system.run(completion)).rejects.toThrow();

    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(true);
    expect(
      (await system.readModel()).threads.find(({ id }) => id === pending.threadId)?.session,
    ).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
    expect(
      await system.run(sql<{ readonly eventCount: number; readonly receiptCount: number }>`
        SELECT
          (
            SELECT COUNT(*)
            FROM orchestration_events
            WHERE command_id IN (${sessionCommandId}, ${activityCommandId})
          ) AS "eventCount",
          (
            SELECT COUNT(*)
            FROM orchestration_command_receipts
            WHERE command_id IN (${sessionCommandId}, ${activityCommandId})
          ) AS "receiptCount"
      `),
    ).toEqual([{ eventCount: 0, receiptCount: 0 }]);

    await system.run(sql`DROP TRIGGER fail_provider_intent_failure_activity`);
    await expect(system.run(completion)).resolves.toEqual({ consumed: true });
    expect(
      await system.run(providerTurnIntents.hasPendingForThread({ threadId: pending.threadId })),
    ).toBe(false);
    expect(
      (await system.readModel()).threads.find(({ id }) => id === pending.threadId)?.session,
    ).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "send failed terminally",
    });
    expect(
      await system.run(sql<{ readonly eventCount: number; readonly receiptCount: number }>`
        SELECT
          (
            SELECT COUNT(*)
            FROM orchestration_events
            WHERE command_id IN (${sessionCommandId}, ${activityCommandId})
          ) AS "eventCount",
          (
            SELECT COUNT(*)
            FROM orchestration_command_receipts
            WHERE command_id IN (${sessionCommandId}, ${activityCommandId})
          ) AS "receiptCount"
      `),
    ).toEqual([{ eventCount: 2, receiptCount: 2 }]);
    await system.dispose();
  });

  it("returns one accepted result when the same command is replayed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const command = {
      type: "project.create" as const,
      commandId: CommandId.make("cmd-project-idempotent-create"),
      projectId: asProjectId("project-idempotent"),
      title: "Idempotent Project",
      workspaceRoot: "/tmp/project-idempotent",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: now(),
    };

    const results = await Promise.all([
      system.run(engine.dispatch(command)),
      system.run(engine.dispatch(command)),
    ]);
    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );

    expect(results).toEqual([{ sequence: 1 }, { sequence: 1 }]);
    expect(events.map((event) => event.type)).toEqual(["project.created"]);
    await system.dispose();
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    await runtime.dispose();
  });

  it("atomically commits a bootstrapped turn with its live projections and provider intent", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql } = system;
    const createdAt = now();
    const commandId = CommandId.make("cmd-live-atomic-turn-start");
    const projectId = asProjectId("project-live-atomic");
    const threadId = ThreadId.make("thread-live-atomic");
    const messageId = asMessageId("message-live-atomic");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-atomic-project-create"),
        projectId,
        title: "Live Atomic Project",
        workspaceRoot: "/tmp/project-live-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId,
      threadId,
      message: {
        messageId,
        role: "user" as const,
        text: "commit every durable handoff atomically",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      bootstrap: {
        createThread: {
          projectId,
          title: "Live Atomic Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required" as const,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    };

    const readPersistedState = () =>
      system.run(
        sql<{
          readonly commandEventCount: number;
          readonly receiptCount: number;
          readonly threadCount: number;
          readonly messageCount: number;
          readonly pendingTurnCount: number;
          readonly providerIntentCount: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM orchestration_events WHERE command_id = ${commandId})
              AS "commandEventCount",
            (SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = ${commandId})
              AS "receiptCount",
            (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${threadId})
              AS "threadCount",
            (SELECT COUNT(*) FROM projection_thread_messages WHERE message_id = ${messageId})
              AS "messageCount",
            (
              SELECT COUNT(*)
              FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NULL
                AND state = 'pending'
            ) AS "pendingTurnCount",
            (SELECT COUNT(*) FROM provider_turn_intents WHERE thread_id = ${threadId})
              AS "providerIntentCount"
        `,
      );

    await system.run(sql`
      CREATE TRIGGER fail_live_atomic_provider_turn_intent
      BEFORE INSERT ON provider_turn_intents
      WHEN NEW.thread_id = 'thread-live-atomic'
      BEGIN
        SELECT RAISE(ABORT, 'forced-provider-turn-intent-failure');
      END;
    `);

    await expect(system.run(engine.dispatch(turnStartCommand))).rejects.toThrow();

    expect(await readPersistedState()).toEqual([
      {
        commandEventCount: 0,
        receiptCount: 0,
        threadCount: 0,
        messageCount: 0,
        pendingTurnCount: 0,
        providerIntentCount: 0,
      },
    ]);
    const eventsAfterFailure = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual(["project.created"]);
    expect((await system.readModel()).threads).toEqual([]);

    await system.run(sql`DROP TRIGGER fail_live_atomic_provider_turn_intent`);

    const retryResult = await system.run(engine.dispatch(turnStartCommand));
    expect(retryResult).toEqual({ sequence: 4 });

    const eventsAfterRetry = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(eventsAfterRetry.slice(1).map((event) => event.commandId)).toEqual([
      commandId,
      commandId,
      commandId,
    ]);
    expect(await readPersistedState()).toEqual([
      {
        commandEventCount: 3,
        receiptCount: 1,
        threadCount: 1,
        messageCount: 1,
        pendingTurnCount: 1,
        providerIntentCount: 1,
      },
    ]);
    expect(
      await system.run(sql<{
        readonly eventSequence: number;
        readonly threadId: string;
        readonly messageId: string;
        readonly requestedAt: string;
      }>`
        SELECT
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId",
          requested_at AS "requestedAt"
        FROM provider_turn_intents
        WHERE thread_id = ${threadId}
      `),
    ).toEqual([
      {
        eventSequence: 4,
        threadId,
        messageId,
        requestedAt: createdAt,
      },
    ]);

    expect(await system.run(engine.dispatch(turnStartCommand))).toEqual(retryResult);
    const eventsAfterReplay = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterReplay).toEqual(eventsAfterRetry);
    expect(await readPersistedState()).toEqual([
      {
        commandEventCount: 3,
        receiptCount: 1,
        threadCount: 1,
        messageCount: 1,
        pendingTurnCount: 1,
        providerIntentCount: 1,
      },
    ]);

    await system.dispose();
  });

  it("atomically retries a thread bootstrap and resumes a legacy partial create", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.make("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-turn-start-atomic"),
      threadId: ThreadId.make("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      bootstrap: {
        createThread: {
          projectId: asProjectId("project-atomic"),
          title: "atomic",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required" as const,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "projection failed",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual(["project.created"]);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(eventsAfterRetry.slice(1).map((event) => event.commandId)).toEqual([
      turnStartCommand.commandId,
      turnStartCommand.commandId,
      turnStartCommand.commandId,
    ]);

    const replayResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(replayResult).toEqual(retryResult);
    const eventsAfterReplay = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterReplay).toEqual(eventsAfterRetry);

    const legacyThreadId = ThreadId.make("thread-legacy-partial-bootstrap");
    const legacyOuterCommandId = CommandId.make("cmd-turn-start-legacy-partial");
    const legacyCreateCommandId = CommandId.make(
      `server:bootstrap-thread-create:${legacyOuterCommandId}`,
    );
    const legacyCreate = {
      type: "thread.create" as const,
      commandId: legacyCreateCommandId,
      threadId: legacyThreadId,
      projectId: asProjectId("project-atomic"),
      title: "legacy partial",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      branch: null,
      worktreePath: null,
      createdAt,
    };
    await runtime.runPromise(engine.dispatch(legacyCreate));
    const legacyBootstrap = {
      type: "thread.turn.start" as const,
      commandId: legacyOuterCommandId,
      threadId: legacyThreadId,
      message: {
        messageId: MessageId.make("message-legacy-partial"),
        role: "user" as const,
        text: "resume after update",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      bootstrap: {
        createThread: {
          projectId: legacyCreate.projectId,
          title: legacyCreate.title,
          modelSelection: legacyCreate.modelSelection,
          interactionMode: legacyCreate.interactionMode,
          runtimeMode: legacyCreate.runtimeMode,
          branch: legacyCreate.branch,
          worktreePath: legacyCreate.worktreePath,
          createdAt,
        },
      },
      createdAt,
    };

    const legacyResult = await runtime.runPromise(engine.dispatch(legacyBootstrap));
    const eventsAfterLegacyResume = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    const legacyEvents = eventsAfterLegacyResume.filter(
      (event) => event.aggregateId === legacyThreadId,
    );
    expect(legacyEvents.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(legacyEvents.map((event) => event.commandId)).toEqual([
      legacyCreateCommandId,
      legacyOuterCommandId,
      legacyOuterCommandId,
    ]);

    expect(await runtime.runPromise(engine.dispatch(legacyBootstrap))).toEqual(legacyResult);
    const eventsAfterLegacyReplay = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterLegacyReplay).toEqual(eventsAfterLegacyResume);

    const mismatchedThreadId = ThreadId.make("thread-legacy-created-at-mismatch");
    const mismatchedOuterCommandId = CommandId.make("cmd-turn-start-legacy-created-at-mismatch");
    const mismatchedLegacyCreate = {
      ...legacyCreate,
      commandId: CommandId.make(`server:bootstrap-thread-create:${mismatchedOuterCommandId}`),
      threadId: mismatchedThreadId,
      createdAt: "2025-12-31T23:59:59.000Z",
    };
    await runtime.runPromise(engine.dispatch(mismatchedLegacyCreate));
    const eventsBeforeMismatchedResume = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    await expect(
      runtime.runPromise(
        engine.dispatch({
          ...legacyBootstrap,
          commandId: mismatchedOuterCommandId,
          threadId: mismatchedThreadId,
          message: {
            ...legacyBootstrap.message,
            messageId: MessageId.make("message-legacy-created-at-mismatch"),
          },
          bootstrap: {
            createThread: {
              ...legacyBootstrap.bootstrap.createThread,
              createdAt,
            },
          },
        }),
      ),
    ).rejects.toThrow();
    const eventsAfterMismatchedResume = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterMismatchedResume).toEqual(eventsBeforeMismatchedResume);

    await runtime.dispose();
  });

  it("reconciles command state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("projection failed");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        }),
      ),
    ).rejects.toThrow("already archived");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
