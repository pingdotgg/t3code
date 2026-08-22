import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const recordedStatements: Array<string> = [];

const RecordingSqlitePersistenceMemory = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return new Proxy(sql, {
      apply(target, thisArg, args: ReadonlyArray<unknown>) {
        const [strings] = args;
        if (Array.isArray(strings) && "raw" in strings) {
          recordedStatements.push(strings.join("?"));
        }
        return Reflect.apply(target as never, thisArg, args as never);
      },
    });
  }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const makeTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(RecordingSqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const TestLayer = makeTestLayer("t3-projection-summary-cost-test-");
const RebuildTestLayer = Layer.fresh(makeTestLayer("t3-projection-summary-rebuild-test-"));

const THREAD_COLLECTION_TABLES = [
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_pending_approvals",
] as const;

const threadCollectionScans = (statements: ReadonlyArray<string>) =>
  statements.filter((statement) => {
    const normalized = statement.replace(/\s+/g, " ").trim().toLowerCase();
    return (
      normalized.includes("select") &&
      THREAD_COLLECTION_TABLES.some((table) => normalized.includes(`from ${table} where thread_id`))
    );
  });

const threadCollectionScanTables = (statements: ReadonlyArray<string>) =>
  threadCollectionScans(statements).flatMap((statement) => {
    const normalized = statement.replace(/\s+/g, " ").trim().toLowerCase();
    return THREAD_COLLECTION_TABLES.filter((table) =>
      normalized.includes(`from ${table} where thread_id`),
    );
  });

const projectionStateWrites = (statements: ReadonlyArray<string>) =>
  statements.filter((statement) =>
    statement.replace(/\s+/g, " ").trim().toLowerCase().includes("insert into projection_state"),
  );

const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

const at = (seconds: number) =>
  `2026-08-09T12:00:${String(seconds).padStart(2, "0")}.000Z` as const;

type EventInput<Type extends OrchestrationEvent["type"]> = Omit<
  Extract<OrchestrationEvent, { readonly type: Type }>,
  "sequence"
>;
type AnyEventInput = {
  [Type in OrchestrationEvent["type"]]: EventInput<Type>;
}[OrchestrationEvent["type"]];
type ThreadActivity = EventInput<"thread.activity-appended">["payload"]["activity"];

interface ShellRow {
  readonly latestTurnId: string | null;
  readonly updatedAt: string;
  readonly latestUserMessageAt: string | null;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasActionableProposedPlan: number;
}

interface TargetProjectionExpectation {
  readonly scanTables: ReadonlyArray<(typeof THREAD_COLLECTION_TABLES)[number]>;
  readonly updatedAt: string;
  readonly summaries: ReturnType<typeof shellSummaries>;
  readonly latestTurnId?: TurnId | null;
}

const eventIdentity = (slug: string, label: string, occurredAt: string) => ({
  eventId: EventId.make(`evt-${slug}-${label}`),
  occurredAt,
  commandId: CommandId.make(`cmd-${slug}-${label}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`cmd-${slug}-${label}`),
  metadata: {},
});

const projectCreatedEvent = (input: {
  readonly slug: string;
  readonly projectId: ProjectId;
  readonly occurredAt: string;
}): EventInput<"project.created"> => ({
  ...eventIdentity(input.slug, "project", input.occurredAt),
  type: "project.created",
  aggregateKind: "project",
  aggregateId: input.projectId,
  payload: {
    projectId: input.projectId,
    title: "Projection summary cost",
    workspaceRoot: `/tmp/${input.slug}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  },
});

const threadCreatedEvent = (input: {
  readonly slug: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly occurredAt: string;
}): EventInput<"thread.created"> => ({
  ...eventIdentity(input.slug, "thread", input.occurredAt),
  type: "thread.created",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: {
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Projection summary cost",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  },
});

const messageEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly occurredAt: string;
  readonly createdAt?: string;
}): EventInput<"thread.message-sent"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.message-sent",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: {
    threadId: input.threadId,
    messageId: input.messageId,
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    streaming: input.streaming,
    createdAt: input.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  },
});

const activityEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly occurredAt: string;
  readonly activity: ThreadActivity;
}): EventInput<"thread.activity-appended"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.activity-appended",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: { threadId: input.threadId, activity: input.activity },
});

const proposedPlanEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly planId: string;
  readonly turnId: TurnId | null;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly implementedAt: string | null;
}): EventInput<"thread.proposed-plan-upserted"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.proposed-plan-upserted",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: {
    threadId: input.threadId,
    proposedPlan: {
      id: input.planId,
      turnId: input.turnId,
      planMarkdown: `# ${input.planId}`,
      implementedAt: input.implementedAt,
      implementationThreadId: null,
      createdAt: input.createdAt,
      updatedAt: input.occurredAt,
    },
  },
});

const sessionEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly occurredAt: string;
}): EventInput<"thread.session-set"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.session-set",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: {
    threadId: input.threadId,
    session: {
      threadId: input.threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: input.turnId,
      lastError: null,
      updatedAt: input.occurredAt,
    },
  },
});

const approvalResponseEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly occurredAt: string;
}): EventInput<"thread.approval-response-requested"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.approval-response-requested",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  metadata: { requestId: input.requestId },
  payload: {
    threadId: input.threadId,
    requestId: input.requestId,
    decision: "accept",
    createdAt: input.occurredAt,
  },
});

const turnDiffEvent = (input: {
  readonly slug: string;
  readonly label: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly turnCount: number;
  readonly occurredAt: string;
}): EventInput<"thread.turn-diff-completed"> => ({
  ...eventIdentity(input.slug, input.label, input.occurredAt),
  type: "thread.turn-diff-completed",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: {
    threadId: input.threadId,
    turnId: input.turnId,
    checkpointTurnCount: input.turnCount,
    checkpointRef: CheckpointRef.make(
      `refs/t3/checkpoints/${input.threadId}/turn/${input.turnCount}`,
    ),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: input.occurredAt,
  },
});

