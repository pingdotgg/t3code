/**
 * Behavioural tests for the notification reactor.
 *
 * These are the ported `notificationEvents.test.ts` reducer cases from t3code,
 * re-expressed against the real event stream: dispatch commands, let the
 * reactor drain, assert the outbox rows. Nothing here stubs the projection —
 * the phase the reactor reads is the phase the sidebar reads, and that is the
 * property most worth protecting.
 *
 * Two harness rules make the suite deterministic without a single sleep:
 *
 * - Every dispatch is followed by `settle`, which waits until the reactor's
 *   durable cursor has reached the last observed event. The reactor reads
 *   *current* projection state, so tests must advance it in lockstep or they
 *   assert against a shell from the future.
 * - Reactor lifetimes are explicit scopes (`withReactorSession`), so a
 *   "restart" is two sessions over one database rather than a mocked cursor.
 */
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { NotificationOutboxRepositoryLive } from "../../persistence/Layers/NotificationOutbox.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NotificationOutboxRepository,
  type NotificationOutboxRecord,
} from "../../persistence/Services/NotificationOutbox.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { NotificationEdgeBus } from "../Services/NotificationEdgeBus.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import type { NotificationReactorShape } from "../Services/NotificationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  NOTIFICATION_OUTBOX_PROJECTOR_NAME,
  makeNotificationReactor,
  notificationIdentityKey,
} from "./NotificationReactor.ts";
import { NotificationEdgeBusLive } from "./NotificationEdgeBus.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const PROJECT_ID = ProjectId.make("project-notifications");
const THREAD_ID = ThreadId.make("thread-notifications");
const PROJECT_TITLE = "t3";
const THREAD_TITLE = "Fix failing CI";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const TURN_1 = TurnId.make("turn-0000000001");
const TURN_2 = TurnId.make("turn-0000000002");
const TURN_3 = TurnId.make("turn-0000000003");
const TURN_BACKGROUND = TurnId.make("turn-background");

/** Mirror of the reactor's own filter; a barrier must be an event it reacts to. */
const OBSERVED_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.proposed-plan-upserted",
  "thread.reverted",
]);

const testLayer = Layer.empty.pipe(
  Layer.provideMerge(NotificationEdgeBusLive),
  Layer.provideMerge(NotificationOutboxRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(OrchestrationEngineLive),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-notification-reactor-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const keyOf = (
  kind: Parameters<typeof notificationIdentityKey>[0]["kind"],
  discriminator: string,
) => notificationIdentityKey({ threadId: THREAD_ID, kind, discriminator });

const summarize = (rows: ReadonlyArray<NotificationOutboxRecord>) =>
  rows.map((row) => [row.kind, row.identityKey, row.detectionVerdict] as const);

interface EndedSpan {
  readonly name: string;
  readonly sampled: boolean;
  readonly attributes: Record<string, unknown>;
}

const collectSpans = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const spans: Array<EndedSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          spans.push({
            name: span.name,
            sampled: span.sampled,
            attributes: Object.fromEntries(span.attributes),
          });
        };
        return span;
      },
    });

    yield* effect.pipe(Effect.withTracer(tracer));
    return spans;
  });

