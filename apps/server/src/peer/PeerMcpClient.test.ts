import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestrationV2LinkedSender,
  OrchestratorMcpFailure,
  type PeerLink,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const Result = Schema.Struct({ modes: Schema.String });
const toolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Returns this request's mode limits.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("hold", {
    description: "Holds a tool request open.",
    success: Result,
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("refuse", {
    description: "Refuses the call.",
    success: Result,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

/** One `probe` call to a linked peer at a remote address, answered by `http`. */
const probeThrough = Effect.fn(function* (http: HttpClient.HttpClient) {
  const box = descriptorOf("environment-box", "Box");
  const context = yield* Layer.build(
    PeerMcpClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () =>
              Effect.succeed({
                link: {
                  environmentId: box.environmentId,
                  label: box.label,
                  urls: ["https://peer.example"],
                  access: "auto",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1),
                  lastReachedAt: null,
                  lastError: null,
                },
                url: "https://peer.example",
                token: "fixture",
              }),
            recordOutcome: () => Effect.void,
          }),
        ),
      ),
    ),
  );
  return Context.get(context, PeerMcpClient.PeerMcpClient).call({
    environmentId: box.environmentId,
    tool: "probe",
    arguments: {},
    limits: { runtimeMode: "approval-required", interactionMode: "plan" },
    success: Result,
  });
});

const probeTools = JSON.stringify({
  result: { tools: [{ name: "probe", inputSchema: { properties: {} } }] },
});

const probeResult = JSON.stringify({
  result: { content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }] },
});

const refusal = new OrchestratorMcpFailure({
  code: "thread_not_found",
  message: "Thread thread-gone was not found.",
});

