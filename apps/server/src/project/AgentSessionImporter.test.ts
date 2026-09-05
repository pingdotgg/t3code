import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  ContextHandoffServiceV2,
  layer as contextHandoffLayer,
  providerMessageWithContextHandoff,
} from "../orchestration-v2/ContextHandoffService.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { shouldPrepareLegacyImportHandoff } from "../orchestration-v2/Orchestrator.ts";
import {
  AgentSessionImportSources,
  layer as importSourcesLayer,
} from "../orchestration-v2/AgentSessionImportSources.ts";
import { importAgentSession } from "./AgentSessionImporter.ts";
import type { AgentSessionThread } from "./AgentSessionScanner.ts";

const stores = Layer.mergeAll(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.mergeAll(
  importSourcesLayer.pipe(Layer.provide(stores)),
  eventSinkLayer.pipe(Layer.provideMerge(stores)),
  contextHandoffLayer.pipe(Layer.provide(idAllocatorLayer)),
);
const projectId = ProjectId.make("project:import");
const source = (
  session: string,
  provider: "codex" | "claudeAgent" = "codex",
): AgentSessionThread => ({
  source: provider,
  providerInstanceId: ProviderInstanceId.make(provider),
  providerSessionId: session,
  title: "Imported conversation",
  model: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  messages: [
    { role: "user", text: "Remember the purple umbrella", createdAt: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", text: "The umbrella is purple", createdAt: "2026-01-02T00:00:00.000Z" },
  ],
});

it.layer(testLayer)("V2 agent session import", (it) => {
  for (const provider of ["codex", "claudeAgent"] as const) {
    it.effect(`publishes ${provider} history directly in V2 without native resume state`, () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const session = source(`visible-${provider}`, provider);
        assert.isTrue(yield* importAgentSession(projectId, session));
        const threadId = ThreadId.make(`import:${provider}:${session.providerSessionId}`);
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.thread.historyOrigin, "v1_import");
        assert.equal(projection.thread.activeProviderThreadId, null);
        assert.deepEqual(projection.providerThreads, []);
        assert.deepEqual(projection.providerSessions, []);
        assert.deepEqual(
          projection.messages.map((message) => message.text),
          session.messages.map((message) => message.text),
        );
        assert.deepEqual(
          projection.turnItems.map((item) => item.type),
          ["user_message", "assistant_message"],
        );
        assert.deepEqual(
          projection.turnItems.map((item) => item.ordinal),
          [1, 2],
        );
        assert.isTrue(projection.turnItems.every((item) => item.runId === null));
        assert.isTrue(
          shouldPrepareLegacyImportHandoff({
            historyOrigin: projection.thread.historyOrigin,
            hasCompletedRun: false,
            legacyImportItemCount: projection.turnItems.length,
          }),
        );
        const handoffService = yield* ContextHandoffServiceV2;
        const handoff = yield* handoffService.prepareLegacyImport({
          threadId,
          targetRunId: RunId.make(`first-run:${provider}`),
          toProviderThreadId: ProviderThreadId.make(`fresh:${provider}`),
          toProviderInstanceId: session.providerInstanceId,
          items: projection.turnItems,
          createdAt: projection.thread.updatedAt,
        });
        const prompt = providerMessageWithContextHandoff({ handoff, userText: "Continue" });
        assert.include(prompt, "Remember the purple umbrella");
        assert.include(prompt, "The umbrella is purple");
        assert.include(prompt, "Continue");
        const shell = yield* projections.getThreadShell(threadId);
        assert.equal(shell?.historyOrigin, "v1_import");
        const legacy =
          yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id = ${threadId}`;
        assert.deepEqual(legacy, []);
      }),
    );
  }
  it.effect("journals source identities by V2 project and excludes deleted history", () =>
    Effect.gen(function* () {
      const session = source("journal");
      const threadId = ThreadId.make("import:codex:journal");
      yield* importAgentSession(projectId, session);
      const sources = yield* AgentSessionImportSources;
      const fingerprint = {
        provider: session.source,
        providerInstanceId: session.providerInstanceId,
        providerSessionId: session.providerSessionId,
        filePath: "/session.jsonl",
        size: 100,
        mtimeMs: 1,
        device: 1,
        inode: 2,
        birthtimeMs: 1,
      };
      yield* sources.record(threadId, fingerprint);
      yield* sources.record(threadId, { ...fingerprint, size: 200 });
      assert.deepEqual(yield* sources.list(projectId), [{ ...fingerprint, size: 200 }]);
      assert.deepEqual(yield* sources.list(ProjectId.make("another-project")), []);
      const projections = yield* ProjectionStoreV2;
      const thread = yield* projections.getThread(threadId);
      const sink = yield* EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("delete:journal"),
            type: "thread.deleted",
            threadId,
            occurredAt: thread.updatedAt,
            payload: { ...thread, deletedAt: thread.updatedAt },
          },
        ],
      });
      assert.deepEqual(yield* sources.list(projectId), []);
      assert.isFalse(yield* importAgentSession(projectId, session));
    }),
  );
  it.effect("deduplicates concurrent retries and preserves subsequent edits", () =>
    Effect.gen(function* () {
      const session = source("concurrent");
      const threadId = ThreadId.make("import:codex:concurrent");
      const results = yield* Effect.all(
        [importAgentSession(projectId, session), importAgentSession(projectId, session)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results, [true, true]);
      const projections = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* projections.getThreadProjection(threadId);
      assert.equal(before.messages.length, 2);
      const sink = yield* EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:human-title"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: before.thread.updatedAt,
            payload: { ...before.thread, title: "Human title" },
          },
        ],
      });
      assert.isTrue(
        yield* importAgentSession(projectId, { ...session, title: "Changed external title" }),
      );
      assert.equal((yield* projections.getThread(threadId)).title, "Human title");
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId} AND event_type = 'thread.created'`;
      assert.equal(rows[0]?.count, 1);
      assert.isFalse(yield* importAgentSession(ProjectId.make("other-project"), session));
    }),
  );
});
