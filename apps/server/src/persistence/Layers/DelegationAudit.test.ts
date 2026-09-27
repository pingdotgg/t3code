import { EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DelegationAuditRepositoryLive } from "./DelegationAudit.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { DelegationAuditRepository } from "../Services/DelegationAudit.ts";
import migration from "../Migrations/107_DelegationAudit.ts";
import { runMigrations } from "../Migrations.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    DelegationAuditRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

testLayer("DelegationAuditRepository", (it) => {
  it.effect("filters audit pages to the initiating provider tool call", () =>
    Effect.gen(function* () {
      yield* migration;
      const audit = yield* DelegationAuditRepository;
      const sourceThreadId = ThreadId.make("source-tool-call");
      const sourceTurnId = TurnId.make("turn-tool-call");

      for (const [operationId, toolCallId] of [
        ["operation-selected", "provider-call-selected"],
        ["operation-other", "provider-call-other"],
      ] as const) {
        yield* audit.begin({
          operationId,
          sourceThreadId,
          sourceTurnId,
          sourceMessageId: MessageId.make("message-tool-call"),
          initiatingMessageId: MessageId.make("message-tool-call"),
          toolCallId,
          toolName: "delegate_work",
          toolVersion: "1",
          providerInstanceId: null,
          model: null,
          workspaceRoot: null,
          gitRevision: null,
          buildRevision: "server-build",
          requests: [{ attemptId: `attempt-${operationId}`, arguments: { prompt: operationId } }],
          occurredAt: "2026-09-01T00:00:00.000Z",
        });
      }

      const request: Parameters<typeof audit.page>[0] & { readonly toolCallId: string } = {
        sourceThreadId,
        turnId: sourceTurnId,
        toolCallId: "provider-call-selected",
        beforeSequence: null,
        limit: 20,
      };
      const page = yield* audit.page(request);

      assert.equal(page.events.length, 2);
      assert.isTrue(page.events.every((event) => event.context.toolCallId === request.toolCallId));
      assert.isTrue(page.events.every((event) => event.operationId === "operation-selected"));
    }),
  );

  it.effect("redacts requests before persistence and pages append-only attempt evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migration;
      const audit = yield* DelegationAuditRepository;
      const sourceThreadId = ThreadId.make("source-thread");
      const sourceTurnId = TurnId.make("source-turn");
      const sourceMessageId = MessageId.make("source-message");

      yield* audit.begin({
        operationId: "operation-1",
        sourceThreadId,
        sourceTurnId,
        sourceMessageId,
        initiatingMessageId: sourceMessageId,
        toolCallId: "call-1",
        toolName: "delegate_work",
        toolVersion: "sha256:contract",
        providerInstanceId: null,
        model: "gpt-6-luna",
        workspaceRoot: "/repo",
        gitRevision: "base-revision",
        buildRevision: "server-build",
        requests: [
          {
            attemptId: "attempt-1",
            arguments: {
              prompt:
                "Run task with client_secret=client-secret-value-123456789 --token cli-token-value-987654321",
              usage: { usedTokens: 1075, inputTokens: 824, outputTokens: 251 },
              authorization: "Bearer private-token",
            },
          },
          {
            attemptId: "attempt-2",
            arguments: { prompt: "Run the second task" },
          },
        ],
        occurredAt: "2026-09-01T00:00:00.000Z",
      });
      yield* audit.append({
        eventId: EventId.make("audit-event-rejected"),
        operationId: "operation-1",
        sourceThreadId,
        attemptId: "attempt-1",
        eventType: "turn.start.rejected",
        childThreadId: ThreadId.make("child-thread"),
        payload: {
          code: "MISSING_ACTIVE_MESSAGE",
          activeTurnId: "source-turn",
          activeMessageId: null,
          expectedInitiatingMessageId: "source-message",
        },
        occurredAt: "2026-09-01T00:00:01.000Z",
      });

      const firstPage = yield* audit.page({
        sourceThreadId,
        operationId: "operation-1",
        beforeSequence: null,
        limit: 2,
      });
      assert.equal(firstPage.events.length, 2);
      assert.isTrue(firstPage.hasMore);
      assert.equal(firstPage.events[0]?.eventType, "turn.start.rejected");
      assert.deepEqual(firstPage.events[0]?.payload, {
        code: "MISSING_ACTIVE_MESSAGE",
        activeTurnId: "source-turn",
        activeMessageId: null,
        expectedInitiatingMessageId: "source-message",
      });
      const threadPage = yield* audit.page({
        sourceThreadId,
        beforeSequence: null,
        limit: 20,
      });
      assert.isTrue(
        threadPage.warnings.some(
          (warning) =>
            warning.startsWith("Attempts without a durable completion record") &&
            warning.includes("attempt-2"),
        ),
      );

      const secondPage = yield* audit.page({
        sourceThreadId,
        operationId: "operation-1",
        beforeSequence: firstPage.nextBeforeSequence,
        limit: 2,
      });
      assert.equal(secondPage.events.length, 2);
      const persistedRequests = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM delegation_audit_events
        WHERE event_type = 'attempt.requested'
          AND operation_id = 'operation-1'
        ORDER BY sequence ASC
      `;
      assert.equal(persistedRequests.length, 2);
      assert.include(persistedRequests[0]?.payload_json ?? "", '"usedTokens":1075');
      assert.include(persistedRequests[0]?.payload_json ?? "", "[REDACTED]");
      assert.notInclude(persistedRequests[0]?.payload_json ?? "", "client-secret-value");
      assert.notInclude(persistedRequests[0]?.payload_json ?? "", "cli-token-value");
      assert.notInclude(persistedRequests[0]?.payload_json ?? "", "private-token");
    }),
  );

  it.effect(
    "redacts credentials inside prompt JSON and cookie command strings before persistence",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migration;
        const audit = yield* DelegationAuditRepository;
        const sourceThreadId = ThreadId.make("source-redaction");

        yield* audit.begin({
          operationId: "operation-redaction",
          sourceThreadId,
          sourceTurnId: null,
          sourceMessageId: null,
          initiatingMessageId: null,
          toolCallId: "call-redaction",
          toolName: "delegate_work",
          toolVersion: "1",
          providerInstanceId: null,
          model: null,
          workspaceRoot: null,
          gitRevision: null,
          buildRevision: "server-build",
          requests: [
            {
              attemptId: "attempt-redaction",
              arguments: {
                prompt: 'Use config {"password":"synthetic-password-value"}',
                command: 'curl -H "Cookie: session=synthetic-cookie-value" example.invalid',
              },
            },
          ],
          occurredAt: "2026-09-01T00:00:00.000Z",
        });

        const rows = yield* sql<{
          readonly payload_json: string;
          readonly evidence_status: string;
          readonly redacted: number;
        }>`
        SELECT payload_json, evidence_status, redacted
        FROM delegation_audit_events
        WHERE event_type = 'attempt.requested'
          AND operation_id = 'operation-redaction'
      `;

        assert.equal(rows.length, 1);
        assert.notInclude(rows[0]?.payload_json ?? "", "synthetic-password-value");
        assert.notInclude(rows[0]?.payload_json ?? "", "synthetic-cookie-value");
        assert.equal(rows[0]?.evidence_status, "redacted");
        assert.equal(rows[0]?.redacted, 1);
      }),
  );

  it.effect(
    "uses audit indexes for supplied page and child selectors with representative rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        for (let index = 0; index < 600; index += 1) {
          yield* sql`
          INSERT INTO delegation_audit_events (
            event_id,
            operation_id,
            attempt_id,
            source_thread_id,
            source_turn_id,
            source_message_id,
            child_thread_id,
            event_type,
            occurred_at,
            evidence_status,
            redacted,
            context_json,
            payload_json
          )
          VALUES (
            ${`event-plan-${index}`},
            ${`operation-${index % 8}`},
            ${`attempt-${index}`},
            ${`source-${index % 12}`},
            ${`turn-${index % 5}`},
            NULL,
            ${`child-${index % 20}`},
            'attempt.requested',
            '2026-09-01T00:00:00.000Z',
            'complete',
            0,
            '{}',
            '{}'
          )
        `;
        }
        yield* sql`ANALYZE`;

        const pagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT event_id
        FROM delegation_audit_events
        WHERE source_thread_id = 'source-1'
          AND operation_id = 'operation-1'
          AND source_turn_id = 'turn-1'
          AND sequence < 500
        ORDER BY sequence DESC
        LIMIT 50
      `;
        const childPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT operation_id, attempt_id, source_thread_id
        FROM delegation_audit_events
        WHERE child_thread_id = 'child-1'
          AND attempt_id IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
      `;
        const toolCallPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT event_id
        FROM delegation_audit_events
        WHERE source_thread_id = 'source-1'
          AND source_turn_id = 'turn-1'
          AND json_extract(context_json, '$.toolCallId') = 'provider-call-1'
          AND sequence < 500
        ORDER BY sequence DESC
        LIMIT 50
      `;
        const pagePlanDetail = pagePlan.map((row) => row.detail).join(" ");
        const childPlanDetail = childPlan.map((row) => row.detail).join(" ");
        const toolCallPlanDetail = toolCallPlan.map((row) => row.detail).join(" ");

        assert.include(pagePlanDetail, "idx_delegation_audit_thread_operation_turn_sequence");
        assert.include(childPlanDetail, "idx_delegation_audit_child_sequence");
        assert.include(toolCallPlanDetail, "idx_delegation_audit_thread_tool_call_turn_sequence");
        assert.notInclude(pagePlanDetail, "SCAN delegation_audit_events");
        assert.notInclude(childPlanDetail, "SCAN delegation_audit_events");
        assert.notInclude(toolCallPlanDetail, "SCAN delegation_audit_events");
      }),
  );

  it.effect(
    "deletes source-owned audit evidence without cascading child-attempt history early",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const audit = yield* DelegationAuditRepository;
        const sourceThreadId = ThreadId.make("source-delete");

        yield* audit.begin({
          operationId: "operation-delete",
          sourceThreadId,
          sourceTurnId: null,
          sourceMessageId: null,
          initiatingMessageId: null,
          toolCallId: "call-delete",
          toolName: "delegate_work",
          toolVersion: "sha256:contract",
          providerInstanceId: null,
          model: null,
          workspaceRoot: null,
          gitRevision: null,
          buildRevision: "server-build",
          requests: [
            {
              attemptId: "attempt-delete",
              arguments: { prompt: "safe request" },
            },
          ],
          occurredAt: "2026-09-01T00:00:00.000Z",
        });
        yield* audit.append({
          eventId: EventId.make("audit-event-child"),
          operationId: "operation-delete",
          sourceThreadId,
          attemptId: "attempt-delete",
          eventType: "thread.created",
          childThreadId: ThreadId.make("deleted-child"),
          payload: { childThreadId: "deleted-child" },
          occurredAt: "2026-09-01T00:00:01.000Z",
        });

        const beforeDelete = yield* audit.page({
          sourceThreadId,
          operationId: "operation-delete",
          beforeSequence: null,
          limit: 20,
        });
        assert.equal(beforeDelete.events.length, 3);
        yield* audit.deleteBySourceThreadId(sourceThreadId);
        const afterDelete = yield* audit.page({
          sourceThreadId,
          operationId: "operation-delete",
          beforeSequence: null,
          limit: 20,
        });
        assert.equal(afterDelete.events.length, 0);
      }),
  );
});