const senderToolkit = Toolkit.make(
  Tool.make("sender", {
    description: "Returns the thread this request is made for.",
    success: Schema.Struct({ senderThread: Schema.NullOr(OrchestrationV2LinkedSender) }),
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

it.effect("tells the peer which thread a call is made for", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(senderToolkit, {
        sender: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.map((scope) => ({ senderThread: scope.client?.senderThread ?? null })),
          ),
        ),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(senderToolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      // A thread id may hold any character; it arrives as sent.
      const sender = {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("import:claude/orc lead"),
        title: "orc lead / opus → fable",
      };
      const call = (input: { readonly sender?: typeof sender }) =>
        client.call({
          environmentId: box.environmentId,
          tool: "sender",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          ...input,
          success: Schema.Struct({ senderThread: Schema.NullOr(OrchestrationV2LinkedSender) }),
        });
      expect(yield* call({ sender })).toEqual({ senderThread: sender });
      expect(yield* call({})).toEqual({ senderThread: null });
      // A long title is cut to whole characters rather than breaking the call.
      const long = yield* call({ sender: { ...sender, title: "🧵".repeat(5000) } });
      expect(long.senderThread?.title).toBe("🧵".repeat(200));
      // A title holding an unpaired surrogate still lets the call through.
      const broken = yield* call({ sender: { ...sender, title: "Review \ud800" } });
      expect(broken.senderThread?.title).toBe("Review \ufffd");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect.each([false, true])(
  "reuses an initialized session before its first call finishes (cancelled: %s)",
  (cancelFirst) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const modes = McpInvocationContext.McpInvocationContext.pipe(
          Effect.map((scope) => {
            const ceiling = McpInvocationContext.clientModeCeiling(scope.client);
            return { modes: `${ceiling.runtimeMode}/${ceiling.interactionMode}` };
          }),
        );
        const handlers = McpToolAccess.toLayer(toolkit, {
          probe: McpToolAccess.reads(() => modes),
          refuse: McpToolAccess.reads(() => Effect.fail(refusal)),
          hold: McpToolAccess.reads(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(modes),
            ),
          ),
        });
        const box = descriptorOf("environment-box", "Box");
        const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
        const context = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-a", "A")),
        );
        const links = Context.get(context, PeerLinks.PeerLinks);
        const client = Context.get(context, PeerMcpClient.PeerMcpClient);
        yield* linkTo(links, b);
        const held = yield* client
          .call({
            environmentId: box.environmentId,
            tool: "hold",
            arguments: {},
            limits: { runtimeMode: "full-access", interactionMode: "default" },
            success: Result,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        if (cancelFirst) yield* Fiber.interrupt(held);
        const before = (yield* Ref.get(b.bearers)).length;
        expect(
          yield* client.call({
            environmentId: box.environmentId,
            tool: "probe",
            arguments: {},
            limits: { runtimeMode: "approval-required", interactionMode: "plan" },
            success: Result,
          }),
        ).toEqual({ modes: "approval-required/plan" });
        // One tool POST; no second initialize or initialized notification.
        expect((yield* Ref.get(b.bearers)).length - before).toBe(1);
        yield* Deferred.succeed(release, undefined);
        if (!cancelFirst) expect(yield* Fiber.join(held)).toEqual({ modes: "auto/default" });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps a link healthy when the peer refuses a call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        hold: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        refuse: McpToolAccess.reads(() => Effect.fail(refusal)),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      yield* linkTo(links, b);
      yield* links.recordOutcome(box.environmentId, { error: "earlier outage" });
      const refused = yield* client
        .call({
          environmentId: box.environmentId,
          tool: "refuse",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: Result,
        })
        .pipe(Effect.flip);
      // The agent hears the peer's own refusal; the link answered, so it is not failing.
      expect(refused).toMatchObject({ code: refusal.code, message: refusal.message });
      const link = yield* links.get(box.environmentId);
      expect(link._tag === "Some" ? link.value.lastError : "missing").toBeNull();
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps the expiry the peer answers with, so a used link outlives its first 30 days", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handlers = McpToolAccess.toLayer(toolkit, {
        probe: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        hold: McpToolAccess.reads(() => Effect.succeed({ modes: "" })),
        refuse: McpToolAccess.reads(() => Effect.fail(refusal)),
      });
      const box = descriptorOf("environment-box", "Box");
      const b = yield* servePeer(box, McpHttpServer.toolkitRegistration(toolkit, handlers));
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      const links = Context.get(context, PeerLinks.PeerLinks);
      const client = Context.get(context, PeerMcpClient.PeerMcpClient);
      const linked = yield* linkTo(links, b);
      const day = 24 * 60 * 60 * 1000;
      const call = client.call({
        environmentId: box.environmentId,
        tool: "probe",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: Result,
      });
      const storedExpiry = links
        .get(box.environmentId)
        .pipe(
          Effect.map((link) => (Option.isSome(link) ? link.value.expiresAt.epochMilliseconds : 0)),
        );
      const expiryThere = b.linkedSessions.pipe(
        Effect.map((sessions) => sessions[0]?.expiresAt.epochMilliseconds),
      );
      const linkedAt = linked.linkedAt.epochMilliseconds;
      expect(yield* storedExpiry).toBe(linkedAt + 30 * day);

      yield* TestClock.adjust("20 days");
      yield* call;
      expect(yield* expiryThere).toBe(linkedAt + 50 * day);
      expect(yield* storedExpiry).toBe(linkedAt + 50 * day);

      yield* TestClock.adjust("20 days");
      expect(yield* call).toEqual({ modes: "" });
      expect(yield* storedExpiry).toBe(linkedAt + 70 * day);

      // Idle for the whole window, the link expires on both sides.
      yield* TestClock.adjust("30 days");
      expect((yield* call.pipe(Effect.flip)).code).toBe("capability_denied");
      expect((yield* links.list)[0]?.status).toBe("expired");
      expect(yield* b.linkedSessions).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 200, 404, 200, 202, 200, 200, 200, 200];
    const outcomes: Array<string | null> = [];
    const expiries: Array<string> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            index === 2 || index === 6
              ? JSON.stringify({ result: { tools: [] } })
              : index === 9
                ? "{}"
                : index >= 7
                  ? JSON.stringify({
                      result: {
                        content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }],
                      },
                    })
                  : "",
            {
              status,
              headers:
                index === 0
                  ? {
                      "mcp-session-id": "old",
                      [McpInvocationContext.LINK_EXPIRES_AT_HEADER]: "1970-01-02T00:00:00.000Z",
                    }
                  : index === 4
                    ? { "mcp-session-id": "renewed" }
                    : {},
            },
          ),
        );
      }),
    );
    const box = descriptorOf("environment-box", "Box");
    const context = yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.mock(PeerLinks.PeerLinks)({
              resolve: () =>
                Effect.succeed({
                  link: {
                    environmentId: box.environmentId,
                    label: box.label,
                    urls: ["https://peer.example"],
                    access: "auto",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(1),
                    lastReachedAt: null,
                    lastError: null,
                  },
                  url: "https://peer.example",
                  token: "fixture",
                }),
              recordOutcome: (_, outcome) => Effect.sync(() => outcomes.push(outcome.error)),
              recordExpiry: (_, expiresAt) =>
                Effect.sync(() => expiries.push(DateTime.formatIso(expiresAt))),
            }),
          ),
        ),
      ),
    );
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    for (let call = 0; call < 2; call++) {
      expect(
        yield* client.call({
          environmentId: box.environmentId,
          tool: "probe",
          arguments: {},
          limits: { runtimeMode: "approval-required", interactionMode: "plan" },
          success: Result,
        }),
      ).toEqual({ modes: "approval-required/plan" });
    }
    // An answer with neither a result nor an error is the link's problem, not the call's.
    const empty = yield* client
      .call({
        environmentId: box.environmentId,
        tool: "probe",
        arguments: {},
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        success: Result,
      })
      .pipe(Effect.flip);
    expect(outcomes).toEqual([null, null, empty.message]);
    // Only the handshake answered with an expiry, and it is kept.
    expect(expiries).toEqual(["1970-01-02T00:00:00.000Z"]);
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
      "renewed",
      "renewed",
    ]);
  }),
);

