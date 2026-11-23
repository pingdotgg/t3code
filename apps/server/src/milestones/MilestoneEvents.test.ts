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
import * as ConfigProvider from "effect/ConfigProvider";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64 from "effect/encoding/Base64";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as SessionStore from "../auth/SessionStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpWebhookTransport from "../mcp/McpWebhookTransport.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MilestoneHub from "./MilestoneHub.ts";

const environmentId = EnvironmentId.make("environment-milestone-events-test");
const clientToken = "clientTokenWithoutDots";
const threadToken = "threadTokenWithoutDots";
const hostToken = "hostTokenWithoutDots";
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
  // A script on the host: signed in as no outside client.
  [hostToken]: {
    environmentId,
    requestNamespace: "host",
    thread: undefined,
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  },
};

// The Standard Webhooks example secret: base64 of 24 bytes.
const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

/** The Standard Webhooks check a receiver runs: any `v1,` signature over id, timestamp and body. */
const signedBy = Effect.fnUntraced(function* (
  secretValue: string,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
) {
  const mac = yield* Mac.Mac;
  const bytes = Base64.decode(secretValue.slice("whsec_".length));
  if (bytes._tag === "Failure") return false;
  const key = yield* Mac.key(Mac.hmacSha256, bytes.success);
  const tag = yield* mac.sign(
    key,
    new TextEncoder().encode(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`),
  );
  return (headers["webhook-signature"] ?? "").split(" ").includes(`v1,${Base64.encode(tag)}`);
}, Effect.orDie);

interface Delivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly raw: string;
  readonly body: Record<string, any>;
  readonly reply: Deferred.Deferred<Answer>;
}

/** `open` sends the body and never ends it. */
interface Answer {
  readonly status: number;
  readonly body?: string;
  readonly open?: boolean;
}

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
  const deliveries = yield* Queue.unbounded<Delivery>();
  const replies = new Set<Delivery["reply"]>();
  // The webhook receiver: each POST waits for the test to answer it.
  const receiver = HttpRouter.add(
    "POST",
    "/hook",
    Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const raw = yield* request.text;
      const reply = yield* Deferred.make<Answer>();
      replies.add(reply);
      yield* Queue.offer(deliveries, {
        headers: request.headers,
        raw,
        body: JSON.parse(raw),
        reply,
      });
      const answer = yield* Deferred.await(reply);
      return answer.open === true
        ? HttpServerResponse.stream(
            Stream.make(new TextEncoder().encode(answer.body)).pipe(Stream.concat(Stream.never)),
            { status: answer.status, contentType: "application/json" },
          )
        : HttpServerResponse.text(answer.body ?? "", { status: answer.status });
    }, Effect.orDie),
  );
  yield* HttpRouter.serve(
    Layer.merge(McpHttpServer.layerMcpTransport(McpHttpServer.layerMilestoneEvents), receiver).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { [McpWebhookTransport.ALLOWED_HOSTS_ENV]: "127.0.0.1" },
          }),
        ),
      ),
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
        ids: (result!.events as ReadonlyArray<{ data: { id: string } }>).map(
          (event) => event.data.id,
        ),
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
  // Shutting the server down waits for open requests, so a test that stops early answers them.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(replies, (reply) => Deferred.succeed(reply, { status: 503 }), { discard: true }),
  );
  const hookUrl = `${HttpServer.formatAddress((yield* HttpServer.HttpServer).address)}/hook`;
  const answer = (delivery: Delivery, status: number, body?: string, open = false) =>
    Deferred.succeed(delivery.reply, body === undefined ? { status } : { status, body, open });
  const subscribeParams = (params: Record<string, unknown> = {}) => ({
    name: "thread.run_settled",
    delivery: { mode: "webhook", url: hookUrl, secret },
    cursor: null,
    ...params,
  });
  // Subscribes; a first subscription to the URL is verified, so this echoes the challenge.
  const subscribe = Effect.fnUntraced(function* (params: Record<string, unknown> = {}) {
    const pending = yield* Effect.forkChild(call("events/subscribe", subscribeParams(params)));
    const verification = yield* Queue.take(deliveries);
    expect(verification.body.type).toBe("verification");
    expect(yield* signedBy(secret, verification.headers, verification.raw)).toBe(true);
    yield* answer(verification, 200, JSON.stringify({ challenge: verification.body.challenge }));
    return { verification, response: yield* Fiber.join(pending) };
  });
  return {
    post,
    call,
    poll,
    stream,
    revoke: Deferred.succeed(revoked, undefined),
    deliveries,
    answer,
    subscribeParams,
    subscribe,
  };
});

const layerTest = Layer.mergeAll(
  MilestoneHub.layer,
  NodeHttpServer.layerTest,
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
);

it.effect("advertises the extension and lists each milestone type to outside clients only", () =>
  Effect.gen(function* () {
    const { call } = yield* serve;
    const discovered = yield* call("server/discover");
    expect(discovered.result!.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/events": {},
    });
    // TODO(#41158): drop with the bridge for clients predating SEP-3415.
    expect(discovered.result!.capabilities.events).toEqual({});

    const { events } = (yield* call("events/list")).result!;
    expect(events).toHaveLength(12);
    const settledType = events.find(
      (event: { name: string }) => event.name === "thread.run_settled",
    );
    for (const event of events) {
      expect(event.delivery).toEqual(["poll", "push", "webhook"]);
    }
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

it.effect("rejects a mismatched Mcp-Name, an unknown event and a bad webhook callback", () =>
  Effect.gen(function* () {
    const { post, call, deliveries, answer, subscribeParams } = yield* serve;
    const params = { name: "thread.run_settled", cursor: null };
    const missing = yield* post("events/poll", params, { name: null });
    expect(missing.status).toBe(400);
    expect(((yield* missing.json) as JsonRpcResponse).error?.code).toBe(-32020);
    const mismatched = yield* post("events/poll", params, { name: "thread.needs_input" });
    expect(mismatched.status).toBe(400);
    // TODO(#41158): drop with the bridge for clients predating SEP-3415. Subscribing needs no Mcp-Name,
    // but one that is sent must match.
    const wrongName = yield* post("events/subscribe", subscribeParams(), {
      name: "thread.needs_input",
    });
    expect(((yield* wrongName.json) as JsonRpcResponse).error?.code).toBe(-32020);
    // Arguments are checked before the endpoint hears anything.
    const badArguments = yield* call(
      "events/subscribe",
      subscribeParams({ arguments: { projectIds: "project:a" } }),
    ).pipe(Effect.forkChild);
    expect(
      yield* Effect.raceFirst(
        Effect.map(Fiber.join(badArguments), (response) => ({ answered: response.error })),
        Effect.map(Queue.take(deliveries), (delivery) => ({ posted: delivery.body })),
      ),
    ).toMatchObject({ answered: { code: -32602 } });
    const unnamed = yield* post("events/subscribe", subscribeParams(), { name: null }).pipe(
      Effect.flatMap((response) => response.json),
      Effect.forkChild,
    );
    const verification = yield* Queue.take(deliveries);
    yield* answer(verification, 200, JSON.stringify({ challenge: verification.body.challenge }));
    expect(((yield* Fiber.join(unnamed)) as JsonRpcResponse).result?.id).toMatch(/^sub_/);

    expect((yield* call("events/poll", { name: "nope", cursor: null })).error).toMatchObject({
      code: -32023,
      data: { kind: "event" },
    });

    const subscribe = (delivery: Record<string, unknown>, token = clientToken) =>
      call("events/subscribe", { name: "thread.run_settled", delivery }, { token }).pipe(
        Effect.map((response) => response.error),
      );
    const valid = { mode: "webhook", url: "https://example.com/hook", secret };
    // Webhooks need an outside client's sign-in; threads cannot see events at all.
    expect(yield* subscribe(valid, hostToken)).toMatchObject({ code: -32024 });
    expect(yield* subscribe(valid, threadToken)).toMatchObject({ code: -32023 });
    expect(yield* subscribe({ ...valid, secret: "whsec_c2hvcnQ=" })).toMatchObject({
      code: -32602,
    });
    expect(yield* subscribe({ ...valid, secret: { toString: 1 } })).toMatchObject({
      code: -32602,
    });
    // Plain http and private addresses are refused unless allowlisted.
    expect(yield* subscribe({ ...valid, url: "http://example.com/hook" })).toMatchObject({
      code: -32602,
    });
    expect(yield* subscribe({ ...valid, url: "https://10.0.0.1/hook" })).toMatchObject({
      code: -32602,
    });
    expect(
      (yield* call("events/unsubscribe", { name: "thread.run_settled", delivery: valid })).error,
    ).toMatchObject({ code: -32023, data: { kind: "subscription" } });
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
        eventId: expect.stringMatching(/^evt_[\w-]{22}$/),
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
      { method: "notifications/events/event", params: { data: { id: "a" } } },
      { method: "notifications/events/event", params: { data: { id: "b" } } },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends an open stream when the client's session is revoked", () =>
  Effect.gen(function* () {
    const { stream, revoke } = yield* serve;
    const live = yield* stream({ cursor: null });
    expect(yield* Queue.take(live)).toMatchObject({ method: "notifications/events/active" });

    yield* revoke;
    // It says why, then closes.
    expect(yield* Queue.take(live)).toMatchObject({
      method: "notifications/events/terminated",
      params: { error: { code: -32024 } },
    });
    while ((yield* Effect.exit(Queue.take(live)))._tag === "Success") {
      // The request's own response follows the notice.
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("signs like the Standard Webhooks reference", () =>
  Effect.gen(function* () {
    expect(
      yield* signedBy(
        secret,
        {
          "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
          "webhook-timestamp": "1614265330",
          "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        },
        '{"test": 2432232314}',
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("verifies a webhook endpoint and refuses one that does not echo the challenge", () =>
  Effect.gen(function* () {
    const { call, deliveries, answer, subscribe, subscribeParams } = yield* serve;
    const at = (url: string) =>
      call(
        "events/subscribe",
        subscribeParams({ delivery: { mode: "webhook", url, secret } }),
      ).pipe(Effect.forkChild);
    const wrongUrl = `${subscribeParams().delivery.url}?wrong`;
    const failing = yield* at(wrongUrl);
    const wrong = yield* Queue.take(deliveries);
    yield* answer(wrong, 200, JSON.stringify({ challenge: "not-it" }));
    expect((yield* Fiber.join(failing)).error).toMatchObject({
      code: -32027,
      data: { reason: "challenge_failed" },
    });
    // A failure is remembered, so subscribing again answers without another POST.
    const again = yield* at(wrongUrl);
    const repeated = yield* Effect.raceFirst(
      Effect.map(Fiber.join(again), (response) => ({ cached: response.error })),
      Effect.map(Queue.take(deliveries), (delivery) => ({ posted: delivery.body })),
    );
    expect(repeated).toMatchObject({
      cached: { code: -32027, data: { reason: "challenge_failed" } },
    });

    // At most 8 KiB of the answer is read: exactly that passes, and one byte more fails at
    // once, even from an endpoint that never ends its answer.
    const echoOfLength = (challenge: string, length: number) => {
      const bare = JSON.stringify({ challenge, padding: "" });
      return JSON.stringify({ challenge, padding: "x".repeat(length - bare.length) });
    };
    const exact = yield* at(`${subscribeParams().delivery.url}?exact`);
    const fits = yield* Queue.take(deliveries);
    yield* answer(fits, 200, echoOfLength(fits.body.challenge, 8_192));
    expect((yield* Fiber.join(exact)).error).toBeUndefined();
    const long = yield* at(`${subscribeParams().delivery.url}?long`);
    const padded = yield* Queue.take(deliveries);
    yield* answer(padded, 200, echoOfLength(padded.body.challenge, 8_193), true);
    expect((yield* Fiber.join(long)).error).toMatchObject({
      code: -32027,
      data: { reason: "challenge_failed" },
    });

    const { verification, response } = yield* subscribe();
    expect(verification.headers["webhook-id"]).toMatch(/^msg_verification_[\w-]+$/);
    expect(verification.headers["x-mcp-subscription-id"]).toBe(response.result!.id);
    expect(response.result).toMatchObject({
      id: expect.stringMatching(/^sub_[0-9a-f]{32}$/),
      truncated: false,
    });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("delivers one signed event at a time and advances the cursor once each resolves", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { call, deliveries, answer, subscribe, subscribeParams } = yield* serve;
    const { response } = yield* subscribe({ ttlMs: 600_000 });
    const subscribed = response.result!;
    const refresh = (params: Record<string, unknown> = {}) =>
      call("events/subscribe", subscribeParams({ ttlMs: 600_000, ...params })).pipe(
        Effect.map((refreshed) => refreshed.result!),
      );

    yield* hub.publish(settled("a"));
    yield* hub.publish(settled("b"));
    const first = yield* Queue.take(deliveries);
    expect(first.body).toMatchObject({ data: { id: "a" }, name: "thread.run_settled" });
    // TODO(#41158): drop with the bridge for clients predating SEP-3415. An event's webhook-id is its eventId.
    expect(first.body.eventId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.headers["webhook-id"]).toBe(first.body.eventId);
    expect(first.headers["x-mcp-subscription-id"]).toBe(subscribed.id);
    expect(yield* signedBy(secret, first.headers, first.raw)).toBe(true);
    yield* answer(first, 500);
    // Unresolved, so the refresh still reports where the subscription started.
    expect(yield* refresh()).toMatchObject({
      id: subscribed.id,
      cursor: subscribed.cursor,
      deliveryStatus: { active: true, lastError: "http_5xx" },
    });

    // "b" waits for "a": the next POST is its retry, which keeps its webhook-id with a fresh
    // timestamp and signature.
    yield* TestClock.adjust("30 seconds");
    const retry = yield* Queue.take(deliveries);
    expect(retry.body.data.id).toBe("a");
    expect(retry.headers["webhook-id"]).toBe(first.headers["webhook-id"]);
    expect(retry.headers["webhook-timestamp"]).not.toBe(first.headers["webhook-timestamp"]);
    expect(yield* signedBy(secret, retry.headers, retry.raw)).toBe(true);
    yield* answer(retry, 200);

    // Only after "a" resolved does "b" go out; a 410 gives it up without a retry.
    const second = yield* Queue.take(deliveries);
    expect(second.body.data.id).toBe("b");
    expect(yield* refresh()).toMatchObject({
      cursor: first.body.cursor,
      deliveryStatus: { lastError: null, lastDeliveryAt: expect.any(String) },
    });
    yield* answer(second, 410);
    // A new secret signs alongside the old one for a grace period.
    const rotated = "whsec_" + Buffer.alloc(32, 7).toString("base64");
    yield* refresh({
      delivery: { mode: "webhook", url: subscribeParams().delivery.url, secret: rotated },
    });
    yield* hub.publish(settled("c"));
    const third = yield* Queue.take(deliveries);
    expect(third.body.data.id).toBe("c");
    expect(yield* signedBy(secret, third.headers, third.raw)).toBe(true);
    expect(yield* signedBy(rotated, third.headers, third.raw)).toBe(true);
    expect(
      (yield* refresh({
        delivery: { mode: "webhook", url: subscribeParams().delivery.url, secret: rotated },
      })).cursor,
    ).toBe(second.body.cursor);
    yield* answer(third, 200);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("reports a gap the endpoint never took on the next refresh", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { call, deliveries, answer, subscribe, subscribeParams } = yield* serve;
    const filter = { arguments: { projectIds: ["project:a"] } };
    yield* subscribe(filter);
    yield* hub.publish(settled("a"));
    const first = yield* Queue.take(deliveries);
    // While "a" is out, more milestones than the subscription's backlog go by elsewhere.
    for (let index = 0; index < 300; index++) {
      yield* hub.publish(settled(`elsewhere-${index}`, { project: "project:b" }));
    }
    yield* answer(first, 200);
    const gap = yield* Queue.take(deliveries);
    expect(gap.body).toMatchObject({ type: "gap" });
    yield* answer(gap, 410);
    // "c" goes out only after the gap was given up on.
    yield* hub.publish(settled("c"));
    const next = yield* Queue.take(deliveries);
    expect(next.body.data.id).toBe("c");
    const refresh = (cursor: string) =>
      call("events/subscribe", subscribeParams({ ...filter, cursor })).pipe(
        Effect.map(({ result }) => result!),
      );
    // Until the client shows a cursor from past the gap, as if each answer were lost.
    const refreshed = yield* refresh(first.body.cursor);
    expect(refreshed.truncated).toBe(true);
    expect(refreshed.cursor).not.toBe(first.body.cursor);
    expect((yield* refresh(first.body.cursor)).truncated).toBe(true);
    expect((yield* refresh(refreshed.cursor)).truncated).toBe(false);
    yield* answer(next, 200);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("gives each subscription to one URL its own delivery id for an event", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { call, deliveries, answer, subscribe, subscribeParams } = yield* serve;
    yield* subscribe();
    yield* call("events/subscribe", subscribeParams({ arguments: { projectIds: ["project:a"] } }));
    yield* hub.publish(settled("a"));
    const both = [yield* Queue.take(deliveries), yield* Queue.take(deliveries)];
    for (const delivery of both) {
      expect(delivery.body.data.id).toBe("a");
      expect(delivery.headers["webhook-id"]).toBe(delivery.body.eventId);
      yield* answer(delivery, 200);
    }
    expect(both[0]!.headers["webhook-id"]).not.toBe(both[1]!.headers["webhook-id"]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("gives an event up after five attempts", () =>
  Effect.gen(function* () {
    const hub = yield* MilestoneHub.MilestoneHub;
    const { deliveries, answer, subscribe } = yield* serve;
    yield* subscribe();
    yield* hub.publish(settled("a"));
    for (const wait of ["30 seconds", "1 minute", "2 minutes", "4 minutes"] as const) {
      yield* answer(yield* Queue.take(deliveries), 503);
      yield* TestClock.adjust(wait);
    }
    const last = yield* Queue.take(deliveries);
    expect(last.body.data.id).toBe("a");
    yield* answer(last, 503);
    yield* hub.publish(settled("b"));
    const next = yield* Queue.take(deliveries);
    expect(next.body.data.id).toBe("b");
    yield* answer(next, 200);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("grants a finite TTL and keeps one id for the same subscription", () =>
  Effect.gen(function* () {
    const { call, subscribe, subscribeParams } = yield* serve;
    const { response } = yield* subscribe({ ttlMs: 1_000 });
    // The test clock starts at the epoch; a grant is clamped to between a minute and an hour.
    const hour = "1970-01-01T01:00:00.000Z";
    expect(response.result!.refreshBefore).toBe("1970-01-01T00:01:00.000Z");
    const grant = (params: Record<string, unknown>) =>
      call("events/subscribe", subscribeParams(params)).pipe(Effect.map(({ result }) => result!));
    expect((yield* grant({ ttlMs: null })).refreshBefore).toBe(hour);
    expect((yield* grant({ ttlMs: 86_400_000 })).refreshBefore).toBe(hour);
    expect((yield* grant({})).refreshBefore).toBe("1970-01-01T00:15:00.000Z");

    // Arguments compare as canonical JSON; a different filter is another subscription.
    const ordered = yield* grant({
      arguments: { projectIds: ["project:a"], includeSubagentChildren: true },
    });
    const reordered = yield* grant({
      arguments: { includeSubagentChildren: true, projectIds: ["project:a"] },
    });
    expect(reordered.id).toBe(ordered.id);
    expect(reordered.deliveryStatus).toBeDefined();
    expect(ordered.id).not.toBe(response.result!.id);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends a subscription at a deadline a refresh brought forward", () =>
  Effect.gen(function* () {
    const { call, subscribe, subscribeParams } = yield* serve;
    yield* subscribe({ ttlMs: 3_600_000 });
    const grant = (ttlMs: number) =>
      call("events/subscribe", subscribeParams({ ttlMs })).pipe(
        Effect.map(({ result }) => result!),
      );
    expect(yield* grant(60_000)).toMatchObject({
      refreshBefore: "1970-01-01T00:01:00.000Z",
      deliveryStatus: { active: true },
    });
    yield* TestClock.adjust("1 minute");
    // Gone, so subscribing again starts a new subscription rather than refreshing a live one.
    expect((yield* grant(3_600_000)).deliveryStatus).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("refuses subscribes past the per-client cap even when they arrive together", () =>
  Effect.gen(function* () {
    const { call, deliveries, answer, subscribeParams } = yield* serve;
    const fibers = yield* Effect.forEach(
      Array.from({ length: 101 }, (_, index) => index),
      (index) =>
        call(
          "events/subscribe",
          subscribeParams({ arguments: { threadIds: [`thread:${index}`] } }),
        ).pipe(Effect.forkChild),
    );
    // They share one verification; while it is pending each holds a slot, so one is refused now.
    const verification = yield* Queue.take(deliveries);
    const refused = yield* Effect.raceAll(fibers.map(Fiber.join));
    expect(refused.error).toMatchObject({
      code: -32025,
      data: { limit: "subscriptions", max: 100 },
    });
    yield* answer(verification, 200, JSON.stringify({ challenge: verification.body.challenge }));
    const responses = yield* Effect.forEach(fibers, Fiber.join);
    expect(responses.filter((response) => response.result !== undefined)).toHaveLength(100);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends a webhook subscription with terminated when the client's session is revoked", () =>
  Effect.gen(function* () {
    const { deliveries, answer, subscribe, revoke } = yield* serve;
    yield* subscribe();
    yield* revoke;
    const terminated = yield* Queue.take(deliveries);
    expect(terminated.headers["webhook-id"]).toMatch(/^msg_terminated_/);
    expect(terminated.body).toMatchObject({ type: "terminated", error: { code: -32024 } });
    yield* answer(terminated, 200);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
