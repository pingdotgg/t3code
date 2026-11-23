import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MilestoneEvent,
  MilestoneId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as SessionStore from "../auth/SessionStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MilestoneHub from "./MilestoneHub.ts";

const environmentId = EnvironmentId.make("environment-milestone-events-test");
const clientToken = "clientTokenWithoutDots";
const threadToken = "threadTokenWithoutDots";
const scopes: Record<string, McpInvocationContext.McpInvocationScope> = {
  [clientToken]: {
    environmentId,
    requestNamespace: "client-session",
    thread: undefined,
    client: { sessionId: "client-session", label: "Bot", access: "read-only" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  },
  [threadToken]: {
    environmentId,
    requestNamespace: "provider-session",
    thread: {
      threadId: ThreadId.make("thread-agent"),
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  },
};

const settled = (
  id: string,
  options: { readonly project?: string; readonly at?: string } = {},
): MilestoneEvent => ({
  id: MilestoneId.make(id),
  type: "thread.run_settled",
  occurredAt: options.at ?? "1970-01-01T00:00:00.000Z",
  projectId: ProjectId.make(options.project ?? "project:a"),
  threadId: ThreadId.make(`thread:${id}`),
  parentThreadId: null,
  actor: { type: "agent" },
  isSubagentChild: false,
  runId: RunId.make(`run:${id}`),
  outcome: "completed",
});

type JsonRpcResponse = {
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: number; readonly data?: unknown };
};

const serve = Effect.gen(function* () {
  const revoked = yield* Deferred.make<void>();
  yield* HttpRouter.serve(
    McpHttpServer.layerMcpTransport(McpHttpServer.layerMilestoneEvents).pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "t3-session",
          legacyCookieName: undefined,
          awaitInvalidation: (sessionId) =>
            sessionId === "client-session" ? Deferred.await(revoked) : Effect.never,
        }),
      ),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (presented) =>
            Effect.succeed(scopes[presented] as McpInvocationContext.McpThreadInvocationScope),
        }),
      ),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.build);
  const http = yield* HttpClient.HttpClient;
  const post = (
    method: string,
    params: Record<string, unknown> = {},
    options: { readonly token?: string; readonly name?: string | null; readonly id?: number } = {},
  ) => {
    const name = options.name === undefined ? params.name : options.name;
    return http.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${options.token ?? clientToken}`,
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
        ...(typeof name === "string" ? { "mcp-name": name } : {}),
      },
      body: HttpBody.text(
        JSON.stringify({
          jsonrpc: "2.0",
          id: options.id ?? 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: { "io.modelcontextprotocol/events": {} },
              },
              "io.modelcontextprotocol/clientInfo": { name: "bot", version: "1.0.0" },
            },
          },
        }),
        "application/json",
      ),
    });
  };
  const call = (...args: Parameters<typeof post>) =>
    post(...args).pipe(
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as JsonRpcResponse),
    );
  const poll = (args: Record<string, unknown>) =>
    call("events/poll", { name: "thread.run_settled", ...args }).pipe(
      Effect.map(({ result }) => ({
        cursor: result!.cursor as string,
        truncated: result!.truncated as boolean,
        hasMore: result!.hasMore as boolean,
        ids: (result!.events as ReadonlyArray<{ eventId: string }>).map((event) => event.eventId),
      })),
    );
  const stream = (args: Record<string, unknown>, id = 7) =>
    post("events/stream", { name: "thread.run_settled", ...args }, { id }).pipe(
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => line.startsWith("data: ")),
          Stream.map(
            (line) =>
              JSON.parse(line.slice("data: ".length)) as {
                readonly method: string;
                readonly params: Record<string, any>;
              },
          ),
          Stream.toQueue({ capacity: "unbounded" }),
        ),
      ),
    );
  return { post, call, poll, stream, revoke: Deferred.succeed(revoked, undefined) };
});

const layerTest = Layer.mergeAll(MilestoneHub.layer, NodeHttpServer.layerTest);

it.effect("advertises the extension and lists each milestone type to outside clients only", () =>
  Effect.gen(function* () {
    const { call } = yield* serve;
    const discovered = yield* call("server/discover");
    expect(discovered.result!.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/events": {},
    });

    const { events } = (yield* call("events/list")).result!;
    expect(events).toHaveLength(12);
    const settledType = events.find(
      (event: { name: string }) => event.name === "thread.run_settled",
    );
    expect(settledType.delivery).toEqual(["poll", "push"]);
    expect(Object.keys(settledType.inputSchema.properties)).toEqual([
      "projectIds",
      "threadIds",
      "workflowRunIds",
      "includeSubagentChildren",
    ]);
    expect(settledType.payloadSchema.properties.outcome).toBeDefined();
    const workflowType = events.find(
      (event: { name: string }) => event.name === "workflow.run_ended",
    );
    // A workflow run belongs to no project or thread, so it is picked by workflow and run.
    expect(Object.keys(workflowType.inputSchema.properties)).toEqual([
      "workflows",
      "workflowRunIds",
      "includeSubagentChildren",
    ]);
    expect((yield* call("events/list", {}, { token: threadToken })).result!.events).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("polls from now, then pages forward and says when a cursor fell behind", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { poll } = yield* serve;
    yield* hub.publish(settled("before"));

    // A null cursor starts from now: nothing earlier is replayed.
    const bootstrap = yield* poll({ cursor: null });
    expect(bootstrap).toMatchObject({ ids: [], truncated: false, hasMore: false });

    yield* hub.publish(settled("a"));
    yield* hub.publish(settled("b", { project: "project:b" }));
    yield* hub.publish(settled("c"));
    const first = yield* poll({
      cursor: bootstrap.cursor,
      arguments: { projectIds: ["project:a"] },
      maxEvents: 1,
    });
    expect(first).toMatchObject({ ids: ["a"], hasMore: true, truncated: false });
    const rest = yield* poll({ cursor: first.cursor, arguments: { projectIds: ["project:a"] } });
    expect(rest).toMatchObject({ ids: ["c"], hasMore: false });
    expect(yield* poll({ cursor: rest.cursor })).toMatchObject({ ids: [] });

    // A cursor from before a restart replays what is kept, and says some may be missing.
    expect(yield* poll({ cursor: "previous-boot.3" })).toMatchObject({
      ids: ["before", "a", "b", "c"],
      truncated: true,
    });
    yield* TestClock.adjust("10 minutes");
    yield* hub.publish(settled("fresh", { at: "1970-01-01T00:10:00.000Z" }));
    expect(yield* poll({ cursor: bootstrap.cursor, maxAgeMs: 60_000 })).toMatchObject({
      ids: ["fresh"],
      truncated: true,
    });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("rejects a mismatched Mcp-Name, an unknown event and webhook delivery", () =>
  Effect.gen(function* () {
    const { post, call } = yield* serve;
    const params = { name: "thread.run_settled", cursor: null };
    const missing = yield* post("events/poll", params, { name: null });
    expect(missing.status).toBe(400);
    expect(((yield* missing.json) as JsonRpcResponse).error?.code).toBe(-32020);
    const mismatched = yield* post("events/poll", params, { name: "thread.needs_input" });
    expect(mismatched.status).toBe(400);

    expect((yield* call("events/poll", { name: "nope", cursor: null })).error).toMatchObject({
      code: -32023,
      data: { kind: "event" },
    });
    expect(
      (yield* call("events/subscribe", {
        name: "thread.run_settled",
        delivery: { mode: "webhook", url: "https://example.com/hook", secret: "whsec_x" },
      })).error,
    ).toMatchObject({ code: -32026, data: { feature: "deliveryMode", value: "webhook" } });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("streams live milestones after active, replays from a cursor and sends heartbeats", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { stream } = yield* serve;
    yield* hub.publish(settled("a"));

    const live = yield* stream({ cursor: null, heartbeatMs: 5_000 }, 7);
    const active = yield* Queue.take(live);
    expect(active).toMatchObject({
      method: "notifications/events/active",
      params: { truncated: false, heartbeatMs: 5_000 },
    });
    expect(active.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe(7);

    yield* hub.publish(settled("b", { project: "project:b" }));
    const event = yield* Queue.take(live);
    expect(event).toMatchObject({
      method: "notifications/events/event",
      params: {
        eventId: "b",
        name: "thread.run_settled",
        data: { id: "b", projectId: "project:b" },
        _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
      },
    });

    // The heartbeat is due 5 seconds after the last message, however late the loop reads the clock.
    yield* TestClock.adjust("5 seconds");
    expect(yield* Queue.take(live)).toMatchObject({
      method: "notifications/events/heartbeat",
      params: { cursor: event.params.cursor },
    });

    const replay = yield* stream({ cursor: "previous-boot.1" }, 8);
    expect(yield* Queue.takeN(replay, 3)).toMatchObject([
      { method: "notifications/events/active", params: { truncated: true } },
      { method: "notifications/events/event", params: { eventId: "a" } },
      { method: "notifications/events/event", params: { eventId: "b" } },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends an open stream when the client's session is revoked", () =>
  Effect.gen(function* () {
    const { stream, revoke } = yield* serve;
    const live = yield* stream({ cursor: null });
    expect(yield* Queue.take(live)).toMatchObject({ method: "notifications/events/active" });

    yield* revoke;
    expect((yield* Effect.exit(Queue.take(live)))._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
