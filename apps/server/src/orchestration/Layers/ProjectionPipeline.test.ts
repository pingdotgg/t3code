import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ThreadLinkedPullRequest,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");
const encodeThreadLinkedPullRequest = Schema.encodeSync(
  Schema.fromJsonString(ThreadLinkedPullRequest),
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-cursor-batch-")))(
  "OrchestrationProjectionPipeline cursor batches",
  (it) => {
    it.effect("writes a project and all projector cursors in two statements", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const projectionState = yield* ProjectionStateRepository;
        const counter = makeSqlStatementCounter();
        const createdAt = "2026-01-01T00:00:00.000Z";
        const event = yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-cursor-batch-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-cursor-batch"),
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-cursor-batch-project"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-cursor-batch"),
            title: "Cursor batch project",
            workspaceRoot: "/tmp/project-cursor-batch",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* projectionPipeline.projectEvent(event).pipe(Effect.withTracer(counter.tracer));
        assert.strictEqual(counter.count(), 2);
        assert.deepEqual(
          yield* projectionState.listAll(),
          Object.values(ORCHESTRATION_PROJECTOR_NAMES)
            .sort()
            .map((projector) => ({
              projector,
              lastAppliedSequence: event.sequence,
              updatedAt: createdAt,
            })),
        );
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-import-shell-")))(
  "imported thread shell projection",
  (it) => {
    it.effect("does not mark imported user messages as queued work in thread shells", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = "2026-08-24T10:00:00.000Z";
        const threadId = ThreadId.make("import:codex:shell-session");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-import-shell-thread"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-thread"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-import-shell"),
            title: "Imported thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-import-shell-message"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-message"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-message"),
          metadata: { historyImport: true },
          payload: {
            threadId,
            messageId: MessageId.make("import:codex:shell-session:0"),
            role: "user",
            text: "Imported user prompt",
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        });

        yield* projectionPipeline.bootstrap;

        const readLatestUserMessageAt = sql<{ readonly latestUserMessageAt: string | null }>`
        SELECT latest_user_message_at AS "latestUserMessageAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
        assert.deepEqual(yield* readLatestUserMessageAt, [{ latestUserMessageAt: null }]);

        const sessionEvent = yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make("evt-import-shell-session"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make("cmd-import-shell-session"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-import-shell-session"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
          },
        });
        yield* projectionPipeline.projectEvent(sessionEvent);
        assert.deepEqual(yield* readLatestUserMessageAt, [{ latestUserMessageAt: null }]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-branch-pr-projection-")))(
  "branch pull request projection",
  (it) => {
    it.effect("persists branch pull request updates without changing manual links", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-pull-request");
        const projectId = ProjectId.make("project-pull-request");
        const eventFields = {
          aggregateKind: "thread" as const,
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        const created = yield* eventStore.append({
          ...eventFields,
          type: "thread.created",
          eventId: EventId.make("evt-pull-request-created"),
          payload: {
            threadId,
            projectId,
            title: "Pull request thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionPipeline.projectEvent(created);
        const linkedPullRequest = {
          projectId,
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
        };
        const branchPullRequest = {
          ...linkedPullRequest,
          number: 43,
          url: "https://github.com/pingdotgg/t3code/pull/43",
        };
        const updates = [
          { payload: { linkedPullRequest, branchPullRequest }, expected: branchPullRequest },
          { payload: { title: "Renamed thread" }, expected: branchPullRequest },
          { payload: { branchPullRequest: null }, expected: null },
        ];

        for (const [index, update] of updates.entries()) {
          const event = yield* eventStore.append({
            ...eventFields,
            type: "thread.meta-updated",
            eventId: EventId.make(`evt-pull-request-update-${index}`),
            payload: { threadId, updatedAt: now, ...update.payload },
          });
          yield* projectionPipeline.projectEvent(event);

          const rows = yield* sql<{
            readonly linkedPullRequest: string | null;
            readonly branchPullRequest: string | null;
          }>`
          SELECT
            linked_pull_request_json AS "linkedPullRequest",
            branch_pull_request_json AS "branchPullRequest"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
          assert.deepEqual(rows, [
            {
              linkedPullRequest: encodeThreadLinkedPullRequest(linkedPullRequest),
              branchPullRequest:
                update.expected === null ? null : encodeThreadLinkedPullRequest(update.expected),
            },
          ]);
        }
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }

      yield* sql`CREATE TABLE thread_shell_updates (count INTEGER NOT NULL)`;
      yield* sql`INSERT INTO thread_shell_updates (count) VALUES (0)`;
      yield* sql`
        CREATE TRIGGER count_thread_shell_updates
        AFTER UPDATE ON projection_threads
        WHEN NEW.thread_id = 'thread-1'
        BEGIN
          UPDATE thread_shell_updates SET count = count + 1;
        END;
      `;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-assistant-update"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.100Z",
        commandId: CommandId.make("cmd-assistant-update"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-assistant-update"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-2"),
          role: "assistant",
          text: "more work",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:00.100Z",
          updatedAt: "2026-01-01T00:00:00.100Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      let threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);

      yield* sql`UPDATE thread_shell_updates SET count = 0`;
      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-routine-activity"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:00.200Z",
        commandId: CommandId.make("cmd-routine-activity"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-routine-activity"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-routine"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Tool made progress",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:00:00.200Z",
          },
        },
      });
      yield* projectionPipeline.bootstrap;

      threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `;
      assert.deepEqual(threadShellUpdates, [{ count: 1 }]);
      yield* sql`DROP TRIGGER count_thread_shell_updates`;
      yield* sql`DROP TABLE thread_shell_updates`;

      // Replayed order events must survive later lifecycle upserts, whose
      // complete SQL row writes otherwise risk dropping the placement.
      const orderUpdatedAt = "2026-01-01T00:00:00.200Z";
      const orderEvents = [
        { type: "thread.meta-updated", payload: { activeOrderKey: "gm" } },
        { type: "thread.pinned", payload: { pinnedAt: now, pinOrderKey: "m" } },
        {
          type: "thread.snoozed",
          payload: { snoozedAt: now, snoozedUntil: "2026-01-02T00:00:00.000Z" },
        },
        { type: "thread.unsnoozed", payload: { reason: "user" } },
        { type: "thread.unpinned", payload: {} },
        { type: "thread.meta-updated", payload: { title: "Renamed" } },
      ] as const;
      for (const [index, event] of orderEvents.entries()) {
        yield* eventStore.append({
          type: event.type,
          eventId: EventId.make(`evt-active-order-${index}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          occurredAt: "2026-01-01T00:00:00.500Z",
          commandId: CommandId.make(`cmd-active-order-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            ...event.payload,
            threadId: ThreadId.make("thread-1"),
            updatedAt: orderUpdatedAt,
          },
        });
        yield* projectionPipeline.bootstrap;
        const rows = yield* sql<{
          readonly activeOrderKey: string | null;
          readonly updatedAt: string;
        }>`
          SELECT active_order_key AS "activeOrderKey", updated_at AS "updatedAt"
          FROM projection_threads WHERE thread_id = 'thread-1'
        `;
        assert.deepEqual(rows, [{ activeOrderKey: "gm", updatedAt: orderUpdatedAt }]);
      }

      // Settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-settle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-settle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-settle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
        readonly activeOrderKey: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          active_order_key AS "activeOrderKey"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settledRows, [
        {
          settledOverride: "settled",
          settledAt: "2026-01-01T00:00:01.000Z",
          unsettledAt: null,
          activeOrderKey: null,
        },
      ]);

      yield* eventStore.append({
        type: "thread.unsettled",
        eventId: EventId.make("evt-unsettle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-unsettle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-unsettle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
        readonly unsettledAt: string | null;
        readonly activeOrderKey: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          active_order_key AS "activeOrderKey"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      // The un-settle stamps the active-list re-entry time so clients can
      // surface the thread at the top of the list.
      assert.deepEqual(unsettledRows, [
        {
          settledOverride: "active",
          settledAt: null,
          unsettledAt: "2026-01-01T00:00:02.000Z",
          activeOrderKey: null,
        },
      ]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const projectionState = yield* ProjectionStateRepository;
      const cursorsBeforeFailure = yield* projectionState.listAll();
      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const pendingEvent = yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-rollback-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          messageId: MessageId.make("message-rollback"),
          role: "user",
          text: "Rollback me",
          attachments: [
            {
              type: "image",
              id: "thread-rollback-att-1",
              name: "rollback.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const result = yield* Effect.result(projectionPipeline.projectEvent(pendingEvent));
      assert.equal(result._tag, "Failure");
      assert.deepEqual(yield* projectionState.listAll(), cursorsBeforeFailure);

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;
      assert.deepEqual(
        yield* projectionState.listAll(),
        cursorsBeforeFailure.map((cursor) => ({
          ...cursor,
          lastAppliedSequence: pendingEvent.sequence,
          updatedAt: pendingEvent.occurredAt,
        })),
      );
      const replayedMessages = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-rollback'
      `;
      assert.deepEqual(replayedMessages, [{ text: "Rollback me" }]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("prunes reverted attachments only after every projector commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const keepFileAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000004-pdf";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
            {
              type: "file",
              id: keepFileAttachmentId,
              name: "keep.pdf",
              mimeType: "application/pdf",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const keepFilePath = path.join(attachmentsDir, `${keepFileAttachmentId}.pdf`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(keepFilePath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      const revertedEvent = yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_revert_projection
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.threads'
        BEGIN
          SELECT RAISE(FAIL, 'forced later projector failure');
        END
      `;
      const projectionError = yield* projectionPipeline
        .projectEvent(revertedEvent)
        .pipe(Effect.flip);
      assert.equal(projectionError._tag, "PersistenceSqlError");
      assert.isTrue(yield* exists(removePath));
      const rolledBackMessages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE message_id = 'message-remove'
      `;
      assert.deepEqual(rolledBackMessages, [{ messageId: "message-remove" }]);
      yield* sql`DROP TRIGGER fail_revert_projection`;

      const laterAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000005";
      const laterPath = path.join(attachmentsDir, `${laterAttachmentId}.png`);
      yield* fileSystem.writeFileString(laterPath, "added after revert");
      const cleanup = yield* sql.withTransaction(
        Effect.gen(function* () {
          const cleanup = yield* projectionPipeline.projectEventDeferred(revertedEvent);
          yield* appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.make("evt-revert-files-later"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make("cmd-revert-files-later"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-revert-files-later"),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make("message-later"),
              role: "user",
              text: "Later attachment",
              attachments: [
                {
                  type: "image",
                  id: laterAttachmentId,
                  name: "later.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          });
          assert.isTrue(yield* exists(removePath));
          // Return the cleanup effect so the caller runs it after the outer transaction commits.
          // @effect-diagnostics-next-line returnEffectInGen:off
          return cleanup;
        }),
      );
      assert.isTrue(yield* exists(removePath));
      yield* cleanup;

      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(keepFilePath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(laterPath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
        const fileAttachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000003-pdf";
        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-delete-files"),
            title: "Thread Delete Files",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
              {
                type: "file",
                id: fileAttachmentId,
                name: "delete.pdf",
                mimeType: "application/pdf",
                sizeBytes: 6,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        const threadFileAttachmentPath = path.join(attachmentsDir, `${fileAttachmentId}.pdf`);
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(threadFileAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(threadFileAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isFalse(yield* exists(threadFileAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = "2026-01-01T00:00:00.000Z";
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(".."),
          occurredAt: now,
          commandId: CommandId.make("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-replay-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("replaying a superseded thread.deleted keeps the re-created thread's files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make("project-replay");
        const retriedThreadId = ThreadId.make("thread-replay-retried");
        const goneThreadId = ThreadId.make("thread-replay-gone");
        const retriedAttachmentPath = path.join(
          attachmentsDir,
          "thread-replay-retried-00000000-0000-4000-8000-000000000001.png",
        );
        const goneAttachmentPath = path.join(
          attachmentsDir,
          "thread-replay-gone-00000000-0000-4000-8000-000000000002.png",
        );
        const threadCreated = (threadId: ThreadId, suffix: string) =>
          eventStore.append({
            type: "thread.created",
            eventId: EventId.make(`evt-replay-create-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make(`cmd-replay-create-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-replay-create-${suffix}`),
            metadata: {},
            payload: {
              threadId,
              projectId,
              title: `Thread ${suffix}`,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          });
        const threadDeleted = (threadId: ThreadId, suffix: string) =>
          eventStore.append({
            type: "thread.deleted",
            eventId: EventId.make(`evt-replay-delete-${suffix}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make(`cmd-replay-delete-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-replay-delete-${suffix}`),
            metadata: {},
            payload: { threadId, deletedAt: now },
          });

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-replay-project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.make("cmd-replay-project"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-replay-project"),
          metadata: {},
          payload: {
            projectId,
            title: "Replay",
            workspaceRoot: "/tmp/project-replay",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        // A failed first send: create, roll back, then the draft retries the id.
        yield* threadCreated(retriedThreadId, "retried-1");
        yield* threadDeleted(retriedThreadId, "retried");
        yield* threadCreated(retriedThreadId, "retried-2");
        // A thread that was deleted for good.
        yield* threadCreated(goneThreadId, "gone");
        yield* threadDeleted(goneThreadId, "gone");

        // Files on disk are not event-sourced: by the time anything replays,
        // the retried thread's attachments already belong to its second life.
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(retriedAttachmentPath, "second incarnation");
        yield* fileSystem.writeFileString(goneAttachmentPath, "gone");

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(retriedAttachmentPath));
        assert.isFalse(yield* exists(goneAttachmentPath));
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("replays a bootstrap backlog larger than the event store default limit", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-bootstrap-backlog");

      const sequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const sequenceBeforeBacklog = sequenceRows[0]?.maxSequence ?? 0;
      const appendedEvents = yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => index),
        (index) => {
          const eventId = EventId.make(`evt-bootstrap-backlog-${index}`);
          const commandId = CommandId.make(`cmd-bootstrap-backlog-${index}`);
          return eventStore.append({
            type: "project.created",
            eventId,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              projectId,
              title: `Bootstrap backlog ${index}`,
              workspaceRoot: "/tmp/project-bootstrap-backlog",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      const lastSequence = appendedEvents[appendedEvents.length - 1]!.sequence;

      yield* Effect.forEach(
        Object.values(ORCHESTRATION_PROJECTOR_NAMES),
        (projector) => {
          const lastAppliedSequence =
            projector === ORCHESTRATION_PROJECTOR_NAMES.projects
              ? sequenceBeforeBacklog
              : lastSequence;
          return sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${lastAppliedSequence}, ${now})
            ON CONFLICT (projector)
            DO UPDATE SET
              last_applied_sequence = excluded.last_applied_sequence,
              updated_at = excluded.updated_at
          `;
        },
        { discard: true },
      );

      yield* projectionPipeline.bootstrap;

      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: lastSequence }]);
    }),
  );

  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const streamingAt = "2026-01-01T00:00:01.000Z";
      const completedAt = "2026-01-01T00:00:02.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: streamingAt,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: streamingAt,
          updatedAt: streamingAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: completedAt,
        commandId: CommandId.make("cmd-a5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: completedAt,
          updatedAt: completedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{
        readonly text: string;
        readonly isStreaming: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT
          text,
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [
        {
          text: "hello world",
          isStreaming: 0,
          createdAt: now,
          updatedAt: completedAt,
        },
      ]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps the turn running across interim assistant messages until the session ends", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-lifecycle");
      const turnId = TurnId.make("turn-lifecycle-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tl1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tl1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-lifecycle"),
          title: "Turn lifecycle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tl2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // Interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-tl3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:05.000Z",
        commandId: CommandId.make("cmd-tl3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-tl-interim"),
          role: "assistant",
          text: "interim commentary",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const runningRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(runningRows, [{ state: "running", completedAt: null }]);

      // The session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tl4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(settledRows, [
        { state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      ]);

      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestTurnId: turnId }]);
    }),
  );

  it.effect("settles a superseded running turn when a new turn becomes active", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-supersede");
      const oldTurnId = TurnId.make("turn-superseded");
      const newTurnId = TurnId.make("turn-steer");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-ts1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-ts1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-ts1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-supersede"),
          title: "Turn supersede",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "big-pickle",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        });

      yield* appendRunningSessionSet("evt-ts2", oldTurnId, "2026-01-01T00:00:01.000Z");
      // A steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet("evt-ts3", newTurnId, "2026-01-01T00:00:30.000Z");

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `;
      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: "completed", completedAt: "2026-01-01T00:00:30.000Z" },
        { turnId: newTurnId, state: "running", completedAt: null },
      ]);
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending permission request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("reads only user-input activities when refreshing shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-user-input-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-user-input"),
        occurredAt: "2026-02-26T12:35:00.000Z",
        commandId: CommandId.make("cmd-stale-user-input-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Project Stale User Input",
          workspaceRoot: "/tmp/project-stale-user-input",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:35:00.000Z",
          updatedAt: "2026-02-26T12:35:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-user-input-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:01.000Z",
        commandId: CommandId.make("cmd-stale-user-input-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Thread Stale User Input",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:35:01.000Z",
          updatedAt: "2026-02-26T12:35:01.000Z",
        },
      });

      // Invalid JSON proves the summary query filters tool rows before decoding payloads.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-malformed-tool-output',
            'thread-stale-user-input',
            NULL,
            'info',
            'tool.completed',
            'Tool completed',
            '{not-json',
            NULL,
            '2026-02-26T12:35:02.000Z'
          ),
          (
            'activity-user-input-resolved-requested',
            'thread-stale-user-input',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            json_object('requestId', 'user-input-resolved'),
            NULL,
            '2026-02-26T12:35:03.000Z'
          ),
          (
            'activity-user-input-resolved',
            'thread-stale-user-input',
            NULL,
            'info',
            'user-input.resolved',
            'User input resolved',
            json_object('requestId', 'user-input-resolved'),
            NULL,
            '2026-02-26T12:35:04.000Z'
          ),
          (
            'activity-user-input-stale-requested',
            'thread-stale-user-input',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            json_object('requestId', 'user-input-stale'),
            NULL,
            '2026-02-26T12:35:05.000Z'
          ),
          (
            'activity-user-input-stale-failed',
            'thread-stale-user-input',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Provider user input response failed',
            json_object(
              'requestId',
              'user-input-stale',
              'detail',
              'Unknown pending Codex user input request: user-input-stale'
            ),
            NULL,
            '2026-02-26T12:35:06.000Z'
          ),
          (
            'activity-user-input-active-requested',
            'thread-stale-user-input',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            json_object('requestId', 'user-input-active'),
            NULL,
            '2026-02-26T12:35:07.000Z'
          )
      `;

      // A user-input lifecycle activity is one of the events that still
      // refreshes the shell summary, so it forces the read under test.
      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:08.000Z",
        commandId: CommandId.make("cmd-stale-user-input-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-user-input-active-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: {
              requestId: "user-input-active",
              detail: "Provider is temporarily unavailable",
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:08.000Z",
          },
        },
      });

      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number;
      }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-user-input'
      `;
      assert.deepEqual(threadRows, [{ pendingUserInputCount: 1 }]);
    }),
  );

  it.effect("maintains shell summaries without decoding message or plan bodies", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-shell-summary-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-shell-summary"),
        occurredAt: "2026-03-01T08:00:00.000Z",
        commandId: CommandId.make("cmd-shell-summary-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-shell-summary"),
          title: "Project Shell Summary",
          workspaceRoot: "/tmp/project-shell-summary",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-03-01T08:00:00.000Z",
          updatedAt: "2026-03-01T08:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-shell-summary-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-shell-summary"),
        occurredAt: "2026-03-01T08:00:01.000Z",
        commandId: CommandId.make("cmd-shell-summary-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-shell-summary"),
          projectId: ProjectId.make("project-shell-summary"),
          title: "Thread Shell Summary",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-03-01T08:00:01.000Z",
          updatedAt: "2026-03-01T08:00:01.000Z",
        },
      });

      const readSummary = sql<{
        readonly latestUserMessageAt: string | null;
        readonly pendingUserInputCount: number;
        readonly updatedAt: string;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          pending_user_input_count AS "pendingUserInputCount",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-shell-summary'
      `;

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-shell-summary-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-shell-summary"),
        occurredAt: "2026-03-01T08:00:02.000Z",
        commandId: CommandId.make("cmd-shell-summary-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-shell-summary"),
          messageId: MessageId.make("message-shell-summary-user"),
          role: "user",
          text: "please do the thing",
          turnId: TurnId.make("turn-shell-summary-1"),
          streaming: false,
          createdAt: "2026-03-01T08:00:02.000Z",
          updatedAt: "2026-03-01T08:00:02.000Z",
        },
      });

      assert.deepEqual(yield* readSummary, [
        {
          latestUserMessageAt: "2026-03-01T08:00:02.000Z",
          pendingUserInputCount: 0,
          updatedAt: "2026-03-01T08:00:02.000Z",
        },
      ]);

      // Streaming assistant deltas bump updatedAt but must not disturb
      // latestUserMessageAt or the pending counters.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-shell-summary-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-shell-summary"),
        occurredAt: "2026-03-01T08:00:03.000Z",
        commandId: CommandId.make("cmd-shell-summary-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-shell-summary"),
          messageId: MessageId.make("message-shell-summary-assistant"),
          role: "assistant",
          text: "working on it",
          turnId: TurnId.make("turn-shell-summary-1"),
          streaming: true,
          createdAt: "2026-03-01T08:00:03.000Z",
          updatedAt: "2026-03-01T08:00:03.000Z",
        },
      });

      assert.deepEqual(yield* readSummary, [
        {
          latestUserMessageAt: "2026-03-01T08:00:02.000Z",
          pendingUserInputCount: 0,
          updatedAt: "2026-03-01T08:00:03.000Z",
        },
      ]);

      // Ordinary tool activities bump updatedAt without touching the
      // user-input counter; user-input lifecycle activities update it.
      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-shell-summary-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-shell-summary"),
        occurredAt: "2026-03-01T08:00:04.000Z",
        commandId: CommandId.make("cmd-shell-summary-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-shell-summary"),
          activity: {
            id: EventId.make("activity-shell-summary-command"),
            tone: "tool",
            kind: "command",
            summary: "Ran a command",
            payload: {},
            turnId: TurnId.make("turn-shell-summary-1"),
            createdAt: "2026-03-01T08:00:04.000Z",
          },
        },
      });

      assert.deepEqual(yield* readSummary, [
        {
          latestUserMessageAt: "2026-03-01T08:00:02.000Z",
          pendingUserInputCount: 0,
          updatedAt: "2026-03-01T08:00:04.000Z",
        },
      ]);

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-shell-summary-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-shell-summary"),
        occurredAt: "2026-03-01T08:00:05.000Z",
        commandId: CommandId.make("cmd-shell-summary-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-shell-summary-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-shell-summary"),
          activity: {
            id: EventId.make("activity-shell-summary-user-input"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-shell-summary-1",
              questions: [
                {
                  id: "confirm",
                  header: "Confirm",
                  question: "Proceed?",
                  options: [{ label: "yes", description: "Proceed" }],
                },
              ],
            },
            turnId: TurnId.make("turn-shell-summary-1"),
            createdAt: "2026-03-01T08:00:05.000Z",
          },
        },
      });

      assert.deepEqual(yield* readSummary, [
        {
          latestUserMessageAt: "2026-03-01T08:00:02.000Z",
          pendingUserInputCount: 1,
          updatedAt: "2026-03-01T08:00:05.000Z",
        },
      ]);

      // Summary refreshes must not decode message bodies or attachment metadata.
      yield* sql`
        UPDATE projection_thread_messages
        SET attachments_json = '{not-json'
        WHERE thread_id = 'thread-shell-summary'
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        ) VALUES
          ('summary-pending', 'thread-shell-summary', NULL, 'pending', NULL,
           '2026-03-01T08:00:06.000Z', NULL),
          ('summary-resolved', 'thread-shell-summary', NULL, 'resolved', 'accept',
           '2026-03-01T08:00:06.000Z', '2026-03-01T08:00:06.000Z'),
          ('summary-other-thread', 'thread-shell-summary-other', NULL, 'pending', NULL,
           '2026-03-01T08:00:06.000Z', NULL)
      `;
      // Empty markdown must not be decoded when the shell only needs plan status.
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        ) VALUES (
          'summary-plan', 'thread-shell-summary', 'turn-shell-summary-1', '', NULL,
          NULL, '2026-03-01T08:00:06.000Z', '2026-03-01T08:00:06.000Z'
        )
      `;

      const refreshEvents = [
        {
          type: "thread.session-set",
          eventId: EventId.make("evt-shell-summary-7"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-shell-summary"),
          occurredAt: "2026-03-01T08:00:07.000Z",
          commandId: CommandId.make("cmd-shell-summary-7"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-shell-summary-7"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-shell-summary"),
            session: {
              threadId: ThreadId.make("thread-shell-summary"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-03-01T08:00:07.000Z",
            },
          },
        },
        {
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-shell-summary-8"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-shell-summary"),
          occurredAt: "2026-03-01T08:00:08.000Z",
          commandId: CommandId.make("cmd-shell-summary-8"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-shell-summary-8"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-shell-summary"),
            turnId: TurnId.make("turn-shell-summary-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-shell-summary/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("message-shell-summary-assistant"),
            completedAt: "2026-03-01T08:00:08.000Z",
          },
        },
      ] satisfies ReadonlyArray<Parameters<typeof eventStore.append>[0]>;

      for (const event of refreshEvents) {
        yield* appendAndProject(event);
        const summary = yield* sql<{
          readonly latestUserMessageAt: string | null;
          readonly pendingApprovalCount: number;
          readonly pendingUserInputCount: number;
          readonly hasActionableProposedPlan: number;
        }>`
          SELECT
            latest_user_message_at AS "latestUserMessageAt",
            pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount",
            has_actionable_proposed_plan AS "hasActionableProposedPlan"
          FROM projection_threads
          WHERE thread_id = 'thread-shell-summary'
        `;
        assert.deepEqual(summary, [
          {
            latestUserMessageAt: "2026-03-01T08:00:02.000Z",
            pendingApprovalCount: 1,
            pendingUserInputCount: 1,
            hasActionableProposedPlan: 1,
          },
        ]);
      }
    }),
  );

  it.effect("restores pending approvals when a provider reply fails", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.approval-response-requested",
        eventId: EventId.make("evt-nonstale-approval-response"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.500Z",
        commandId: CommandId.make("cmd-nonstale-approval-response"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-response"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          requestId: ApprovalRequestId.make("approval-request-nonstale-existing"),
          decision: "accept",
          createdAt: "2026-02-26T12:45:02.500Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-resolved"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:05.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-resolved"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-resolved"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-resolved"),
            tone: "approval",
            kind: "approval.resolved",
            summary: "Approval resolved",
            payload: {
              requestId: "approval-request-nonstale-existing",
              decision: "accept",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:05.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-late-failure"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:06.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-late-failure"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-late-failure"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-late-failure"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:06.000Z",
          },
        },
      });

      const resolvedThreadRows = yield* sql<{ readonly pendingApprovalCount: number }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(resolvedThreadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-pending-turn-terminal-test-"))(
  "OrchestrationProjectionPipeline pending turn cleanup",
  (it) => {
    it.effect("clears pending turn starts when startup reaches a terminal session state", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;

        for (const [index, status] of (["error", "interrupted", "stopped"] as const).entries()) {
          const threadId = ThreadId.make(`thread-terminal-${status}`);
          const requestedAt = `2026-02-26T14:00:0${index}.000Z`;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-terminal-pending-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-pending-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-pending-${status}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-terminal-${status}`),
              runtimeMode: "approval-required",
              createdAt: requestedAt,
            },
          });
          yield* eventStore.append({
            type: "thread.session-set",
            eventId: EventId.make(`evt-terminal-session-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-session-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-session-${status}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: status === "error" ? "startup failed" : null,
                updatedAt: requestedAt,
              },
            },
          });
        }

        yield* projectionPipeline.bootstrap;

        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE turn_id IS NULL
            AND state = 'pending'
        `;
        assert.deepEqual(pendingRows, []);
      }),
    );

    it.effect("only clears the compact request that produced the compaction activity", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-compaction-correlation");

        for (const [index, messageId] of ["compact-request", "new-message"].entries()) {
          const createdAt = `2026-02-26T15:00:0${index}.000Z`;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-compaction-pending-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId: CommandId.make(`cmd-compaction-pending-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-compaction-pending-${index}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(messageId),
              runtimeMode: "full-access",
              createdAt,
            },
          });
        }
        yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make("evt-compaction-stale"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-02-26T15:00:02.000Z",
          commandId: CommandId.make("cmd-compaction-stale"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-compaction-stale"),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make("activity-compaction-stale"),
              tone: "info",
              kind: "context-compaction",
              summary: "Context compacted",
              payload: { requestId: "compact-request" },
              turnId: null,
              createdAt: "2026-02-26T15:00:02.000Z",
            },
          },
        });
        yield* projectionPipeline.bootstrap;

        const pendingRows = yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = ${threadId}
            AND turn_id IS NULL
            AND state = 'pending'
        `;
        assert.deepEqual(pendingRows, [{ messageId: "new-message" }]);
      }),
    );
  },
);

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        faviconPath: "brand/icon.svg",
        projectIcon: { kind: "emoji", emoji: "🚀" },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
        readonly faviconPath: string | null;
        readonly projectIcon: string | null;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection",
          favicon_path AS "faviconPath",
          project_icon_json AS "projectIcon"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
          faviconPath: "brand/icon.svg",
          projectIcon: '{"kind":"emoji","emoji":"🚀"}',
        },
      ]);
    }),
  );

  it.effect("re-creating a deleted thread id starts from an empty projection", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-retry");
      const threadId = ThreadId.make("thread-retry");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const createThread = (commandId: string, title: string) =>
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(commandId),
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      const countRowsForThread = (table: string) =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
      const perThreadTables = [
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_thread_sessions",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
      ];

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-retry-project"),
        projectId,
        title: "Retry Project",
        workspaceRoot: "/tmp/project-retry",
        defaultModelSelection: modelSelection,
        createdAt,
      });

      // First attempt: the thread gets a turn, a message, an activity, and a
      // running session before its bootstrap fails and the server rolls back.
      yield* createThread("cmd-retry-create-1", "First attempt");
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-retry-turn-1"),
        threadId,
        message: {
          messageId: MessageId.make("message-retry-1"),
          role: "user",
          text: "first attempt",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-retry-activity-1"),
        threadId,
        activity: {
          id: EventId.make("activity-retry-1"),
          tone: "info",
          kind: "approval.requested",
          summary: "approval requested",
          payload: { requestId: "request-retry-1" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("cmd-retry-plan-1"),
        threadId,
        proposedPlan: {
          id: "plan-retry-1",
          turnId: null,
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-retry-session-1"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-retry-1"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      for (const table of perThreadTables) {
        assert.isAbove(yield* countRowsForThread(table), 0, `${table} should be populated`);
      }
      const populatedShell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(threadId));
      assert.isTrue(populatedShell.hasPendingApprovals);
      assert.isTrue(populatedShell.hasActionableProposedPlan);

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-retry-delete"),
        threadId,
      });
      assert.isTrue(Option.isNone(yield* snapshotQuery.getThreadShellById(threadId)));

      // Retry from the same draft reuses the thread id.
      yield* createThread("cmd-retry-create-2", "Second attempt");

      const shell = Option.getOrThrow(yield* snapshotQuery.getThreadShellById(threadId));
      assert.strictEqual(shell.title, "Second attempt");
      assert.isFalse(shell.hasPendingApprovals);
      assert.isFalse(shell.hasActionableProposedPlan);
      for (const table of perThreadTables) {
        assert.strictEqual(yield* countRowsForThread(table), 0, `${table} should be empty`);
      }
      const detail = Option.getOrThrow(yield* snapshotQuery.getThreadDetailById(threadId));
      assert.deepEqual(detail.messages, []);
      assert.deepEqual(detail.activities, []);
      assert.isNull(detail.latestTurn);
      assert.isNull(detail.session);
    }),
  );

  it.effect("cleans attachments only after the command receipt commits", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const createdAt = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-outer-rollback");
      const threadId = ThreadId.make("thread-outer-rollback");
      const cleanupFailureThreadId = ThreadId.make("thread-cleanup-failure");
      const commandId = CommandId.make("cmd-outer-rollback-delete");
      const attachmentPath = path.join(
        attachmentsDir,
        "thread-outer-rollback-00000000-0000-4000-8000-000000000001.png",
      );
      const blockedAttachmentPath = path.join(
        attachmentsDir,
        "thread-cleanup-failure-00000000-0000-4000-8000-000000000001.png",
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-outer-rollback-project"),
        projectId,
        title: "Outer rollback project",
        workspaceRoot: "/tmp/project-outer-rollback",
        createdAt,
      });
      for (const id of [threadId, cleanupFailureThreadId]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-create-${id}`),
          threadId: id,
          projectId,
          title: "Attachment cleanup thread",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }

      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "keep this attachment");
      const readCursors = sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT projector, last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state ORDER BY projector
      `;
      const cursorsBeforeFailure = yield* readCursors;
      yield* sql`
        CREATE TRIGGER fail_attachment_command_receipt
        BEFORE INSERT ON orchestration_command_receipts
        WHEN NEW.command_id = 'cmd-outer-rollback-delete' AND NEW.status = 'accepted'
        BEGIN
          SELECT RAISE(FAIL, 'forced receipt failure');
        END
      `;
      const deleteCommand = { type: "thread.delete", commandId, threadId } as const;
      const dispatchError = yield* engine.dispatch(deleteCommand).pipe(Effect.flip);
      assert.equal(dispatchError._tag, "PersistenceSqlError");
      assert.deepEqual(yield* readCursors, cursorsBeforeFailure);
      assert.equal(yield* fileSystem.readFileString(attachmentPath), "keep this attachment");
      const rolledBackThreads = yield* sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rolledBackThreads, [{ deletedAt: null }]);
      const rolledBackEvents = yield* sql`
        SELECT sequence FROM orchestration_events WHERE command_id = ${commandId}
      `;
      assert.deepEqual(rolledBackEvents, []);
      const rolledBackReceipts = yield* sql`
        SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}
      `;
      assert.deepEqual(rolledBackReceipts, []);
      yield* sql`DROP TRIGGER fail_attachment_command_receipt`;

      const result = yield* engine.dispatch(deleteCommand);
      assert.deepEqual(
        yield* readCursors,
        cursorsBeforeFailure.map((cursor) => ({
          ...cursor,
          lastAppliedSequence: result.sequence,
        })),
      );
      assert.isFalse(yield* exists(attachmentPath));
      const committedReceipts = yield* sql<{
        readonly status: string;
        readonly resultSequence: number;
      }>`
        SELECT status, result_sequence AS "resultSequence"
        FROM orchestration_command_receipts WHERE command_id = ${commandId}
      `;
      assert.deepEqual(committedReceipts, [
        { status: "accepted", resultSequence: result.sequence },
      ]);

      // Removing a nonempty directory as a file fails after the command commits.
      yield* fileSystem.makeDirectory(blockedAttachmentPath);
      yield* fileSystem.writeFileString(path.join(blockedAttachmentPath, "keep.txt"), "keep");
      const cleanupFailureCommandId = CommandId.make("cmd-cleanup-failure-delete");
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: cleanupFailureCommandId,
        threadId: cleanupFailureThreadId,
      });
      assert.isTrue(yield* exists(blockedAttachmentPath));
      const cleanupFailureReceipts = yield* sql<{ readonly status: string }>`
        SELECT status FROM orchestration_command_receipts
        WHERE command_id = ${cleanupFailureCommandId}
      `;
      assert.deepEqual(cleanupFailureReceipts, [{ status: "accepted" }]);
    }),
  );
});