const makeHarness = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const outbox = yield* NotificationOutboxRepository;
  const projectionState = yield* ProjectionStateRepository;

  let attached: NotificationReactorShape | null = null;
  let clock = 0;
  let commandCount = 0;

  /** Monotonic timestamps: the user-initiated predicate is a string compare. */
  const at = (): string => {
    clock += 1;
    return `2026-01-01T00:${String(clock).padStart(2, "0")}:00.000Z`;
  };
  const commandId = (label: string): CommandId => {
    commandCount += 1;
    return CommandId.make(`cmd-${label}-${commandCount}`);
  };

  const lastObservedSequence = engine.readEvents(0, Number.MAX_SAFE_INTEGER).pipe(
    Stream.runCollect,
    Effect.map((events) =>
      events.reduce(
        (sequence, event) =>
          OBSERVED_EVENT_TYPES.has(event.type) ? Math.max(sequence, event.sequence) : sequence,
        0,
      ),
    ),
  );

  const appliedSequence = projectionState
    .getByProjector({ projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME })
    .pipe(Effect.map(Option.match({ onNone: () => 0, onSome: (row) => row.lastAppliedSequence })));

  const settle = Effect.gen(function* () {
    const reactor = attached;
    if (reactor === null) {
      return;
    }
    const target = yield* lastObservedSequence;
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      yield* reactor.drain;
      if ((yield* appliedSequence) >= target) {
        yield* reactor.drain;
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(
      new Error(`notification reactor never reached sequence ${String(target)}`),
    );
  });

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(Effect.tap(() => settle));

  const createProject = (title = PROJECT_TITLE) =>
    dispatch({
      type: "project.create",
      commandId: commandId("project-create"),
      projectId: PROJECT_ID,
      title,
      workspaceRoot: "/tmp/t3-notifications",
      defaultModelSelection: MODEL_SELECTION,
      createdAt: at(),
    });

  const createThread = () =>
    dispatch({
      type: "thread.create",
      commandId: commandId("thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: THREAD_TITLE,
      modelSelection: MODEL_SELECTION,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "auto",
      branch: null,
      worktreePath: null,
      createdAt: at(),
    });

  const startTurn = (options?: { readonly text?: string; readonly commandId?: CommandId }) => {
    const createdAt = at();
    return dispatch({
      type: "thread.turn.start",
      commandId: options?.commandId ?? commandId("turn-start"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make(`message-${createdAt}`),
        role: "user",
        text: options?.text ?? "please fix the build",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "auto",
      createdAt,
    });
  };

  const setSession = (options: {
    readonly status: OrchestrationSession["status"];
    readonly activeTurnId?: TurnId | null;
    readonly lastError?: string | null;
  }) => {
    const updatedAt = at();
    return dispatch({
      type: "thread.session.set",
      commandId: commandId(`session-${options.status}`),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: options.status,
        providerName: "codex",
        runtimeMode: "auto",
        activeTurnId: options.activeTurnId ?? null,
        lastError: options.lastError ?? null,
        updatedAt,
      },
      createdAt: updatedAt,
    });
  };

  const completeDiff = (options: {
    readonly turnId: TurnId;
    readonly status?: "ready" | "error";
    readonly checkpointTurnCount?: number;
  }) => {
    const completedAt = at();
    return dispatch({
      type: "thread.turn.diff.complete",
      commandId: commandId("diff-complete"),
      threadId: THREAD_ID,
      turnId: options.turnId,
      completedAt,
      checkpointRef: CheckpointRef.make(`refs/t3/${options.turnId}`),
      status: options.status ?? "ready",
      files: [],
      checkpointTurnCount: options.checkpointTurnCount ?? 1,
      createdAt: completedAt,
    });
  };

  const appendActivity = (options: {
    readonly kind: string;
    readonly tone?: OrchestrationThreadActivity["tone"];
    readonly requestId?: string;
    readonly turnId?: TurnId | null;
    readonly createdAt?: string;
    readonly payload?: Record<string, unknown>;
  }) => {
    const createdAt = options.createdAt ?? at();
    commandCount += 1;
    const ordinal = commandCount;
    return dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`cmd-${options.kind}-${ordinal}`),
      threadId: THREAD_ID,
      activity: {
        id: EventId.make(`evt-activity-${ordinal}`),
        tone: options.tone ?? "approval",
        kind: options.kind,
        summary: options.kind,
        payload: {
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          ...options.payload,
        },
        turnId: options.turnId ?? null,
        createdAt,
      },
      createdAt,
    });
  };

  /** An observed event that can never form a candidate. */
  const appendNotice = () => appendActivity({ kind: "provider.notice", tone: "info" });

  const upsertPlan = (options: {
    readonly planId: string;
    readonly turnId: TurnId | null;
    readonly implementedAt?: string | null;
  }) => {
    const createdAt = at();
    return dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: commandId("plan-upsert"),
      threadId: THREAD_ID,
      proposedPlan: {
        id: options.planId as OrchestrationProposedPlanId,
        turnId: options.turnId,
        planMarkdown: "1. do the thing",
        implementedAt: options.implementedAt ?? null,
        implementationThreadId: null,
        createdAt,
        updatedAt: createdAt,
      },
      createdAt,
    });
  };

  const revert = (turnCount: number) =>
    dispatch({
      type: "thread.revert.complete",
      commandId: commandId("revert-complete"),
      threadId: THREAD_ID,
      turnCount,
      createdAt: at(),
    });

  const archiveThread = () =>
    dispatch({
      type: "thread.archive",
      commandId: commandId("thread-archive"),
      threadId: THREAD_ID,
    });

  const snoozeThread = () =>
    dispatch({
      type: "thread.snooze",
      commandId: commandId("thread-snooze"),
      threadId: THREAD_ID,
      snoozedUntil: "2099-12-31T00:00:00.000Z",
    });

  const rows = () => outbox.listByThreadId({ threadId: THREAD_ID });

  const seedCursor = (lastAppliedSequence: number) =>
    projectionState.upsert({
      projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME,
      lastAppliedSequence,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

  /**
   * One reactor lifetime. Its worker fiber dies with the scope, so two
   * sequential sessions over the same database are a genuine restart: fresh
   * in-memory trackers, cursor read back off disk.
   */
  const withReactorSession = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* makeNotificationReactor;
        yield* reactor.start();
        attached = reactor;
        yield* settle;
        const result = yield* body;
        attached = null;
        return result;
      }),
    );

  return {
    outbox,
    appliedSequence,
    lastObservedSequence,
    createProject,
    createThread,
    startTurn,
    setSession,
    completeDiff,
    appendActivity,
    appendNotice,
    upsertPlan,
    revert,
    archiveThread,
    snoozeThread,
    rows,
    seedCursor,
    withReactorSession,
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/**
 * The harness closures still carry the reactor's own requirements — a scenario
 * builds reactor instances of its own — so the body is typed against the layer's
 * services rather than `never`.
 */
type TestContext = Layer.Success<typeof testLayer>;

const withHarness = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, TestContext>) =>
  Effect.flatMap(makeHarness, body).pipe(Effect.provide(testLayer), Effect.scoped);

