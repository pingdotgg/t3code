import { EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DelegationAuditRepositoryLive } from "./DelegationAudit.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { DelegationAuditRepository } from "../Services/DelegationAudit.ts";
import migration from "../Migrations/106_DelegationAudit.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    DelegationAuditRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

testLayer("DelegationAuditRepository", (it) => {
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
