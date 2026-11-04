import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Tool, Toolkit } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const environmentId = EnvironmentId.make("environment:peer");
const peerLayer = (url: string) =>
  PeerMcpClient.layer.pipe(
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        resolve: () =>
          Effect.succeed({
            url,
            token: "test-peer-token",
            link: {
              environmentId,
              label: "Peer",
              urls: [url],
              access: "auto",
              linkedAt: DateTime.makeUnsafe(0),
              expiresAt: DateTime.makeUnsafe(1_000_000),
              lastReachedAt: null,
              lastError: null,
            },
          }),
        recordOutcome: () => Effect.void,
      }),
    ),
  );

const callPeer = Effect.gen(function* () {
  const client = yield* PeerMcpClient.PeerMcpClient;
  return yield* client.call({
    environmentId,
    tool: "t3_thread_launch",
    arguments: { title: "Run once", clientRequestId: "same-launch" },
    limits: { runtimeMode: "auto", interactionMode: "default" },
    success: Schema.Struct({ answer: Schema.String }),
  });
});

const toolResponse = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: JSON.stringify({ answer: "done" }) }] },
});

const responseClient = (
  body: string | ReadableStream<Uint8Array>,
  contentType = "text/event-stream",
) => {
  let requests = 0;
  return HttpClient.make((request) =>
    Effect.sync(() => {
      requests++;
      return HttpClientResponse.fromWeb(
        request,
        requests === 1
          ? Response.json(
              { jsonrpc: "2.0", id: 0, result: {} },
              { headers: { "mcp-session-id": "session" } },
            )
          : requests === 2
            ? new Response(null, { status: 202 })
            : new Response(body, { headers: { "content-type": contentType } }),
      );
    }),
  );
};

it.effect("reads the matching MCP response among SSE notifications and other response IDs", () => {
  const body = [
    ": keepalive\r\nretry: 1000\r\n\r\n",
    'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
    `data: ${JSON.stringify(toolResponse(999))}\r\n\r\n`,
    `event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":${JSON.stringify(toolResponse(1).result)}}\r\n\r\n`,
  ].join("");
  return callPeer.pipe(
    Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ answer: "done" }))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, responseClient(body))),
      ),
    ),
  );
});

it.effect("returns the MCP response before SSE closes and releases the body reader", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(toolResponse(1))}\n\n`),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = yield* callPeer.pipe(
      Effect.provide(
        peerLayer("http://peer.test").pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, responseClient(body))),
        ),
      ),
    );
    expect(result).toEqual({ answer: "done" });
    expect(cancelled).toBe(true);
  }),
);

it.effect("refuses a JSON response for another MCP request", () =>
  callPeer.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.code).toBe("orchestration_error"))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            responseClient(JSON.stringify(toolResponse(999)), "application/json"),
          ),
        ),
      ),
    ),
  ),
);

it.effect("decodes structured MCP results without requiring JSON text content", () =>
  callPeer.pipe(
    Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ answer: "done" }))),
    Effect.provide(
      peerLayer("http://peer.test").pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            responseClient(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { content: [], structuredContent: { answer: "done" } },
              }),
              "application/json",
            ),
          ),
        ),
      ),
    ),
  ),
);

const serveRaw = <E, R>(
  handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      Effect.gen(function* () {
        yield* HttpServer.serve(Effect.flatMap(HttpServerRequest.HttpServerRequest, handle)).pipe(
          Layer.build,
        );
        const address = (yield* HttpServer.HttpServer).address;
        if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
        return `http://127.0.0.1:${address.port}`;
      }).pipe(Effect.provideContext(server)),
    ),
  );

it.effect("does not follow an MCP redirect with the tool's arguments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<string>>([]);
      const elsewhere = yield* serveRaw((request) =>
        request.text.pipe(
          Effect.flatMap((body) => Ref.update(received, (seen) => [...seen, body])),
          Effect.as(HttpServerResponse.jsonUnsafe(toolResponse(1))),
        ),
      );
      const front = yield* serveRaw((request) =>
        request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ method: Schema.String }))),
          Effect.map(({ method }) =>
            method === "initialize"
              ? HttpServerResponse.jsonUnsafe(
                  { jsonrpc: "2.0", id: 0, result: {} },
                  { headers: { "mcp-session-id": "session" } },
                )
              : method === "notifications/initialized"
                ? HttpServerResponse.empty({ status: 202 })
                : HttpServerResponse.empty({
                    status: 307,
                    headers: { location: `${elsewhere}/mcp` },
                  }),
          ),
        ),
      );
      const result = yield* callPeer.pipe(
        Effect.result,
        Effect.provide(peerLayer(front).pipe(Layer.provide(FetchHttpClient.layer))),
      );
      expect(yield* Ref.get(received)).toEqual([]);
      expect(result._tag).toBe("Failure");
    }),
  ),
);

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

const refusal = new OrchestratorMcpFailure({
  code: "thread_not_found",
  message: "Thread thread-gone was not found.",
});

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

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 404, 200, 202, 200, 200, 200];
    const outcomes: Array<string | null> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            index === 7
              ? "{}"
              : index >= 5
                ? JSON.stringify({
                    jsonrpc: "2.0",
                    id: index === 5 ? 1 : 2,
                    result: {
                      content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }],
                    },
                  })
                : "",
            {
              status,
              headers:
                index === 0
                  ? { "mcp-session-id": "old" }
                  : index === 3
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
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
      "renewed",
    ]);
  }).pipe(Effect.scoped),
);
