import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type RunWebhookInput,
  RunWebhookPayload,
  RunWebhookResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { RunWebhookToolkit } from "../mcp/toolkits/runWebhook/tools.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Service from "./RunWebhookService.ts";
import * as Transport from "./RunWebhookTransport.ts";

const threadId = ThreadId.make("thread:webhook");
const runId = RunId.make("run:webhook");
const sessionId = AuthSessionId.make("client:webhook");
const endpoint: Transport.RunWebhookEndpoint = {
  id: "bot",
  sessionId,
  url: Redacted.make("https://hooks.example.com/completion"),
  secret: Redacted.make("test-only-signing-secret-with-32-bytes"),
  fingerprint: "test-destination",
};
const subscribe = { action: "subscribe", endpointId: "bot", threadId, runId } as const;
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:webhook"),
  requestNamespace: sessionId,
  thread: undefined,
  client: {
    sessionId,
    label: "Webhook test",
    access: "auto",
    hostedAppUrl: "https://app.t3.codes",
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "webhook-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "webhook-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerThreads = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagement.ThreadManagementService)({
      getTimelinePage: (id, options) => store.getTimelinePage(id, options).pipe(Effect.orDie),
      getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
      getProjectThreadRecords: (input, fields, filter) =>
        store.getThreadRecords(input.threadId, fields, filter).pipe(Effect.orDie),
    });
  }),
);
const layerStorage = Layer.mergeAll(AuthSessions.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

const setup = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const now = yield* DateTime.now;
  const shell = liveThreadShell(threadId);
  const thread = { ...idleThreadProjection(shell).thread, createdAt: now, updatedAt: now };
  let event = 0;
  yield* store.apply({
    id: EventId.make(`event:${event++}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: shell.providerInstanceId,
    modelSelection: shell.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:user"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${event++}`),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: run,
  });
  const createSession = (
    id: AuthSessionId,
    scopes: ReadonlyArray<"orchestration:read" | "orchestration:operate"> = [
      "orchestration:read",
      "orchestration:operate",
    ],
  ) =>
    sessions.create({
      sessionId: id,
      subject: id,
      method: "bearer-access-token",
      scopes,
      client: {
        label: "test",
        ipAddress: null,
        userAgent: null,
        deviceType: "bot",
        os: null,
        browser: null,
      },
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 30 }),
    });
  yield* createSession(sessionId);
  const setStatus = (status: OrchestrationV2Run["status"], id = runId, ordinal = 1) =>
    store.apply({
      id: EventId.make(`event:${event++}`),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...run,
        id,
        ordinal,
        status,
        completedAt: ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
          status,
        )
          ? now
          : null,
      },
    });
  const sent: Array<{ body: string; timestamp: number }> = [];
  let fail = false;
  let sendGate: Deferred.Deferred<void> | undefined;
  let sendStarted: Deferred.Deferred<void> | undefined;
  const transport = Layer.succeed(Transport.RunWebhookTransport, {
    send: (_endpoint, body, timestamp) =>
      Effect.gen(function* () {
        sent.push({ body, timestamp });
        if (sendStarted) yield* Deferred.succeed(sendStarted, undefined);
        if (sendGate) yield* Deferred.await(sendGate);
        if (fail) return yield* new Transport.RunWebhookTransportError({ reason: "network" });
      }),
  });
  const serviceLayer = Service.layer.pipe(
    Layer.provide(transport),
    Layer.provide(
      Layer.succeed(Transport.RunWebhookEndpoints, {
        endpoints: [endpoint, { ...endpoint, id: "other-bot", sessionId: "client:other" }],
      }),
    ),
  );
  const serviceContext = yield* Layer.build(serviceLayer);
  const api = Context.get(serviceContext, Service.RunWebhookService);
  const call = (input: RunWebhookInput, invocation = scope) =>
    Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      return yield* mcp.callTool({ name: "t3_run_webhook", arguments: input });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(
        McpHttpServer.layerRunWebhookToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        ),
      ),
      Effect.provideService(Service.RunWebhookService, api),
    );
  return {
    api,
    serviceLayer,
    store,
    sessions,
    now,
    sent,
    setStatus,
    call,
    createSession,
    fail: (value: boolean) => {
      fail = value;
    },
    gate: (started: Deferred.Deferred<void>, finish: Deferred.Deferred<void>) => {
      sendStarted = started;
      sendGate = finish;
    },
    deleteThread: store.apply({
      id: EventId.make("event:deleted"),
      type: "thread.deleted",
      threadId,
      occurredAt: now,
      payload: { ...thread, deletedAt: now },
    }),
  };
});

