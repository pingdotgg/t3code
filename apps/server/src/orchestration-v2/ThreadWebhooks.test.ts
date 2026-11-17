import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  ThreadWebhookEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadWebhooks from "./ThreadWebhooks.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(ThreadWebhookEvent));

const stores = Layer.mergeAll(
  CommandReceiptStore.layer,
  EffectOutbox.layer,
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  ThreadWebhooks.layer,
  TurnItemPositionStore.layer,
);
const layer = EventSink.layerFromStores.pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(Sqlite.layerMemory),
);
const endpoint = {
  id: "grok",
  url: "http://127.0.0.1:12345/callback",
  token: Redacted.make("private-test-token"),
};

const setup = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("webhook-thread");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Webhook test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: RunId.make("run"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message"),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      { id: EventId.make("run"), type: "run.created", threadId, occurredAt: now, payload: run },
      {
        id: EventId.make("node"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: NodeId.make("root"),
          threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId: NodeId.make("root"),
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
    ],
  });
  const request: OrchestrationV2RuntimeRequest = {
    id: RuntimeRequestId.make("question"),
    nodeId: NodeId.make("root"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  };
  const question = (id: string, payload = request) => ({
    id: EventId.make(id),
    type: "runtime-request.updated" as const,
    threadId,
    occurredAt: now,
    payload,
  });
  return { sink, now, thread, run, request, question };
});

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ delivery_id: string; payload_json: string; attempt_count: number }>`
    SELECT delivery_id, payload_json, attempt_count FROM pulsar_thread_webhook_outbox ORDER BY delivery_id
  `;
});