it.effect("bounds the session handshake, not a tool call that waits longer", () =>
  Effect.gen(function* () {
    const arrived = yield* Queue.unbounded<number>();
    const answer = yield* Deferred.make<void>();
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const index = requests++;
        yield* Queue.offer(arrived, index);
        // The first initialize, then the next initialized notification, never answer;
        // the third session lists its tools, then its tool call answers late.
        if (index === 0 || index === 2) return yield* Effect.never;
        if (index === 6) yield* Deferred.await(answer);
        return HttpClientResponse.fromWeb(
          request,
          new Response(index === 5 ? probeTools : index === 6 ? probeResult : "", {
            status: index === 4 ? 202 : 200,
            headers: { "mcp-session-id": "session" },
          }),
        );
      }),
    );
    const probe = yield* probeThrough(http);

    for (const requestsBeforeStall of [1, 2]) {
      const stalled = yield* probe.pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.takeN(arrived, requestsBeforeStall);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(stalled)).toMatchObject({
        code: "orchestration_error",
        message: "The linked environment stopped answering.",
      });
    }

    const waiting = yield* Effect.forkScoped(probe);
    yield* Queue.takeN(arrived, 4);
    yield* TestClock.adjust(Duration.minutes(1));
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(waiting)).toEqual({ modes: "approval-required/plan" });
  }),
);

const fakeBox = EnvironmentId.make("environment-box");

/** What a tool call forwards, as the fake peer receives it. */
const JsonRpcRequest = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Number),
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

/** A request the fake peer received. */
interface FakeRequest extends Schema.Schema.Type<typeof JsonRpcRequest> {}

/**
 * The peer's `/mcp` as an older T3 Code would answer it: it serves one tool,
 * `t3_thing`, whose schema declares a single `declared` argument. Every
 * request is recorded. Once `restarted` is set, it forgets the old session
 * and serves an older `t3_thing` that declares only `other`.
 */