const withFixture = <A, E, R>(
  test: (fixture: Effect.Success<typeof setup>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(setup, test).pipe(
    Effect.provide(layerThreads.pipe(Layer.provideMerge(layerStorage))),
    Effect.scoped,
  );
const decodeResult = Schema.decodeUnknownEffect(RunWebhookResult);
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(RunWebhookPayload));

it.effect(
  "registers through MCP, observes durable completion and returns only message metadata",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const registered = yield* f.call(subscribe);
        const registration = yield* decodeResult(registered.structuredContent);
        expect(registration.state).toBe("active");
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(0);
        yield* f.store.apply({
          id: EventId.make("event:message"),
          type: "message.updated",
          threadId,
          occurredAt: f.now,
          payload: {
            id: MessageId.make("message:answer"),
            threadId,
            runId,
            nodeId: null,
            role: "assistant",
            text: "Sensitive answer must stay in T3",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: f.now,
            updatedAt: f.now,
          },
        });
        yield* f.store.apply({
          id: EventId.make("event:item"),
          type: "turn-item.updated",
          threadId,
          occurredAt: f.now,
          payload: {
            id: TurnItemId.make("item:answer"),
            type: "assistant_message",
            streaming: false,
            threadId,
            runId,
            messageId: MessageId.make("message:answer"),
            text: "Sensitive answer must stay in T3",
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: f.now,
            completedAt: f.now,
            updatedAt: f.now,
          },
        });
        yield* f.setStatus("completed");
        yield* TestClock.adjust("5 seconds");
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(1);
        expect(decodeBody(f.sent[0]!.body)).toMatchObject({
          threadId,
          runId,
          status: "completed",
          lastMessage: { id: "message:answer", role: "assistant" },
        });
        expect(f.sent[0]!.body).not.toContain("Sensitive answer");
        expect(f.sent[0]!.body).not.toContain(Redacted.value(endpoint.secret));
        expect(decodeBody(f.sent[0]!.body).link).toContain("https://app.t3.codes");
        const again = yield* f.call(subscribe);
        expect(again.structuredContent).toMatchObject({
          subscriptionId: registration.subscriptionId,
          state: "delivered",
        });
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(1);
      }),
    ),
);

it.effect(
  "catches an already terminal run and preserves retries and backoff across service restart",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.setStatus("failed");
        const registered = yield* f.api.manage(sessionId, subscribe, "t3-thread://test");
        f.fail(true);
        yield* f.api.runDueWork;
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(1);
        yield* TestClock.adjust("5 seconds");
        yield* Service.RunWebhookService.use((restarted) => restarted.runDueWork).pipe(
          Effect.provide(f.serviceLayer),
        );
        expect(f.sent).toHaveLength(2);
        expect(f.sent[1]!.body).toBe(f.sent[0]!.body);
        yield* TestClock.adjust("5 seconds");
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(2);
        f.fail(false);
        yield* TestClock.adjust("5 seconds");
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(3);
        expect(
          (yield* f.api.manage(sessionId, {
            action: "read",
            subscriptionId: registered.subscriptionId,
          })).state,
        ).toBe("delivered");
      }),
    ),
);

it.effect(
  "supersedes waiting retries and still delivers completion after waiting exhausts its budget",
  () =>
    Effect.gen(function* () {
      for (const failedAttempts of [0, 1, 12]) {
        yield* withFixture((f) =>
          Effect.gen(function* () {
            const registered = yield* f.api.manage(sessionId, subscribe, "link");
            yield* f.setStatus("waiting");
            f.fail(failedAttempts > 0);
            for (let attempt = 0; attempt < failedAttempts; attempt++) {
              yield* f.api.runDueWork;
              yield* TestClock.adjust("1 hour");
            }
            yield* f.api.runDueWork;
            const waiting = decodeBody(f.sent[0]!.body);
            yield* f.setStatus("completed");
            f.fail(false);
            yield* TestClock.adjust("5 seconds");
            yield* f.api.runDueWork;
            const last = decodeBody(f.sent.at(-1)!.body);
            expect(last.status).toBe("completed");
            expect(last.deliveryId).not.toBe(waiting.deliveryId);
            expect(
              (yield* f.api.manage(sessionId, {
                action: "read",
                subscriptionId: registered.subscriptionId,
              })).state,
            ).toBe("delivered");
          }),
        );
      }
    }),
);