it.effect(
  "commits notifications with events, suppresses repeated states, and rolls back failed batches",
  () =>
    Effect.gen(function* () {
      const { sink, now, thread, run, request, question } = yield* setup;
      const webhooks = yield* ThreadWebhooks.ThreadWebhooks;
      const failed = yield* sink
        .write({
          events: [
            question("rolled-back-question"),
            {
              id: EventId.make("duplicate-ordinal"),
              type: "run.created",
              threadId: thread.id,
              occurredAt: now,
              payload: { ...run, id: RunId.make("conflicting-run") },
            },
          ],
        })
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.lengthOf(yield* rows, 0);
      assert.isUndefined(
        yield* (yield* ProjectionStore.ProjectionStoreV2).getRuntimeRequest(thread.id, request.id),
      );

      yield* sink.write({ events: [question("question"), question("repeated-question")] });
      yield* webhooks.awaitAvailable;
      const [queued] = yield* rows;
      assert.isDefined(queued);
      const decoded = yield* decodeEvent(queued!.payload_json);
      assert.equal(decoded.type, "thread.user-input.requested");
      assert.equal(decoded.runId, run.id);
      assert.equal(decoded.deliveryId, "grok:question");
      assert.lengthOf(yield* rows, 1);

      yield* sink.write({
        events: [
          question("approval", {
            ...request,
            id: RuntimeRequestId.make("approval"),
            kind: "permission",
          }),
          {
            id: EventId.make("terminal"),
            type: "run.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("same-terminal"),
            type: "run.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      const notifications = yield* Effect.forEach(yield* rows, (row) =>
        decodeEvent(row.payload_json),
      );
      assert.deepEqual(notifications.map((event) => event.type).sort(), [
        "thread.approval.requested",
        "thread.run.terminal",
        "thread.user-input.requested",
      ]);
      assert.isFalse(notifications.some((event) => "settled" in event));
    }).pipe(Effect.provide(layer), Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect(
  "retries after restart with the same delivery id and keeps authorization out of durable payloads",
  () =>
    Effect.gen(function* () {
      const requests: Array<{ authorization: string | null; key: string | null; body: string }> =
        [];
      let responseStatus = 202;
      const fetch: typeof globalThis.fetch = (_url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("Authorization"),
          key: headers.get("Idempotency-Key"),
          body: String(init?.body),
        });
        return Promise.resolve(new Response(null, { status: responseStatus }));
      };
      yield* Effect.gen(function* () {
        const { sink, question } = yield* setup;
        const service = yield* ThreadWebhooks.ThreadWebhooks;
        yield* sink.write({ events: [question("retry")] });
        assert.equal(yield* service.deliverPending, 1000);
        assert.equal((yield* rows)[0]?.attempt_count, 1);
        assert.notInclude((yield* rows)[0]!.payload_json, "private-test-token");
        yield* TestClock.adjust("1 second");
        responseStatus = 200;
        // Rebuild only the delivery service against the same committed database.
        yield* Effect.gen(function* () {
          const restarted = yield* ThreadWebhooks.ThreadWebhooks;
          assert.isUndefined(yield* restarted.deliverPending);
        }).pipe(Effect.provide(Layer.fresh(ThreadWebhooks.layer)));
        assert.lengthOf(yield* rows, 0);
        assert.lengthOf(requests, 2);
        assert.equal(requests[0]?.authorization, "Bearer private-test-token");
        assert.equal(requests[0]?.key, "grok:retry");
        assert.deepEqual(requests[1], requests[0]);
      }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
    }).pipe(Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect(
  "notifies about active provider limits and error state changes without repeating retry counters",
  () =>
    Effect.gen(function* () {
      const { sink, now, thread, run } = yield* setup;
      const item: Extract<OrchestrationV2TurnItem, { type: "error" }> = {
        id: TurnItemId.make("limit-error"),
        threadId: thread.id,
        runId: run.id,
        nodeId: NodeId.make("root"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "Provider limit",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "error",
        failure: {
          class: "usage_limit",
          message: "private-provider-message",
          code: null,
          retryable: true,
        },
        retry: { attempt: 1, maxAttempts: null, retryDelayMs: null },
      };
      const write = (id: string, payload: typeof item) =>
        sink.write({
          events: [
            {
              id: EventId.make(id),
              type: "turn-item.updated",
              threadId: thread.id,
              occurredAt: now,
              payload,
            },
          ],
        });
      yield* write("limit", item);
      yield* write("retry-counter", {
        ...item,
        retry: { attempt: 2, maxAttempts: null, retryDelayMs: null },
      });
      yield* write("limit-failed", { ...item, status: "failed", completedAt: now });
      yield* write("repeat-failed", { ...item, status: "failed", completedAt: now });
      yield* write("class-change", {
        ...item,
        status: "failed",
        failure: { ...item.failure, class: "transport_error" },
      });
      const notifications = yield* Effect.forEach(yield* rows, (row) =>
        decodeEvent(row.payload_json),
      );
      assert.deepEqual(
        notifications.map((event) => event.type),
        ["thread.provider-error", "thread.provider-error", "thread.provider-error"],
      );
      assert.deepEqual(
        notifications.map((event) => event.status),
        ["failed", "running", "failed"],
      );
      for (const row of yield* rows)
        assert.notInclude(row.payload_json, "private-provider-message");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ status: string }>`SELECT status FROM orchestration_v2_projection_runs`)[0]
          ?.status,
        "running",
      );
    }).pipe(Effect.provide(layer), Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect.each(["usage_limited", "budget_limited"] as const)(
  "notifies once when a provider goal becomes %s",
  (status) =>
    Effect.gen(function* () {
      const { sink, now, thread } = yield* setup;
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("provider-thread"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: null,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: { objective: "private-goal-objective", status },
        createdAt: now,
        updatedAt: now,
      };
      yield* sink.write({
        events: ["goal-blocked", "same-goal-blocked"].map((id) => ({
          id: EventId.make(id),
          type: "provider-thread.updated",
          threadId: thread.id,
          occurredAt: now,
          payload: providerThread,
        })),
      });
      const queued = yield* rows;
      assert.lengthOf(queued, 1);
      const notification = yield* decodeEvent(queued[0]!.payload_json);
      assert.equal(notification.type, "thread.goal.blocked");
      assert.equal(notification.status, status);
      assert.isNull(notification.runId);
      assert.notInclude(queued[0]!.payload_json, "private-goal-objective");
    }).pipe(Effect.provide(layer), Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect("keeps removed or changed destinations dormant", () =>
  Effect.gen(function* () {
    const { sink, question } = yield* setup;
    yield* sink.write({ events: [question("removed")] });
    for (const endpoints of [[], [{ ...endpoint, url: "http://127.0.0.1:12345/different" }]]) {
      yield* Effect.gen(function* () {
        assert.isUndefined(yield* (yield* ThreadWebhooks.ThreadWebhooks).deliverPending);
      }).pipe(
        Effect.provide(Layer.fresh(ThreadWebhooks.layer)),
        Effect.provideService(ThreadWebhooks.Configuration, endpoints),
      );
      assert.lengthOf(yield* rows, 1);
    }
  }).pipe(Effect.provide(layer), Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect(
  "aborts stalled HTTP at the request timeout and persists a retry without following redirects",
  () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      let redirect: string | undefined;
      const fetch: typeof globalThis.fetch = (_url, init) => {
        redirect = init?.redirect;
        init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        started.resolve();
        return new Promise<Response>(() => {});
      };
      yield* Effect.gen(function* () {
        const { sink, question } = yield* setup;
        const service = yield* ThreadWebhooks.ThreadWebhooks;
        yield* sink.write({ events: [question("timeout")] });
        const delivery = yield* Effect.forkScoped(service.deliverPending);
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* Fiber.join(delivery), 11_000);
        yield* Effect.promise(() => aborted.promise);
        assert.equal(redirect, "error");
        assert.equal((yield* rows)[0]?.attempt_count, 1);
      }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
    }).pipe(Effect.provideService(ThreadWebhooks.Configuration, [endpoint]), Effect.scoped),
);

it.live("rejects a real HTTP redirect and cancels an accepted response body", () =>
  Effect.gen(function* () {
    const bodyClosed = yield* Deferred.make<void>();
    let redirect = true;
    let forwarded = 0;
    const server = yield* HttpRouter.serve(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          yield* router.add(
            "POST",
            "/callback",
            Effect.sync(() =>
              redirect
                ? HttpServerResponse.empty({ status: 302, headers: { location: "/unexpected" } })
                : HttpServerResponse.stream(
                    Stream.make(new Uint8Array([1])).pipe(
                      Stream.concat(Stream.never),
                      Stream.ensuring(Deferred.succeed(bodyClosed, undefined)),
                    ),
                  ),
            ),
          );
          yield* router.add(
            "POST",
            "/unexpected",
            Effect.sync(() => {
              forwarded += 1;
              return HttpServerResponse.empty();
            }),
          );
        }),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.build);
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected a TCP server.");
    yield* Effect.gen(function* () {
      const { sink, question } = yield* setup;
      const service = yield* ThreadWebhooks.ThreadWebhooks;
      yield* sink.write({ events: [question("redirect")] });
      yield* service.deliverPending;
      assert.equal((yield* rows)[0]?.attempt_count, 1);
      assert.equal(forwarded, 0);
      redirect = false;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE pulsar_thread_webhook_outbox SET next_attempt_at = 0`;
      yield* service.deliverPending;
      yield* Deferred.await(bodyClosed);
      assert.lengthOf(yield* rows, 0);
      assert.equal(forwarded, 0);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ThreadWebhooks.Configuration, [
        {
          ...endpoint,
          url: `http://127.0.0.1:${address.port}/callback`,
        },
      ]),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("interrupts in-flight delivery at worker shutdown and recovers the committed row", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const fetch: typeof globalThis.fetch = (_url, init) => {
      init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      return new Promise<Response>(() => {});
    };
    yield* Effect.gen(function* () {
      const { sink, question } = yield* setup;
      yield* sink.write({ events: [question("shutdown")] });
      yield* Effect.promise(() => started.promise).pipe(Effect.provide(ThreadWebhooks.layerWorker));
      yield* Effect.promise(() => aborted.promise);
      assert.equal((yield* rows)[0]?.attempt_count, 0);
      yield* (yield* ThreadWebhooks.ThreadWebhooks).deliverPending.pipe(
        Effect.provideService(FetchHttpClient.Fetch, () =>
          Promise.resolve(new Response(null, { status: 200 })),
        ),
      );
      assert.lengthOf(yield* rows, 0);
    }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
  }).pipe(Effect.provideService(ThreadWebhooks.Configuration, [endpoint])),
);

it.effect("only captures matching project and thread filters and defaults to disabled", () =>
  Effect.gen(function* () {
    const { sink, question } = yield* setup;
    yield* sink.write({ events: [question("disabled")] });
    assert.lengthOf(yield* rows, 0);
    assert.isUndefined(yield* (yield* ThreadWebhooks.ThreadWebhooks).deliverPending);
  }).pipe(Effect.provide(layer)),
);

it.effect("requires both configured filters to match", () =>
  Effect.gen(function* () {
    const { sink, question } = yield* setup;
    yield* sink.write({ events: [question("filtered")] });
    assert.deepEqual(
      (yield* rows).map((row) => row.delivery_id),
      ["matching:filtered"],
    );
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(ThreadWebhooks.Configuration, [
      { ...endpoint, id: "wrong-project", projectIds: [ProjectId.make("other")] },
      { ...endpoint, id: "wrong-thread", threadIds: [ThreadId.make("other")] },
      {
        ...endpoint,
        id: "matching",
        projectIds: [ProjectId.make("project")],
        threadIds: [ThreadId.make("webhook-thread")],
      },
    ]),
  ),
);

it.effect(
  "loads private host configuration and reports invalid data without exposing credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const filename = path.join(config.stateDir, "thread-webhooks.json");
      const load = Effect.service(ThreadWebhooks.Configuration).pipe(
        Effect.provide(Layer.fresh(ThreadWebhooks.layerConfiguration)),
      );
      assert.deepEqual(yield* load, []);
      yield* fs.writeFileString(
        filename,
        '[{"id":"grok","url":"https://example.com/hook","token":"hidden-token"}]',
        { mode: 0o600 },
      );
      const [loaded] = yield* load;
      assert.equal(loaded?.id, "grok");
      assert.equal(Redacted.value(loaded!.token), "hidden-token");
      yield* fs.writeFileString(
        filename,
        '[{"id":"grok","url":"ftp://example.com","token":"hidden-token"}]',
      );
      const invalid = yield* load.pipe(Effect.flip);
      assert.equal(invalid.reason, "invalid");
      assert.notInclude(String(invalid), "hidden-token");
      if ((yield* HostProcess.Platform) !== "win32") {
        yield* fs.chmod(filename, 0o644);
        assert.equal((yield* load.pipe(Effect.flip)).reason, "permissions");
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "thread-webhook-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("initializes its schema repeatedly without changing the upstream migration ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* Effect.service(ThreadWebhooks.ThreadWebhooks).pipe(
      Effect.provide(Layer.fresh(ThreadWebhooks.layer)),
    );
    yield* Effect.service(ThreadWebhooks.ThreadWebhooks).pipe(
      Effect.provide(Layer.fresh(ThreadWebhooks.layer)),
    );
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
    assert.equal(before.at(-1)?.migration_id, 81);
    assert.lengthOf(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'pulsar_thread_webhook_outbox_due_idx'`,
      1,
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
