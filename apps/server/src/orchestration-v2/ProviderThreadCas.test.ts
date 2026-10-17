import { assert, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2ProviderThreadJson,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const layer = Layer.mergeAll(
  database,
  stores,
  EventSink.layer.pipe(Layer.provide(Layer.merge(stores, database))),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);

it.effect(
  "clears unchanged provider rows with omitted defaults and refuses racing roster updates",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-cas");
      const payload = {
        id: ProviderThreadId.make("provider-thread:cas"),
        driver: ProviderDriverKind.make("claude"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerSessionId: ProviderSessionId.make("session:cas"),
        appThreadId: null,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claude"),
          nativeId: "fake-native",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "dead-child", kind: "subagent" as const }],
        createdAt: now,
        updatedAt: now,
      };
      const update = (id: string, value: typeof OrchestrationV2ProviderThreadJson.Type) => ({
        id: EventId.make(id),
        type: "provider-thread.updated" as const,
        threadId,
        occurredAt: now,
        payload: value,
      });
      const read = sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${payload.id}`.pipe(
        Effect.map((rows) => rows[0]!.payload_json),
      );
      yield* sink.write({ events: [update("event:seed", payload)] });
      yield* sql`
        UPDATE orchestration_v2_projection_provider_threads
        SET payload_json = json_remove(payload_json, '$.contextUsage', '$.nativeMetadata', '$.goal')
        WHERE provider_thread_id = ${payload.id}
      `;
      const raw = yield* read;
      assert.notProperty(JSON.parse(raw), "contextUsage");
      assert.notProperty(JSON.parse(raw), "nativeMetadata");
      assert.notProperty(JSON.parse(raw), "goal");
      const expected = yield* decodeThread(raw);
      assert.notEqual(yield* ProjectionStore.encodeProviderThreadPayload(expected), raw);
      const cleared = { ...expected, pendingBackgroundTasks: [] };
      const result = yield* sink.writeIfProviderThreadUnchanged({
        expected,
        events: [update("event:clear", cleared)],
      });
      assert.isTrue(result.committed);
      const saved = yield* decodeThread(yield* read);
      assert.deepEqual(saved.pendingBackgroundTasks, []);
      assert.isFalse(
        backgroundWorkHoldsCompletion(
          derivePendingBackgroundWork({
            latestRun: { id: RunId.make("run:cas"), ordinal: 1, status: "completed" },
            providerThreads: [saved],
            turnItems: [],
            hasActiveRun: false,
          }),
        ),
      );
      const replacement = {
        ...saved,
        status: "active" as const,
        pendingBackgroundTasks: [{ taskId: "replacement-child", kind: "subagent" as const }],
      };
      yield* sink.write({ events: [update("event:replacement", replacement)] });
      const racedRaw = yield* read;
      const rejected = yield* sink.writeIfProviderThreadUnchanged({
        expected: saved,
        events: [update("event:stale-clear", cleared)],
      });
      assert.isFalse(rejected.committed);
      assert.deepEqual(rejected.storedEvents, []);
      assert.equal(yield* read, racedRaw);
    }).pipe(Effect.provide(layer)),
);