const revertedEvent = (input: {
  readonly slug: string;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly occurredAt: string;
}): EventInput<"thread.reverted"> => ({
  ...eventIdentity(input.slug, "reverted", input.occurredAt),
  type: "thread.reverted",
  aggregateKind: "thread",
  aggregateId: input.threadId,
  payload: { threadId: input.threadId, turnCount: input.turnCount },
});

const readShellRow = Effect.fn("readShellRow")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ShellRow>`
    SELECT
      latest_turn_id AS "latestTurnId",
      updated_at AS "updatedAt",
      latest_user_message_at AS "latestUserMessageAt",
      pending_approval_count AS "pendingApprovalCount",
      pending_user_input_count AS "pendingUserInputCount",
      has_actionable_proposed_plan AS "hasActionableProposedPlan"
    FROM projection_threads
    WHERE thread_id = ${threadId}
  `;
  assert.lengthOf(rows, 1);
  return rows[0]!;
});

const shellSummaries = (row: ShellRow) => ({
  latestUserMessageAt: row.latestUserMessageAt,
  pendingApprovalCount: row.pendingApprovalCount,
  pendingUserInputCount: row.pendingUserInputCount,
  hasActionableProposedPlan: row.hasActionableProposedPlan,
});

const setShellSummaries = Effect.fn("setShellSummaries")(function* (
  threadId: ThreadId,
  fields: ReturnType<typeof shellSummaries>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_threads
    SET
      latest_user_message_at = ${fields.latestUserMessageAt},
      pending_approval_count = ${fields.pendingApprovalCount},
      pending_user_input_count = ${fields.pendingUserInputCount},
      has_actionable_proposed_plan = ${fields.hasActionableProposedPlan}
    WHERE thread_id = ${threadId}
  `;
});

const assertTargetProjection = Effect.fn("assertTargetProjection")(function* (
  input: {
    readonly threadId: ThreadId;
    readonly statements: ReadonlyArray<string>;
  } & TargetProjectionExpectation,
) {
  assert.deepEqual(threadCollectionScanTables(input.statements), input.scanTables);
  const row = yield* readShellRow(input.threadId);
  assert.deepEqual(shellSummaries(row), input.summaries);
  assert.equal(row.updatedAt, input.updatedAt);
  if (input.latestTurnId !== undefined) {
    assert.equal(row.latestTurnId, input.latestTurnId);
  }
  return row;
});

const seedThread = Effect.fn("seedThread")(function* (input: {
  readonly slug: string;
  readonly historyLength: number;
}) {
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const eventStore = yield* OrchestrationEventStore;
  const appendAndProject = (event: AnyEventInput) =>
    eventStore
      .append(event)
      .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
  const recordProjectionResult = (event: AnyEventInput) =>
    Effect.gen(function* () {
      const savedEvent = yield* eventStore.append(event);
      recordedStatements.length = 0;
      yield* projectionPipeline.projectEvent(savedEvent);
      const statements = [...recordedStatements];
      recordedStatements.length = 0;
      return { sequence: savedEvent.sequence, statements };
    });
  const recordProjection = (event: AnyEventInput) =>
    recordProjectionResult(event).pipe(Effect.map(({ statements }) => statements));
  const projectAndAssert = (event: AnyEventInput, expected: TargetProjectionExpectation) =>
    recordProjection(event).pipe(
      Effect.flatMap((statements) => assertTargetProjection({ threadId, statements, ...expected })),
    );

  const projectId = ProjectId.make(`project-${input.slug}`);
  const threadId = ThreadId.make(`thread-${input.slug}`);

  yield* appendAndProject(projectCreatedEvent({ slug: input.slug, projectId, occurredAt: at(0) }));
  yield* appendAndProject(
    threadCreatedEvent({ slug: input.slug, projectId, threadId, occurredAt: at(1) }),
  );

  yield* Effect.forEach(
    Array.from({ length: input.historyLength }, (_unused, index) => index),
    (index) =>
      appendAndProject(
        activityEvent({
          slug: input.slug,
          label: `history-${index}`,
          threadId,
          occurredAt: at(2),
          activity: {
            id: EventId.make(`activity-${input.slug}-history-${index}`),
            tone: "info",
            kind: "tool.call",
            summary: `History activity ${index}`,
            payload: { index },
            turnId: null,
            createdAt: at(2),
          },
        }),
      ),
    { concurrency: 1, discard: true },
  );

  return {
    appendAndProject,
    projectAndAssert,
    projectId,
    recordProjection,
    recordProjectionResult,
    threadId,
  };
});

it.layer(TestLayer)("OrchestrationProjectionPipeline shell-summary cost", (it) => {
  const measureAssistantDelta = Effect.fn("measureAssistantDelta")(function* (input: {
    readonly slug: string;
    readonly historyLength: number;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const { appendAndProject, recordProjectionResult, threadId } = yield* seedThread(input);
    const messageId = MessageId.make(`message-${input.slug}-assistant`);

    yield* appendAndProject(
      messageEvent({
        slug: input.slug,
        label: "assistant-initial",
        threadId,
        messageId,
        role: "assistant",
        text: "First ",
        turnId: null,
        streaming: true,
        occurredAt: at(3),
      }),
    );

    const { sequence, statements } = yield* recordProjectionResult(
      messageEvent({
        slug: input.slug,
        label: "assistant-delta",
        threadId,
        messageId,
        role: "assistant",
        text: "delta",
        turnId: null,
        streaming: true,
        occurredAt: at(4),
      }),
    );

    recordedStatements.length = 0;
    const messageRows = yield* sql<{
      readonly messageId: string;
      readonly text: string;
      readonly isStreaming: number;
      readonly updatedAt: string;
    }>`
      SELECT
        message_id AS "messageId",
        text,
        is_streaming AS "isStreaming",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `;
    const threadRows = yield* sql<{ readonly updatedAt: string }>`
      SELECT updated_at AS "updatedAt"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    const projectionStateRows = yield* sql<{
      readonly projector: string;
      readonly lastAppliedSequence: number;
      readonly updatedAt: string;
    }>`
      SELECT
        projector,
        last_applied_sequence AS "lastAppliedSequence",
        updated_at AS "updatedAt"
      FROM projection_state
      ORDER BY projector ASC
    `;
    recordedStatements.length = 0;

    return { messageRows, projectionStateRows, sequence, statements, threadRows };
  });

  const measureTaskProgress = Effect.fn("measureTaskProgress")(function* (input: {
    readonly slug: string;
    readonly historyLength: number;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const { appendAndProject, recordProjectionResult, threadId } = yield* seedThread(input);
    const activityId = EventId.make(`task-progress:${threadId}:task-1`);

    yield* appendAndProject(
      activityEvent({
        slug: input.slug,
        label: "progress-initial",
        threadId,
        occurredAt: at(3),
        activity: {
          id: activityId,
          tone: "info",
          kind: "task.progress",
          summary: "Queued",
          payload: { taskId: "task-1", status: "queued" },
          turnId: null,
          createdAt: at(3),
        },
      }),
    );

    const { sequence, statements } = yield* recordProjectionResult(
      activityEvent({
        slug: input.slug,
        label: "progress-update",
        threadId,
        occurredAt: at(4),
        activity: {
          id: activityId,
          tone: "info",
          kind: "task.progress",
          summary: "Running checks",
          payload: { taskId: "task-1", status: "running", summary: "Running checks" },
          turnId: null,
          createdAt: at(4),
        },
      }),
    );

    recordedStatements.length = 0;
    const activityRows = yield* sql<{
      readonly activityId: string;
      readonly kind: string;
      readonly summary: string;
      readonly status: string;
      readonly createdAt: string;
    }>`
      SELECT
        activity_id AS "activityId",
        kind,
        summary,
        json_extract(payload_json, '$.status') AS status,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND activity_id = ${activityId}
    `;
    const threadRows = yield* sql<{ readonly updatedAt: string }>`
      SELECT updated_at AS "updatedAt"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    const projectionStateRows = yield* sql<{
      readonly projector: string;
      readonly lastAppliedSequence: number;
      readonly updatedAt: string;
    }>`
      SELECT
        projector,
        last_applied_sequence AS "lastAppliedSequence",
        updated_at AS "updatedAt"
      FROM projection_state
      ORDER BY projector ASC
    `;
    recordedStatements.length = 0;

    return { activityRows, projectionStateRows, sequence, statements, threadRows };
  });

  it.effect("projects assistant deltas without thread-wide shell-summary scans", () =>
    Effect.gen(function* () {
      const shallow = yield* measureAssistantDelta({
        slug: "assistant-shallow",
        historyLength: 4,
      });
      const deep = yield* measureAssistantDelta({
        slug: "assistant-deep",
        historyLength: 200,
      });

      assert.deepEqual(deep.messageRows, [
        {
          messageId: "message-assistant-deep-assistant",
          text: "First delta",
          isStreaming: 1,
          updatedAt: at(4),
        },
      ]);
      assert.deepEqual(deep.threadRows, [{ updatedAt: at(4) }]);
      assert.equal(deep.statements.length, shallow.statements.length);
      assert.equal(shallow.statements.length, 6);
      for (const measurement of [shallow, deep]) {
        assert.deepEqual(
          measurement.projectionStateRows,
          [...PROJECTOR_NAMES].sort().map((projector) => ({
            projector,
            lastAppliedSequence: measurement.sequence,
            updatedAt: at(4),
          })),
        );
        assert.lengthOf(
          projectionStateWrites(measurement.statements),
          1,
          `assistant deltas must advance every projector cursor with one batched projection_state write; got ${projectionStateWrites(measurement.statements).length}`,
        );
      }
      assert.deepEqual(
        {
          shallow: threadCollectionScans(shallow.statements),
          deep: threadCollectionScans(deep.statements),
        },
        { shallow: [], deep: [] },
        `assistant deltas must not reload thread-wide collections (statement counts: shallow=${shallow.statements.length}, deep=${deep.statements.length})`,
      );
    }),
  );

  it.effect("projects task progress updates without thread-wide shell-summary scans", () =>
    Effect.gen(function* () {
      const shallow = yield* measureTaskProgress({
        slug: "progress-shallow",
        historyLength: 4,
      });
      const deep = yield* measureTaskProgress({
        slug: "progress-deep",
        historyLength: 200,
      });

      assert.deepEqual(deep.activityRows, [
        {
          activityId: "task-progress:thread-progress-deep:task-1",
          kind: "task.progress",
          summary: "Running checks",
          status: "running",
          createdAt: at(4),
        },
      ]);
      assert.deepEqual(deep.threadRows, [{ updatedAt: at(4) }]);
      assert.equal(deep.statements.length, shallow.statements.length);
      assert.equal(shallow.statements.length, 5);
      for (const measurement of [shallow, deep]) {
        assert.deepEqual(
          measurement.projectionStateRows,
          [...PROJECTOR_NAMES].sort().map((projector) => ({
            projector,
            lastAppliedSequence: measurement.sequence,
            updatedAt: at(4),
          })),
        );
        assert.lengthOf(projectionStateWrites(measurement.statements), 1);
      }
      assert.deepEqual(
        {
          shallow: threadCollectionScans(shallow.statements),
          deep: threadCollectionScans(deep.statements),
        },
        { shallow: [], deep: [] },
        `task progress updates must not reload thread-wide collections (statement counts: shallow=${shallow.statements.length}, deep=${deep.statements.length})`,
      );
    }),
  );

  it.effect("refreshes only the shell-summary field invalidated by each event", () =>
    Effect.gen(function* () {
      const approval = yield* seedThread({ slug: "field-approval", historyLength: 0 });
      const approvalRequestId = ApprovalRequestId.make("approval-field-1");
      const approvalPreserved = {
        latestUserMessageAt: at(1),
        pendingApprovalCount: 0,
        pendingUserInputCount: 7,
        hasActionableProposedPlan: 1,
      };
      yield* setShellSummaries(approval.threadId, approvalPreserved);

      yield* approval.projectAndAssert(
        activityEvent({
          slug: "field-approval",
          label: "approval-requested",
          threadId: approval.threadId,
          occurredAt: at(3),
          activity: {
            id: EventId.make("activity-field-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: approvalRequestId, requestKind: "command" },
            turnId: null,
            createdAt: at(3),
          },
        }),
        {
          scanTables: ["projection_pending_approvals"],
          updatedAt: at(3),
          summaries: { ...approvalPreserved, pendingApprovalCount: 1 },
        },
      );

      yield* approval.projectAndAssert(
        approvalResponseEvent({
          slug: "field-approval",
          label: "approval-response",
          threadId: approval.threadId,
          requestId: approvalRequestId,
          occurredAt: at(4),
        }),
        {
          scanTables: ["projection_pending_approvals"],
          updatedAt: at(4),
          summaries: approvalPreserved,
        },
      );

      const userInput = yield* seedThread({ slug: "field-user-input", historyLength: 0 });
      const userInputRequestId = "user-input-field-1";
      const userInputPreserved = {
        latestUserMessageAt: at(1),
        pendingApprovalCount: 6,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 1,
      };
      yield* setShellSummaries(userInput.threadId, userInputPreserved);

      yield* userInput.projectAndAssert(
        activityEvent({
          slug: "field-user-input",
          label: "user-input-requested",
          threadId: userInput.threadId,
          occurredAt: at(3),
          activity: {
            id: EventId.make("activity-field-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: { requestId: userInputRequestId },
            turnId: null,
            createdAt: at(3),
          },
        }),
        {
          scanTables: ["projection_thread_activities"],
          updatedAt: at(3),
          summaries: { ...userInputPreserved, pendingUserInputCount: 1 },
        },
      );

      yield* userInput.projectAndAssert(
        activityEvent({
          slug: "field-user-input",
          label: "user-input-resolved",
          threadId: userInput.threadId,
          occurredAt: at(4),
          activity: {
            id: EventId.make("activity-field-user-input-resolved"),
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input resolved",
            payload: { requestId: userInputRequestId },
            turnId: null,
            createdAt: at(4),
          },
        }),
        {
          scanTables: ["projection_thread_activities"],
          updatedAt: at(4),
          summaries: userInputPreserved,
        },
      );

      const plans = yield* seedThread({ slug: "field-plans", historyLength: 0 });
      const turnOne = TurnId.make("turn-field-plan-1");
      const turnTwo = TurnId.make("turn-field-plan-2");
      const planPreserved = {
        latestUserMessageAt: at(1),
        pendingApprovalCount: 6,
        pendingUserInputCount: 7,
        hasActionableProposedPlan: 0,
      };
      yield* setShellSummaries(plans.threadId, planPreserved);

      yield* plans.projectAndAssert(
        proposedPlanEvent({
          slug: "field-plans",
          label: "plan-one-actionable",
          threadId: plans.threadId,
          planId: "plan-field-1",
          turnId: turnOne,
          occurredAt: at(3),
          createdAt: at(3),
          implementedAt: null,
        }),
        {
          scanTables: ["projection_thread_proposed_plans"],
          updatedAt: at(3),
          summaries: { ...planPreserved, hasActionableProposedPlan: 1 },
        },
      );

      yield* plans.projectAndAssert(
        proposedPlanEvent({
          slug: "field-plans",
          label: "plan-one-implemented",
          threadId: plans.threadId,
          planId: "plan-field-1",
          turnId: turnOne,
          occurredAt: at(4),
          createdAt: at(3),
          implementedAt: at(4),
        }),
        {
          scanTables: ["projection_thread_proposed_plans"],
          updatedAt: at(4),
          summaries: planPreserved,
        },
      );

      yield* plans.projectAndAssert(
        proposedPlanEvent({
          slug: "field-plans",
          label: "plan-two-actionable",
          threadId: plans.threadId,
          planId: "plan-field-2",
          turnId: turnTwo,
          occurredAt: at(5),
          createdAt: at(5),
          implementedAt: null,
        }),
        {
          scanTables: ["projection_thread_proposed_plans"],
          updatedAt: at(5),
          summaries: { ...planPreserved, hasActionableProposedPlan: 1 },
        },
      );

      yield* plans.projectAndAssert(
        sessionEvent({
          slug: "field-plans",
          label: "latest-turn-one",
          threadId: plans.threadId,
          turnId: turnOne,
          occurredAt: at(6),
        }),
        {
          scanTables: ["projection_thread_proposed_plans"],
          updatedAt: at(6),
          summaries: planPreserved,
          latestTurnId: turnOne,
        },
      );

      yield* plans.projectAndAssert(
        sessionEvent({
          slug: "field-plans",
          label: "latest-turn-two",
          threadId: plans.threadId,
          turnId: turnTwo,
          occurredAt: at(7),
        }),
        {
          scanTables: ["projection_thread_proposed_plans"],
          updatedAt: at(7),
          summaries: { ...planPreserved, hasActionableProposedPlan: 1 },
          latestTurnId: turnTwo,
        },
      );

      const reusedMessage = yield* seedThread({ slug: "field-message", historyLength: 0 });
      const reusedMessageId = MessageId.make("message-field-reused-user");
      yield* reusedMessage.appendAndProject(
        messageEvent({
          slug: "field-message",
          label: "user-original",
          threadId: reusedMessage.threadId,
          messageId: reusedMessageId,
          role: "user",
          text: "Original",
          turnId: null,
          streaming: false,
          occurredAt: at(2),
        }),
      );
      const messagePreserved = {
        latestUserMessageAt: at(2),
        pendingApprovalCount: 4,
        pendingUserInputCount: 5,
        hasActionableProposedPlan: 1,
      };
      yield* setShellSummaries(reusedMessage.threadId, messagePreserved);

      const statements = yield* reusedMessage.recordProjection(
        messageEvent({
          slug: "field-message",
          label: "user-reused",
          threadId: reusedMessage.threadId,
          messageId: reusedMessageId,
          role: "user",
          text: "Updated",
          turnId: null,
          streaming: false,
          occurredAt: at(8),
        }),
      );
      yield* assertTargetProjection({
        threadId: reusedMessage.threadId,
        statements,
        scanTables: [],
        updatedAt: at(8),
        summaries: messagePreserved,
      });

      const sql = yield* SqlClient.SqlClient;
      const messageRows = yield* sql<{
        readonly text: string;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT text, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${reusedMessageId}
      `;
      assert.deepEqual(messageRows, [{ text: "Updated", createdAt: at(2), updatedAt: at(8) }]);
    }),
  );
});