/** Every scenario starts from one project holding one thread. */
const seedShells = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.createProject();
    yield* h.createThread();
  });

describe("NotificationReactor", () => {
  it.effect("treats everything committed before its first boot as history", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.startTurn();
        yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
        yield* h.completeDiff({ turnId: TURN_1 });
        yield* h.setSession({ status: "ready" });

        yield* h.withReactorSession(
          Effect.gen(function* () {
            assert.deepEqual(summarize(yield* h.rows()), []);
          }),
        );
      }),
    ),
  );

  it.effect("records no candidate while a turn is only running", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendNotice();

            assert.deepEqual(summarize(yield* h.rows()), []);
          }),
        );
      }),
    ),
  );

  it.effect("records a turn-completed edge when a running turn settles", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });

            const rows = yield* h.rows();
            assert.equal(rows.length, 1);
            const row = rows[0];
            assert.exists(row);
            assert.equal(row?.identityKey, keyOf("turn-completed", TURN_1));
            assert.equal(row?.kind, "turn-completed");
            assert.equal(row?.threadId, THREAD_ID);
            assert.equal(row?.projectId, PROJECT_ID);
            assert.equal(row?.turnId, TURN_1);
            assert.equal(row?.requestId, null);
            assert.equal(row?.projectTitle, PROJECT_TITLE);
            assert.equal(row?.threadTitle, THREAD_TITLE);
            assert.equal(row?.headline, "Agent finished");
            assert.equal(row?.detail, "Review the completed task.");
            assert.equal(row?.detectionVerdict, "detected");
            assert.equal(row?.decidingGuard, "terminal-edge");
            assert.equal(row?.transportOutcome, "no-transport-connected");
            assert.equal(row?.transportName, null);
            assert.equal(row?.completedAt, null);
            assert.isAbove(row?.triggeringSequence ?? 0, 0);
          }),
        );
      }),
    ),
  );

  it.effect("coalesces a diff completion and its session teardown into one row", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records at most one terminal row per turn across repeated completions", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records turn-failed on a session error, and failure beats a late completion", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.setSession({ status: "error", lastError: "provider crashed" });

            const failed = yield* h.rows();
            assert.deepEqual(summarize(failed), [
              ["turn-failed", keyOf("turn-failed", TURN_1), "detected"],
            ]);
            assert.equal(failed[0]?.headline, "Agent failed");
            assert.equal(failed[0]?.detail, "provider crashed");

            // The two terminal kinds are mutually exclusive per turn, so a
            // completion arriving after the failure must not open a second row.
            yield* h.completeDiff({ turnId: TURN_1 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-failed", keyOf("turn-failed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records a baseline verdict for a turn it never observed running", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });

            const rows = yield* h.rows();
            assert.deepEqual(summarize(rows), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_2), "baseline"],
            ]);
            assert.equal(rows[1]?.decidingGuard, "observed-running");
          }),
        );
      }),
    ),
  );

  it.effect("records a checkpoint-less turn cleared by session teardown exactly once", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.setSession({ status: "ready" });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);

            // The carry is released by the teardown, so no later event can
            // re-fire the same turn.
            yield* h.appendNotice();
            yield* h.setSession({ status: "ready" });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records not-user-initiated for a background turn nobody asked for", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.setSession({ status: "running", activeTurnId: TURN_BACKGROUND });
            yield* h.completeDiff({ turnId: TURN_BACKGROUND });

            const rows = yield* h.rows();
            assert.deepEqual(summarize(rows), [
              ["turn-completed", keyOf("turn-completed", TURN_BACKGROUND), "not-user-initiated"],
            ]);
            assert.equal(rows[0]?.decidingGuard, "user-initiated-turn");
          }),
        );
      }),
    ),
  );

  it.effect("does not let a later user message promote a background turn", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.setSession({ status: "running", activeTurnId: TURN_BACKGROUND });
            // Steering: a user prompt lands *after* the background turn started.
            yield* h.startTurn({ text: "actually, also do this" });
            yield* h.completeDiff({ turnId: TURN_BACKGROUND });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_BACKGROUND), "not-user-initiated"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("treats a handoff seed turn as user-initiated", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            // Handoff dispatches a normal turn start under a server command id;
            // the predicate must never read the command-id namespace.
            yield* h.startTurn({
              commandId: CommandId.make("server:handoff-turn-start:9f2c"),
            });
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("keeps terminal identities distinct across consecutive turns", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_2 });
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_2), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records approval-required keyed on the raised request id", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });

            const rows = yield* h.rows();
            assert.equal(rows.length, 1);
            const row = rows[0];
            assert.equal(row?.identityKey, keyOf("approval-required", "approval-1"));
            assert.equal(row?.kind, "approval-required");
            assert.equal(row?.requestId, "approval-1");
            assert.equal(row?.turnId, TURN_1);
            assert.equal(row?.headline, "Approval needed");
            assert.equal(row?.detail, null);
            assert.equal(row?.nextPhase, "waiting_for_approval");
            assert.equal(row?.detectionVerdict, "detected");
            assert.equal(row?.decidingGuard, "attention-edge");
          }),
        );
      }),
    ),
  );

  it.effect("records user-input-required keyed on the raised request id", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendActivity({
              kind: "user-input.requested",
              tone: "info",
              requestId: "input-1",
              turnId: TURN_1,
            });

            const rows = yield* h.rows();
            assert.deepEqual(summarize(rows), [
              ["user-input-required", keyOf("user-input-required", "input-1"), "detected"],
            ]);
            assert.equal(rows[0]?.headline, "Waiting for input");
            assert.equal(rows[0]?.nextPhase, "waiting_for_input");
          }),
        );
      }),
    ),
  );

  it.effect("records both attentions even though the phase can only name one", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });
            yield* h.appendActivity({
              kind: "user-input.requested",
              tone: "info",
              requestId: "input-1",
              turnId: TURN_1,
            });

            const rows = yield* h.rows();
            assert.deepEqual(summarize(rows), [
              ["approval-required", keyOf("approval-required", "approval-1"), "detected"],
              ["user-input-required", keyOf("user-input-required", "input-1"), "detected"],
            ]);
            // The phase is priority-ordered and still says approval; the copy
            // keys on the kind, so the input edge is not mis-captioned.
            assert.equal(rows[1]?.nextPhase, "waiting_for_approval");
            assert.equal(rows[1]?.headline, "Waiting for input");
          }),
        );
      }),
    ),
  );

  it.effect("does not re-record an approval that is still pending", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "approval-1"), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("gives a re-requested approval its own row under an unchanged timestamp", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            // All three activities share one timestamp: identity must come from
            // the request id, never from a clock.
            const frozen = "2026-01-01T00:30:00.000Z";
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
              createdAt: frozen,
            });
            yield* h.appendActivity({
              kind: "approval.resolved",
              requestId: "approval-1",
              turnId: TURN_1,
              createdAt: frozen,
              payload: { decision: "accept" },
            });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-2",
              turnId: TURN_1,
              createdAt: frozen,
            });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "approval-1"), "detected"],
              ["approval-required", keyOf("approval-required", "approval-2"), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records an approval-required edge for an actionable proposed plan", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.upsertPlan({ planId: "plan-1", turnId: TURN_1 });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "plan-1"), "detected"],
            ]);

            // Re-upserting a plan that is still actionable is not a rising edge.
            yield* h.upsertPlan({ planId: "plan-1", turnId: TURN_1 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "plan-1"), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("announces a revised plan proposed while the first is still un-implemented", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.upsertPlan({ planId: "plan-1", turnId: TURN_1 });
            // Plan-mode revision: plan 2 arrives while plan 1 is still waiting,
            // so `hasPendingApproval` never falls. The plan id is the identity,
            // which is what lets the second plan through.
            yield* h.upsertPlan({ planId: "plan-2", turnId: TURN_1 });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "plan-1"), "detected"],
              ["approval-required", keyOf("approval-required", "plan-2"), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("lets a failure take the turn's slot from an audit-only completion row", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            // A completion for a turn never seen running: recorded for the audit
            // only, as `baseline`.
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_2), "baseline"],
            ]);

            // That suppressed row shares the turn's terminal slot, so it must not
            // be able to mute the real failure that follows.
            yield* h.setSession({ status: "running", activeTurnId: TURN_2 });
            yield* h.setSession({ status: "error", lastError: "provider crashed" });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-failed", keyOf("turn-failed", TURN_2), "detected"],
            ]);
            const superseded = yield* h.outbox.getByIdentityKey({
              identityKey: keyOf("turn-completed", TURN_2),
            });
            assert.isTrue(Option.isNone(superseded));
          }),
        );
      }),
    ),
  );

  it.effect("still detects an approval raised on a snoozed thread", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.snoozeThread();
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });

            assert.deepEqual(summarize(yield* h.rows()), [
              ["approval-required", keyOf("approval-required", "approval-1"), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("records nothing for an archived thread", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.archiveThread();
            yield* h.completeDiff({ turnId: TURN_1 });

            assert.deepEqual(summarize(yield* h.rows()), []);
          }),
        );
      }),
    ),
  );

  it.effect("cannot resurrect an already recorded turn through a revert", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1, checkpointTurnCount: 1 });
            yield* h.setSession({ status: "ready" });
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_2 });
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });
            yield* h.setSession({ status: "ready" });

            // Revert regresses latestTurn to the already-terminal TURN_1. That
            // is not a completion, so it must form no candidate at all.
            yield* h.revert(1);
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_2), "detected"],
            ]);

            // The rerun mints a fresh TurnId, so the terminal unique index
            // cannot swallow it.
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_3 });
            yield* h.completeDiff({ turnId: TURN_3, checkpointTurnCount: 2 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_2), "detected"],
              ["turn-completed", keyOf("turn-completed", TURN_3), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("resumes across a restart and records the completion exactly once", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);

        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            assert.deepEqual(summarize(yield* h.rows()), []);
          }),
        );

        // A fresh reactor over the same database: cursor off disk, trackers
        // primed from the shells, so the in-flight turn is still known.
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.completeDiff({ turnId: TURN_1 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );

        // A third boot must not re-announce what the outbox already holds.
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.completeDiff({ turnId: TURN_1 });
            assert.deepEqual(summarize(yield* h.rows()), [
              ["turn-completed", keyOf("turn-completed", TURN_1), "detected"],
            ]);
          }),
        );
      }),
    ),
  );

  it.effect("rewrites nothing when replayed from sequence 0", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        const before = yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.appendActivity({
              kind: "approval.requested",
              requestId: "approval-1",
              turnId: TURN_1,
            });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });
            return yield* h.rows();
          }),
        );
        assert.equal(before.length, 3);

        yield* h.seedCursor(0);
        const after = yield* h.withReactorSession(h.rows());
        assert.deepEqual(after, before);
      }),
    ),
  );

  it.effect("advances its durable cursor to the last observed event", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });

            assert.equal(yield* h.appliedSequence, yield* h.lastObservedSequence);
          }),
        );
      }),
    ),
  );

  it.effect("records a verdict and a deciding guard on every candidate it sees", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.setSession({ status: "running", activeTurnId: TURN_BACKGROUND });
            yield* h.completeDiff({ turnId: TURN_BACKGROUND });
            yield* h.setSession({ status: "ready" });
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });

            const rows = yield* h.rows();
            assert.deepEqual(
              rows.map((row) => [row.detectionVerdict, row.decidingGuard] as const),
              [
                ["not-user-initiated", "user-initiated-turn"],
                ["baseline", "observed-running"],
              ],
            );
            for (const row of rows) {
              assert.equal(row.transportOutcome, "no-transport-connected");
              assert.equal(row.completedAt, null);
            }
          }),
        );
      }),
    ),
  );

  it.effect("exposes decided edges by cursor and settles the first outcome reported", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            // A suppressed candidate: recorded, but never handed to a transport.
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });

            const decided = yield* h.outbox.listDecidedEdgesAfterSequence({
              afterSequence: 0,
              limit: 100,
            });
            assert.deepEqual(
              decided.map((row) => row.identityKey),
              [keyOf("turn-completed", TURN_1)],
            );

            const edge = decided[0];
            assert.exists(edge);
            const identityKey = edge?.identityKey ?? "";
            yield* h.outbox.completeTransportOutcome({
              identityKey,
              transportOutcome: "shown",
              transportName: "desktop",
              completedAt: "2026-02-01T00:00:00.000Z",
            });
            // Second report loses: the first outcome is the record.
            yield* h.outbox.completeTransportOutcome({
              identityKey,
              transportOutcome: "suppressed:focused",
              transportName: "web",
              completedAt: "2026-02-01T00:01:00.000Z",
            });

            const settled = yield* h.outbox.getByIdentityKey({ identityKey });
            assert.equal(Option.getOrNull(settled)?.transportOutcome, "shown");
            assert.equal(Option.getOrNull(settled)?.transportName, "desktop");
            assert.equal(Option.getOrNull(settled)?.completedAt, "2026-02-01T00:00:00.000Z");

            // Cursor-ranged reads let a reconnecting transport resume.
            const remaining = yield* h.outbox.listDecidedEdgesAfterSequence({
              afterSequence: edge?.triggeringSequence ?? 0,
              limit: 100,
            });
            assert.deepEqual(remaining, []);
          }),
        );
      }),
    ),
  );

  it.effect("hands transports the detected edges only, never the suppressed ones", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        // Scoped: the subscription lives for this scenario, like a transport's.
        const bus = yield* NotificationEdgeBus;
        // Subscribed before anything happens: the feed buffers from here on, so
        // ordering is the assertion rather than timing.
        const edges = yield* bus.subscribe;

        yield* seedShells(h);
        yield* h.withReactorSession(
          Effect.gen(function* () {
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
            yield* h.completeDiff({ turnId: TURN_1 });
            yield* h.setSession({ status: "ready" });
            // Recorded as `baseline`, and that row must stay off the bus.
            yield* h.completeDiff({ turnId: TURN_2, checkpointTurnCount: 2 });
            yield* h.startTurn();
            yield* h.setSession({ status: "running", activeTurnId: TURN_3 });
            yield* h.completeDiff({ turnId: TURN_3, checkpointTurnCount: 2 });
          }),
        );

        // Had the suppressed candidate been published it would be the second of
        // these two, so the identity keys are a complete check without a sleep.
        const published = yield* Stream.runCollect(Stream.take(edges, 2));
        assert.deepEqual(
          [...published].map((edge) => edge.identityKey),
          [keyOf("turn-completed", TURN_1), keyOf("turn-completed", TURN_3)],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("emits a sampled decision span for the edge it decides", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const spans = yield* collectSpans(
          Effect.gen(function* () {
            yield* seedShells(h);
            yield* h.withReactorSession(
              Effect.gen(function* () {
                yield* h.startTurn();
                yield* h.setSession({ status: "running", activeTurnId: TURN_1 });
                yield* h.completeDiff({ turnId: TURN_1 });
              }),
            );
          }),
        );

        const decisions = spans.filter((span) => span.name === "notifications.decide.edge");
        assert.equal(decisions.length, 1);
        const span = decisions[0];
        assert.isTrue(span?.sampled);
        assert.equal(span?.attributes["decision.candidate"], "notifications.turn-completed");
        assert.equal(span?.attributes["decision.verdict"], "fire");
        assert.equal(span?.attributes["notifications.detection_verdict"], "detected");
        assert.equal(span?.attributes["notifications.deciding_guard"], "terminal-edge");
        assert.equal(
          span?.attributes["notifications.identity_key"],
          keyOf("turn-completed", TURN_1),
        );
        assert.equal(
          span?.attributes["notifications.triggering_event_type"],
          "thread.turn-diff-completed",
        );
        assert.equal(span?.attributes["orchestration.thread_id"], THREAD_ID);
        assert.equal(span?.attributes["orchestration.turn_id"], TURN_1);
        assert.isString(span?.attributes["orchestration.correlation_id"]);
        assert.isString(span?.attributes["decision.reason"]);
      }),
    ),
  );
});