const serveFakePeer = (
  requests: Ref.Ref<ReadonlyArray<FakeRequest>>,
  restarted?: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(
      HttpRouter.add("POST", "/mcp", () =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(JsonRpcRequest);
          yield* Ref.update(requests, (seen) => [...seen, body]);
          const isRestarted = restarted === undefined ? false : yield* Ref.get(restarted);
          const sessionId = isRestarted ? "session-new" : "session-fake";
          if (body.method === "initialize") {
            return HttpServerResponse.empty({
              status: 200,
              headers: { "mcp-session-id": sessionId },
            });
          }
          if (body.method === "notifications/initialized") return HttpServerResponse.empty();
          if (body.method === "tools/list") {
            return yield* HttpServerResponse.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "t3_thing",
                    inputSchema: {
                      type: "object",
                      properties: isRestarted
                        ? { other: { type: "number" } }
                        : { declared: { type: "number" } },
                    },
                  },
                ],
              },
            });
          }
          if (body.method === "tools/call") {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.headers["mcp-session-id"] !== sessionId) {
              return HttpServerResponse.empty({ status: 404 });
            }
            return yield* HttpServerResponse.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
            });
          }
          return yield* HttpServerResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Tool not found" },
          });
        }),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.fresh, Layer.build);
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return `http://127.0.0.1:${address.port}`;
  });

const fakeLink = (url: string): PeerLink => ({
  environmentId: fakeBox,
  label: "Box",
  urls: [url],
  access: "auto",
  linkedAt: DateTime.fromEpochSeconds(0),
  expiresAt: DateTime.fromEpochSeconds(3_153_600_000),
  lastReachedAt: null,
  lastError: null,
});

/** A client over the fake peer, with `t3_thing` call for its declared shape. */
const clientAt = (url: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () => Effect.succeed({ link: fakeLink(url), url, token: "link-token" }),
            recordOutcome: () => Effect.void,
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    );
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    return (args: Record<string, unknown>) =>
      client.call({
        environmentId: fakeBox,
        tool: "t3_thing",
        arguments: args,
        limits: { runtimeMode: "auto", interactionMode: "default" },
        success: Schema.Struct({ ok: Schema.Boolean }),
      });
  });

const methodsOf = (requests: ReadonlyArray<FakeRequest>, method: string) =>
  requests.filter((request) => request.method === method);

it.effect("refuses an argument the linked environment's tool does not declare", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const url = yield* serveFakePeer(requests);
      const callThing = yield* clientAt(url);

      const failure = yield* callThing({ declared: 1, mystery: true }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toBe(
        "The linked environment does not support `mystery` on `t3_thing`. Update it, or omit that field.",
      );

      // Discovery went out, but the call itself never did.
      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/call")).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("forwards arguments the linked environment's tool declares, once per session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const url = yield* serveFakePeer(requests);
      const callThing = yield* clientAt(url);

      expect(yield* callThing({ declared: 1 })).toEqual({ ok: true });
      expect(yield* callThing({ declared: 2 })).toEqual({ ok: true });

      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/list")).toHaveLength(1);
      expect(methodsOf(seen, "tools/call")).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("checks again after the linked environment restarts on an older version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const restarted = yield* Ref.make(false);
      const url = yield* serveFakePeer(requests, restarted);
      const callThing = yield* clientAt(url);

      expect(yield* callThing({ declared: 1 })).toEqual({ ok: true });
      yield* Ref.set(restarted, true);
      const failure = yield* callThing({ declared: 2 }).pipe(Effect.flip);
      expect(failure.message).toBe(
        "The linked environment does not support `declared` on `t3_thing`. Update it, or omit that field.",
      );

      // The second call reached only the forgotten session, which applied nothing.
      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/list")).toHaveLength(2);
      expect(methodsOf(seen, "tools/call")).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