it.layer(RebuildTestLayer)("OrchestrationProjectionPipeline shell-summary rebuilds", (it) => {
  it.effect("keeps the first thread and role bound to a reused message identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const fixture = yield* seedThread({ slug: "message-identity", historyLength: 0 });
      const otherThreadId = ThreadId.make("thread-message-identity-other");
      const sharedMessageId = MessageId.make("message-identity-shared");

      yield* fixture.appendAndProject(
        threadCreatedEvent({
          slug: "message-identity-other",
          projectId: fixture.projectId,
          threadId: otherThreadId,
          occurredAt: at(2),
        }),
      );
      yield* fixture.appendAndProject(
        messageEvent({
          slug: "message-identity",
          label: "user-original",
          threadId: fixture.threadId,
          messageId: sharedMessageId,
          role: "user",
          text: "Original user message",
          turnId: null,
          streaming: false,
          occurredAt: at(3),
        }),
      );
      yield* fixture.appendAndProject(
        messageEvent({
          slug: "message-identity-other",
          label: "assistant-conflict",
          threadId: otherThreadId,
          messageId: sharedMessageId,
          role: "assistant",
          text: "Conflicting assistant delta",
          turnId: null,
          streaming: true,
          occurredAt: at(4),
        }),
      );

      const readMessages = () =>
        sql<{
          readonly messageId: string;
          readonly threadId: string;
          readonly role: string;
          readonly text: string;
          readonly isStreaming: number;
          readonly createdAt: string;
          readonly updatedAt: string;
        }>`
          SELECT
            message_id AS "messageId",
            thread_id AS "threadId",
            role,
            text,
            is_streaming AS "isStreaming",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM projection_thread_messages
          WHERE message_id = ${sharedMessageId}
          ORDER BY thread_id ASC
        `;
      const expectedMessages = [
        {
          messageId: sharedMessageId,
          threadId: fixture.threadId,
          role: "user",
          text: "Original user message",
          isStreaming: 0,
          createdAt: at(3),
          updatedAt: at(3),
        },
      ];
      const expectedShells = {
        first: {
          latestTurnId: null,
          updatedAt: at(3),
          latestUserMessageAt: at(3),
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
        },
        other: {
          latestTurnId: null,
          updatedAt: at(4),
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
        },
      } satisfies Record<string, ShellRow>;

      const liveMessages = yield* readMessages();
      const liveShells = {
        first: yield* readShellRow(fixture.threadId),
        other: yield* readShellRow(otherThreadId),
      };
      assert.deepEqual(liveMessages, expectedMessages);
      assert.deepEqual(liveShells, expectedShells);

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_pending_approvals`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      recordedStatements.length = 0;
      yield* projectionPipeline.bootstrap;
      recordedStatements.length = 0;

      const rebuiltMessages = yield* readMessages();
      const rebuiltShells = {
        first: yield* readShellRow(fixture.threadId),
        other: yield* readShellRow(otherThreadId),
      };
      assert.deepEqual(rebuiltMessages, expectedMessages);
      assert.deepEqual(rebuiltMessages, liveMessages);
      assert.deepEqual(rebuiltShells, expectedShells);
      assert.deepEqual(rebuiltShells, liveShells);
    }),
  );

  it.effect("keeps first ownership bindings across identity conflicts and replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const fixture = yield* seedThread({ slug: "owner-identity", historyLength: 0 });
      const otherThreadId = ThreadId.make("thread-owner-identity-other");
      const sharedActivityId = EventId.make("activity-owner-identity-shared");
      const sharedPlanId = "plan-owner-identity-shared";
      const sharedApprovalRequestId = ApprovalRequestId.make("approval-owner-identity-shared");
      const firstPlanTurnId = TurnId.make("turn-owner-identity-first-plan");
      const conflictingPlanTurnId = TurnId.make("turn-owner-identity-conflicting-plan");

      yield* fixture.appendAndProject(
        threadCreatedEvent({
          slug: "owner-identity-other",
          projectId: fixture.projectId,
          threadId: otherThreadId,
          occurredAt: at(2),
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "owner-identity",
          label: "user-input-original",
          threadId: fixture.threadId,
          occurredAt: at(3),
          activity: {
            id: sharedActivityId,
            tone: "info",
            kind: "user-input.requested",
            summary: "Original user input request",
            payload: { requestId: "user-input-owner-identity" },
            turnId: null,
            createdAt: at(3),
          },
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "owner-identity-other",
          label: "task-progress-conflict",
          threadId: otherThreadId,
          occurredAt: at(4),
          activity: {
            id: sharedActivityId,
            tone: "info",
            kind: "task.progress",
            summary: "Conflicting task progress",
            payload: { taskId: "owner-identity", status: "running" },
            turnId: null,
            createdAt: at(4),
          },
        }),
      );
      assert.deepEqual(yield* readShellRow(otherThreadId), {
        latestTurnId: null,
        updatedAt: at(4),
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
      });

      yield* fixture.appendAndProject(
        proposedPlanEvent({
          slug: "owner-identity",
          label: "plan-original",
          threadId: fixture.threadId,
          planId: sharedPlanId,
          turnId: firstPlanTurnId,
          occurredAt: at(5),
          createdAt: at(5),
          implementedAt: null,
        }),
      );
      yield* fixture.appendAndProject(
        proposedPlanEvent({
          slug: "owner-identity-other",
          label: "plan-conflict",
          threadId: otherThreadId,
          planId: sharedPlanId,
          turnId: conflictingPlanTurnId,
          occurredAt: at(6),
          createdAt: at(6),
          implementedAt: at(6),
        }),
      );
      assert.deepEqual(yield* readShellRow(otherThreadId), {
        latestTurnId: null,
        updatedAt: at(6),
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
      });

      yield* fixture.appendAndProject(
        activityEvent({
          slug: "owner-identity",
          label: "approval-original",
          threadId: fixture.threadId,
          occurredAt: at(7),
          activity: {
            id: EventId.make("activity-owner-identity-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Original approval request",
            payload: { requestId: sharedApprovalRequestId, requestKind: "command" },
            turnId: null,
            createdAt: at(7),
          },
        }),
      );
      const { sequence: lastConflictSequence } = yield* fixture.recordProjectionResult(
        approvalResponseEvent({
          slug: "owner-identity-other",
          label: "approval-response-conflict",
          threadId: otherThreadId,
          requestId: sharedApprovalRequestId,
          occurredAt: at(8),
        }),
      );

      const readOwnerRows = Effect.fn("readOwnerRows")(function* () {
        return {
          activities: yield* sql<{
            readonly activityId: string;
            readonly threadId: string;
            readonly kind: string;
            readonly summary: string;
            readonly requestId: string;
            readonly createdAt: string;
          }>`
            SELECT
              activity_id AS "activityId",
              thread_id AS "threadId",
              kind,
              summary,
              json_extract(payload_json, '$.requestId') AS "requestId",
              created_at AS "createdAt"
            FROM projection_thread_activities
            WHERE activity_id = ${sharedActivityId}
          `,
          plans: yield* sql<{
            readonly planId: string;
            readonly threadId: string;
            readonly turnId: string | null;
            readonly implementedAt: string | null;
            readonly createdAt: string;
            readonly updatedAt: string;
          }>`
            SELECT
              plan_id AS "planId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              implemented_at AS "implementedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM projection_thread_proposed_plans
            WHERE plan_id = ${sharedPlanId}
          `,
          approvals: yield* sql<{
            readonly requestId: string;
            readonly threadId: string;
            readonly turnId: string | null;
            readonly status: string;
            readonly decision: string | null;
            readonly createdAt: string;
            readonly resolvedAt: string | null;
          }>`
            SELECT
              request_id AS "requestId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              status,
              decision,
              created_at AS "createdAt",
              resolved_at AS "resolvedAt"
            FROM projection_pending_approvals
            WHERE request_id = ${sharedApprovalRequestId}
          `,
        };
      });
      const readIdentityProjection = Effect.fn("readIdentityProjection")(function* () {
        return {
          owners: yield* readOwnerRows(),
          shells: {
            first: yield* readShellRow(fixture.threadId),
            other: yield* readShellRow(otherThreadId),
          },
        };
      });
      const readProjectorCursors = () =>
        sql<{
          readonly projector: string;
          readonly lastAppliedSequence: number;
          readonly updatedAt: string;
        }>`
          SELECT
            projector,
            last_applied_sequence AS "lastAppliedSequence",
            updated_at AS "updatedAt"
          FROM projection_state
          ORDER BY projector ASC
        `;

      const expectedProjection = {
        owners: {
          activities: [
            {
              activityId: sharedActivityId,
              threadId: fixture.threadId,
              kind: "user-input.requested",
              summary: "Original user input request",
              requestId: "user-input-owner-identity",
              createdAt: at(3),
            },
          ],
          plans: [
            {
              planId: sharedPlanId,
              threadId: fixture.threadId,
              turnId: firstPlanTurnId,
              implementedAt: null,
              createdAt: at(5),
              updatedAt: at(5),
            },
          ],
          approvals: [
            {
              requestId: sharedApprovalRequestId,
              threadId: fixture.threadId,
              turnId: null,
              status: "pending",
              decision: null,
              createdAt: at(7),
              resolvedAt: null,
            },
          ],
        },
        shells: {
          first: {
            latestTurnId: null,
            updatedAt: at(7),
            latestUserMessageAt: null,
            pendingApprovalCount: 1,
            pendingUserInputCount: 1,
            hasActionableProposedPlan: 1,
          },
          other: {
            latestTurnId: null,
            updatedAt: at(8),
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
          },
        },
      } satisfies {
        readonly owners: {
          readonly activities: ReadonlyArray<Record<string, unknown>>;
          readonly plans: ReadonlyArray<Record<string, unknown>>;
          readonly approvals: ReadonlyArray<Record<string, unknown>>;
        };
        readonly shells: Record<string, ShellRow>;
      };
      const expectedProjectorCursors = [...PROJECTOR_NAMES].sort().map((projector) => ({
        projector,
        lastAppliedSequence: lastConflictSequence,
        updatedAt: at(8),
      }));

      const liveProjection = yield* readIdentityProjection();
      assert.deepEqual(liveProjection, expectedProjection);
      assert.deepEqual(yield* readProjectorCursors(), expectedProjectorCursors);

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_pending_approvals`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      recordedStatements.length = 0;
      yield* projectionPipeline.bootstrap;
      recordedStatements.length = 0;

      const rebuiltProjection = yield* readIdentityProjection();
      assert.deepEqual(rebuiltProjection, expectedProjection);
      assert.deepEqual(rebuiltProjection, liveProjection);
      assert.deepEqual(yield* readProjectorCursors(), expectedProjectorCursors);
    }),
  );

  it.effect("rebuilds the exact live shell from the retained event log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const live = yield* seedThread({ slug: "bootstrap-parity", historyLength: 0 });
      const turnId = TurnId.make("turn-bootstrap-parity");
      const approvalRequestId = ApprovalRequestId.make("approval-bootstrap-parity");
      const userMessageId = MessageId.make("message-bootstrap-user");
      const assistantMessageId = MessageId.make("message-bootstrap-assistant");

      yield* live.appendAndProject(
        messageEvent({
          slug: "bootstrap-parity",
          label: "user",
          threadId: live.threadId,
          messageId: userMessageId,
          role: "user",
          text: "Build it",
          turnId,
          streaming: false,
          occurredAt: at(2),
        }),
      );
      yield* live.appendAndProject(
        activityEvent({
          slug: "bootstrap-parity",
          label: "approval",
          threadId: live.threadId,
          occurredAt: at(3),
          activity: {
            id: EventId.make("activity-bootstrap-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: approvalRequestId, requestKind: "command" },
            turnId,
            createdAt: at(3),
          },
        }),
      );
      yield* live.appendAndProject(
        activityEvent({
          slug: "bootstrap-parity",
          label: "user-input",
          threadId: live.threadId,
          occurredAt: at(4),
          activity: {
            id: EventId.make("activity-bootstrap-user-input"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: { requestId: "user-input-bootstrap-parity" },
            turnId,
            createdAt: at(4),
          },
        }),
      );
      yield* live.appendAndProject(
        proposedPlanEvent({
          slug: "bootstrap-parity",
          label: "plan",
          threadId: live.threadId,
          planId: "plan-bootstrap-parity",
          turnId,
          occurredAt: at(5),
          createdAt: at(5),
          implementedAt: null,
        }),
      );
      yield* live.appendAndProject(
        sessionEvent({
          slug: "bootstrap-parity",
          label: "session",
          threadId: live.threadId,
          turnId,
          occurredAt: at(6),
        }),
      );
      yield* live.appendAndProject(
        messageEvent({
          slug: "bootstrap-parity",
          label: "assistant-initial",
          threadId: live.threadId,
          messageId: assistantMessageId,
          role: "assistant",
          text: "Working ",
          turnId,
          streaming: true,
          occurredAt: at(7),
        }),
      );
      yield* live.appendAndProject(
        messageEvent({
          slug: "bootstrap-parity",
          label: "assistant-delta",
          threadId: live.threadId,
          messageId: assistantMessageId,
          role: "assistant",
          text: "now",
          turnId,
          streaming: true,
          occurredAt: at(8),
        }),
      );
      yield* live.appendAndProject(
        activityEvent({
          slug: "bootstrap-parity",
          label: "task-progress",
          threadId: live.threadId,
          occurredAt: at(9),
          activity: {
            id: EventId.make(`task-progress:${live.threadId}:task-1`),
            tone: "info",
            kind: "task.progress",
            summary: "Running tests",
            payload: { taskId: "task-1", status: "running" },
            turnId,
            createdAt: at(9),
          },
        }),
      );

      const expected: ShellRow = {
        latestTurnId: turnId,
        updatedAt: at(9),
        latestUserMessageAt: at(2),
        pendingApprovalCount: 1,
        pendingUserInputCount: 1,
        hasActionableProposedPlan: 1,
      };
      const liveRow = yield* readShellRow(live.threadId);
      assert.deepEqual(liveRow, expected);

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_pending_approvals`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      recordedStatements.length = 0;
      yield* projectionPipeline.bootstrap;
      recordedStatements.length = 0;

      const rebuiltRow = yield* readShellRow(live.threadId);
      assert.deepEqual(rebuiltRow, expected);
      assert.deepEqual(rebuiltRow, liveRow);
    }),
  );

  it.effect("rederives every shell summary from surviving owners after revert", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const fixture = yield* seedThread({ slug: "revert-summary", historyLength: 0 });
      const turnOne = TurnId.make("turn-revert-summary-1");
      const turnTwo = TurnId.make("turn-revert-summary-2");
      const retainedApprovalRequestId = ApprovalRequestId.make("approval-revert-summary-retained");
      const turnlessApprovalRequestId = ApprovalRequestId.make("approval-revert-summary-turnless");
      const removedPendingApprovalRequestId = ApprovalRequestId.make(
        "approval-revert-summary-removed-pending",
      );
      const removedResolvedApprovalRequestId = ApprovalRequestId.make(
        "approval-revert-summary-removed-resolved",
      );

      const readAffectedProjections = Effect.fn("readAffectedProjections")(function* () {
        return {
          messages: yield* sql<Record<string, unknown>>`
            SELECT *
            FROM projection_thread_messages
            WHERE thread_id = ${fixture.threadId}
            ORDER BY message_id ASC
          `,
          activities: yield* sql<Record<string, unknown>>`
            SELECT *
            FROM projection_thread_activities
            WHERE thread_id = ${fixture.threadId}
            ORDER BY activity_id ASC
          `,
          plans: yield* sql<Record<string, unknown>>`
            SELECT *
            FROM projection_thread_proposed_plans
            WHERE thread_id = ${fixture.threadId}
            ORDER BY plan_id ASC
          `,
          turns: yield* sql<Record<string, unknown>>`
            SELECT
              thread_id,
              turn_id,
              pending_message_id,
              assistant_message_id,
              state,
              requested_at,
              started_at,
              completed_at,
              checkpoint_turn_count,
              checkpoint_ref,
              checkpoint_status,
              checkpoint_files_json,
              source_proposed_plan_thread_id,
              source_proposed_plan_id
            FROM projection_turns
            WHERE thread_id = ${fixture.threadId}
            ORDER BY turn_id ASC
          `,
          approvals: yield* sql<Record<string, unknown>>`
            SELECT *
            FROM projection_pending_approvals
            WHERE thread_id = ${fixture.threadId}
            ORDER BY request_id ASC
          `,
          shell: yield* readShellRow(fixture.threadId),
        };
      });

      yield* fixture.appendAndProject(
        turnDiffEvent({
          slug: "revert-summary",
          label: "turn-one",
          threadId: fixture.threadId,
          turnId: turnOne,
          turnCount: 1,
          occurredAt: at(2),
        }),
      );
      yield* fixture.appendAndProject(
        messageEvent({
          slug: "revert-summary",
          label: "user-keep",
          threadId: fixture.threadId,
          messageId: MessageId.make("message-revert-summary-keep"),
          role: "user",
          text: "Keep",
          turnId: turnOne,
          streaming: false,
          occurredAt: at(3),
        }),
      );
      yield* fixture.appendAndProject(
        proposedPlanEvent({
          slug: "revert-summary",
          label: "plan-keep",
          threadId: fixture.threadId,
          planId: "plan-revert-summary-keep",
          turnId: turnOne,
          occurredAt: at(4),
          createdAt: at(4),
          implementedAt: at(4),
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "revert-summary",
          label: "approval-retained",
          threadId: fixture.threadId,
          occurredAt: at(5),
          activity: {
            id: EventId.make("activity-revert-summary-approval-retained"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Retained approval",
            payload: { requestId: retainedApprovalRequestId, requestKind: "command" },
            turnId: turnOne,
            createdAt: at(5),
          },
        }),
      );
      yield* fixture.appendAndProject(
        approvalResponseEvent({
          slug: "revert-summary",
          label: "approval-retained-response",
          threadId: fixture.threadId,
          requestId: retainedApprovalRequestId,
          occurredAt: at(6),
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "revert-summary",
          label: "approval-turnless",
          threadId: fixture.threadId,
          occurredAt: at(7),
          activity: {
            id: EventId.make("activity-revert-summary-approval-turnless"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Turnless approval",
            payload: { requestId: turnlessApprovalRequestId, requestKind: "command" },
            turnId: null,
            createdAt: at(7),
          },
        }),
      );
      yield* fixture.appendAndProject(
        approvalResponseEvent({
          slug: "revert-summary",
          label: "approval-turnless-response",
          threadId: fixture.threadId,
          requestId: turnlessApprovalRequestId,
          occurredAt: at(8),
        }),
      );
      yield* fixture.appendAndProject(
        turnDiffEvent({
          slug: "revert-summary",
          label: "turn-two",
          threadId: fixture.threadId,
          turnId: turnTwo,
          turnCount: 2,
          occurredAt: at(9),
        }),
      );
      yield* fixture.appendAndProject(
        messageEvent({
          slug: "revert-summary",
          label: "user-remove",
          threadId: fixture.threadId,
          messageId: MessageId.make("message-revert-summary-remove"),
          role: "user",
          text: "Remove",
          turnId: turnTwo,
          streaming: false,
          occurredAt: at(10),
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "revert-summary",
          label: "user-input-remove",
          threadId: fixture.threadId,
          occurredAt: at(11),
          activity: {
            id: EventId.make("activity-revert-summary-user-input-remove"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Removed user input",
            payload: { requestId: "user-input-revert-summary" },
            turnId: turnTwo,
            createdAt: at(11),
          },
        }),
      );
      yield* fixture.appendAndProject(
        proposedPlanEvent({
          slug: "revert-summary",
          label: "plan-remove",
          threadId: fixture.threadId,
          planId: "plan-revert-summary-remove",
          turnId: turnTwo,
          occurredAt: at(12),
          createdAt: at(12),
          implementedAt: null,
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "revert-summary",
          label: "approval-removed-pending",
          threadId: fixture.threadId,
          occurredAt: at(13),
          activity: {
            id: EventId.make("activity-revert-summary-approval-removed-pending"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Removed pending approval",
            payload: { requestId: removedPendingApprovalRequestId, requestKind: "command" },
            turnId: turnTwo,
            createdAt: at(13),
          },
        }),
      );
      yield* fixture.appendAndProject(
        activityEvent({
          slug: "revert-summary",
          label: "approval-removed-resolved",
          threadId: fixture.threadId,
          occurredAt: at(14),
          activity: {
            id: EventId.make("activity-revert-summary-approval-removed-resolved"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Removed resolved approval",
            payload: { requestId: removedResolvedApprovalRequestId, requestKind: "command" },
            turnId: turnTwo,
            createdAt: at(14),
          },
        }),
      );
      yield* fixture.appendAndProject(
        approvalResponseEvent({
          slug: "revert-summary",
          label: "approval-removed-resolved-response",
          threadId: fixture.threadId,
          requestId: removedResolvedApprovalRequestId,
          occurredAt: at(15),
        }),
      );

      yield* setShellSummaries(fixture.threadId, {
        latestUserMessageAt: "2099-01-01T00:00:00.000Z",
        pendingApprovalCount: 41,
        pendingUserInputCount: 42,
        hasActionableProposedPlan: 1,
      });

      yield* fixture.appendAndProject(
        revertedEvent({
          slug: "revert-summary",
          threadId: fixture.threadId,
          turnCount: 1,
          occurredAt: at(16),
        }),
      );

      const expectedShell: ShellRow = {
        latestTurnId: turnOne,
        updatedAt: at(16),
        latestUserMessageAt: at(3),
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
      };
      assert.deepEqual(yield* readShellRow(fixture.threadId), expectedShell);

      const messageRows = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${fixture.threadId}
        ORDER BY message_id ASC
      `;
      const activityRows = yield* sql<{
        readonly activityId: string;
        readonly turnId: string | null;
      }>`
        SELECT activity_id AS "activityId", turn_id AS "turnId"
        FROM projection_thread_activities
        WHERE thread_id = ${fixture.threadId}
        ORDER BY activity_id ASC
      `;
      const planRows = yield* sql<{ readonly planId: string }>`
        SELECT plan_id AS "planId"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${fixture.threadId}
        ORDER BY plan_id ASC
      `;
      const turnRows = yield* sql<{
        readonly turnId: string;
        readonly checkpointTurnCount: number | null;
      }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount"
        FROM projection_turns
        WHERE thread_id = ${fixture.threadId}
        ORDER BY turn_id ASC
      `;
      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly turnId: string | null;
        readonly status: string;
      }>`
        SELECT request_id AS "requestId", turn_id AS "turnId", status
        FROM projection_pending_approvals
        WHERE thread_id = ${fixture.threadId}
        ORDER BY request_id ASC
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-revert-summary-keep" }]);
      assert.deepEqual(activityRows, [
        { activityId: "activity-revert-summary-approval-retained", turnId: turnOne },
        { activityId: "activity-revert-summary-approval-turnless", turnId: null },
      ]);
      assert.deepEqual(planRows, [{ planId: "plan-revert-summary-keep" }]);
      assert.deepEqual(turnRows, [{ turnId: turnOne, checkpointTurnCount: 1 }]);
      assert.deepEqual(approvalRows, [
        { requestId: retainedApprovalRequestId, turnId: turnOne, status: "resolved" },
        { requestId: turnlessApprovalRequestId, turnId: null, status: "resolved" },
      ]);

      const liveProjection = yield* readAffectedProjections();

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_pending_approvals`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      recordedStatements.length = 0;
      yield* projectionPipeline.bootstrap;
      recordedStatements.length = 0;

      const rebuiltProjection = yield* readAffectedProjections();
      assert.deepEqual(rebuiltProjection, liveProjection);
      assert.deepEqual(rebuiltProjection.shell, expectedShell);
    }),
  );
});
