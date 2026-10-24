import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";

// Run only after stopping the isolated dev server. EventSink creates real persisted
// events so the existing mounted client receives the replacement after reconnect.
const [homeArgument, threadId] = process.argv.slice(2);
if (
  !homeArgument ||
  !threadId?.startsWith("issue-14231-repro") ||
  NodePath.resolve(homeArgument) === NodePath.join(NodeOS.homedir(), ".t3")
) {
  throw new Error(
    "Usage: node apps/server/scripts/fixtures/issue-14231-transition.ts <isolated-home> <synthetic-Q-thread>",
  );
}
const database = NodeSqliteClient.layer({
  filename: NodePath.join(NodePath.resolve(homeArgument), "userdata/statev2.sqlite"),
});
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer);
const services = EventSink.layer.pipe(
  Layer.provide(stores),
  Layer.provideMerge(database),
  Layer.provide(NodeServices.layer),
);
const decodeEvents = Schema.decodeUnknownEffect(
  Schema.toCodecJson(Schema.Array(OrchestrationV2DomainEvent)),
);
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const requests = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE thread_id=${threadId} AND status='pending'`;
  const items = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=${threadId} AND type='user_input_request' ORDER BY ordinal DESC LIMIT 1`;
  if (requests.length !== 1 || items.length !== 1)
    throw new Error("Expected one pending synthetic question");
  const oldRequest = JSON.parse(requests[0]!.payload_json);
  const oldItem = JSON.parse(items[0]!.payload_json);
  const at = "2026-10-21T12:01:00.000Z";
  const newRequest = {
    ...oldRequest,
    id: `${oldRequest.id}-next`,
    createdAt: at,
    resolvedAt: null,
  };
  const newItem = {
    ...oldItem,
    id: `${oldItem.id}-next`,
    requestId: newRequest.id,
    ordinal: oldItem.ordinal + 1,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    questions: [
      {
        ...oldItem.questions[0],
        header: "Next direction",
        question: "Which follow-up direction should we take?",
      },
    ],
  };
  const events = [
    {
      id: `${threadId}-replace-old`,
      threadId,
      occurredAt: at,
      type: "runtime-request.updated",
      payload: { ...oldRequest, status: "resolved", resolvedAt: at, decision: "cancel" },
    },
    {
      id: `${threadId}-replace-request`,
      threadId,
      occurredAt: at,
      type: "runtime-request.updated",
      payload: newRequest,
    },
    {
      id: `${threadId}-replace-item`,
      threadId,
      occurredAt: at,
      type: "turn-item.updated",
      payload: newItem,
    },
  ];
  const decoded = yield* decodeEvents(events);
  const committed = yield* sink.write({ events: decoded });
  console.log(`Committed ${committed.length} replacement events for ${threadId}`);
});
await Effect.runPromise(program.pipe(Effect.provide(services)));
