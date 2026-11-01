import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

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

const probeResult = JSON.stringify({
  result: { content: [{ type: "text", text: '{"modes":"approval-required/plan"}' }] },
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

it.effect("renews a missing peer session once and reuses its replacement", () =>
  Effect.gen(function* () {
    const sessionHeaders: Array<string | undefined> = [];
    const statuses = [200, 202, 404, 200, 202, 200, 200];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const index = sessionHeaders.length;
        sessionHeaders.push(request.headers["mcp-session-id"]);
        const status = statuses[index];
        if (status === undefined) throw new Error("Unexpected retry");
        return HttpClientResponse.fromWeb(
          request,
          new Response(index >= 5 ? probeResult : "", {
            status,
            headers:
              index === 0
                ? { "mcp-session-id": "old" }
                : index === 3
                  ? { "mcp-session-id": "renewed" }
                  : {},
          }),
        );
      }),
    );
    const probe = yield* probeThrough(http);
    for (let call = 0; call < 2; call++) {
      expect(yield* probe).toEqual({ modes: "approval-required/plan" });
    }
    expect(sessionHeaders).toEqual([
      undefined,
      "old",
      "old",
      undefined,
      "renewed",
      "renewed",
      "renewed",
    ]);
  }).pipe(Effect.scoped),
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
        // The first initialize never answers; the next session's tool call answers late.
        if (index === 0) return yield* Effect.never;
        if (index === 3) yield* Deferred.await(answer);
        return HttpClientResponse.fromWeb(
          request,
          new Response(index === 3 ? probeResult : "", {
            status: index === 2 ? 202 : 200,
            headers: index === 1 ? { "mcp-session-id": "session" } : {},
          }),
        );
      }),
    );
    const probe = yield* probeThrough(http);

    const stalled = yield* probe.pipe(Effect.flip, Effect.forkScoped);
    yield* Queue.take(arrived);
    yield* TestClock.adjust(Duration.seconds(10));
    expect(yield* Fiber.join(stalled)).toMatchObject({
      code: "orchestration_error",
      message: "The linked environment stopped answering.",
    });

    const waiting = yield* Effect.forkScoped(probe);
    yield* Queue.takeN(arrived, 3);
    yield* TestClock.adjust(Duration.minutes(1));
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(waiting)).toEqual({ modes: "approval-required/plan" });
  }).pipe(Effect.scoped),
);