it.effect(
  "reactivates cancelled and expired subscriptions, but preserves delivered registrations",
  () =>
    Effect.gen(function* () {
      for (const stop of ["cancel", "destination", "destination-unobserved", "expiry"] as const) {
        yield* withFixture((f) =>
          Effect.gen(function* () {
            const registered = yield* f.api.manage(sessionId, subscribe, "link");
            yield* f.setStatus("waiting");
            f.fail(true);
            yield* f.api.runDueWork;
            if (stop === "cancel")
              yield* f.api.manage(sessionId, {
                action: "cancel",
                subscriptionId: registered.subscriptionId,
              });
            if (stop === "destination" || stop === "destination-unobserved") {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE run_webhook_subscriptions SET endpoint_fingerprint = 'old-destination'`;
            }
            yield* TestClock.adjust(stop === "expiry" ? "8 days" : "5 seconds");
            if (stop !== "destination-unobserved") {
              yield* f.api.runDueWork;
              const cancelled = yield* f.api.manage(sessionId, {
                action: "cancel",
                subscriptionId: registered.subscriptionId,
              });
              expect(cancelled.state).toBe(stop === "expiry" ? "expired" : "cancelled");
            }
            const again = yield* f.api.manage(sessionId, subscribe, "new-link");
            expect(again).toMatchObject({
              subscriptionId: registered.subscriptionId,
              state: "active",
              attempts: 0,
            });
            yield* f.setStatus("completed");
            f.fail(false);
            yield* f.api.runDueWork;
            expect(decodeBody(f.sent.at(-1)!.body)).toMatchObject({
              status: "completed",
              link: "new-link",
            });
            expect(
              (yield* f.api.manage(sessionId, {
                action: "cancel",
                subscriptionId: registered.subscriptionId,
              })).state,
            ).toBe("delivered");
          }),
        );
      }
    }),
);

it.effect(
  "refuses other clients, read-only callers, thread credentials, linked callers and inaccessible runs",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const registration = yield* f.api.manage(sessionId, subscribe, "t3-thread://test");
        const other = AuthSessionId.make("client:other");
        yield* f.createSession(other);
        expect(yield* f.api.manage(other, subscribe, "link").pipe(Effect.flip)).toMatchObject({
          reason: "forbidden",
        });
        expect(
          yield* f.api
            .manage(other, { action: "read", subscriptionId: registration.subscriptionId })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        const visible = Effect.sync(
          () =>
            Context.getOrUndefined(
              RunWebhookToolkit.tools.t3_run_webhook.annotations,
              McpSchema.EnabledWhen,
            )?.({
              protocolVersion: mcpClient.protocolVersion,
              capabilities: mcpClient.clientCapabilities,
              clientInfo: mcpClient.clientInfo,
            }) ?? false,
        );
        expect(
          yield* visible.pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          ),
        ).toBe(true);
        for (const invocation of [
          { ...scope, client: { ...scope.client!, access: "read-only" as const } },
          { ...scope, capabilities: new Set<"orchestration">() },
          { ...scope, client: { ...scope.client!, linked: true } },
          {
            ...scope,
            client: undefined,
            thread: {
              threadId,
              providerSessionId: "provider",
              providerInstanceId: liveThreadShell(threadId).providerInstanceId,
            },
          },
        ]) {
          expect(
            yield* visible.pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            ),
          ).toBe(false);
          expect(
            yield* f.call(subscribe, invocation).pipe(
              Effect.match({
                onFailure: () => true,
                onSuccess: (response) => response.isError === true,
              }),
            ),
          ).toBe(true);
        }
        expect(
          yield* f.api
            .manage(sessionId, { ...subscribe, runId: RunId.make("other-run") }, "link")
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        expect(
          yield* f.api
            .manage(sessionId, { ...subscribe, threadId: ThreadId.make("missing") }, "link")
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        expect(f.sent).toHaveLength(0);
      }),
    ),
);

it.effect(
  "stops delivery after revocation, thread deletion, endpoint replacement, cancellation or expiry",
  () =>
    Effect.gen(function* () {
      for (const stop of [
        "revoked",
        "permissions",
        "session-expired",
        "deleted",
        "destination",
        "cancelled",
        "expired",
      ] as const) {
        yield* withFixture((f) =>
          Effect.gen(function* () {
            const registered = yield* f.api.manage(sessionId, subscribe, "link");
            yield* f.setStatus("completed");
            f.fail(true);
            yield* f.api.runDueWork;
            const sql = yield* SqlClient.SqlClient;
            if (stop === "revoked") yield* f.sessions.revoke({ sessionId, revokedAt: f.now });
            if (stop === "permissions")
              yield* sql`UPDATE auth_sessions SET scopes = '["orchestration:read"]' WHERE session_id = ${sessionId}`;
            if (stop === "session-expired")
              yield* sql`UPDATE auth_sessions SET expires_at = ${DateTime.formatIso(f.now)} WHERE session_id = ${sessionId}`;
            if (stop === "deleted") yield* f.deleteThread;
            if (stop === "destination")
              yield* sql`UPDATE run_webhook_subscriptions SET endpoint_fingerprint = 'old-destination'`;
            if (stop === "cancelled")
              yield* f.api.manage(sessionId, {
                action: "cancel",
                subscriptionId: registered.subscriptionId,
              });
            yield* TestClock.adjust(stop === "expired" ? "8 days" : "5 seconds");
            f.fail(false);
            yield* f.api.runDueWork;
            expect(f.sent).toHaveLength(1);
            const rows = yield* sql<{
              state: string;
              payload: string | null;
            }>`SELECT state, payload FROM run_webhook_subscriptions`;
            expect(rows[0]).toEqual({
              state: stop === "expired" ? "expired" : "cancelled",
              payload: null,
            });
          }),
        );
      }
    }),
);

it.effect("caps retries, exposes failure, and retries the same delivery only on request", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* f.setStatus("completed");
      const registered = yield* f.api.manage(sessionId, subscribe, "link");
      f.fail(true);
      for (let attempt = 0; attempt < 12; attempt++) {
        yield* f.api.runDueWork;
        yield* TestClock.adjust("1 hour");
      }
      yield* f.api.runDueWork;
      expect(f.sent).toHaveLength(12);
      expect(
        (yield* f.api.manage(sessionId, {
          action: "read",
          subscriptionId: registered.subscriptionId,
        })).state,
      ).toBe("failed");
      f.fail(false);
      yield* f.api.manage(sessionId, {
        action: "retry",
        subscriptionId: registered.subscriptionId,
      });
      yield* f.api.runDueWork;
      expect(f.sent).toHaveLength(13);
      expect(new Set(f.sent.map((entry) => entry.body)).size).toBe(1);
    }),
  ),
);

it.effect("ignores old acknowledgements after cancellation or reactivation", () =>
  Effect.forEach([false, true], (reactivate) =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* f.setStatus("completed");
        const registered = yield* f.api.manage(sessionId, subscribe, "link");
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        f.gate(started, finish);
        const worker = yield* f.api.runDueWork.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* f.api.manage(sessionId, {
          action: "cancel",
          subscriptionId: registered.subscriptionId,
        });
        if (reactivate) yield* f.api.manage(sessionId, subscribe, "new-link");
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(worker);
        expect(
          (yield* f.api.manage(sessionId, {
            action: "read",
            subscriptionId: registered.subscriptionId,
          })).state,
        ).toBe(reactivate ? "active" : "cancelled");
        if (reactivate) {
          yield* f.api.runDueWork;
          expect(f.sent).toHaveLength(2);
          expect(decodeBody(f.sent[1]!.body).deliveryId).not.toBe(
            decodeBody(f.sent[0]!.body).deliveryId,
          );
        }
      }),
    ),
  ),
);

it.effect(
  "bounds each delivery batch and gives another client a slot ahead of one client's backlog",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        for (let index = 0; index < 5; index++) {
          const id = RunId.make(`run:queued-${index}`);
          yield* f.setStatus("completed", id, index + 2);
          yield* f.api.manage(sessionId, { ...subscribe, runId: id }, "link");
        }
        const other = AuthSessionId.make("client:other");
        yield* f.createSession(other);
        yield* f.setStatus("completed");
        yield* f.api.manage(other, { ...subscribe, endpointId: "other-bot" }, "link");
        f.fail(true);
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(4);
        expect(f.sent.map((entry) => decodeBody(entry.body).runId)).toContain(runId);
        yield* f.api.runDueWork;
        expect(f.sent).toHaveLength(6);
      }),
    ),
);
