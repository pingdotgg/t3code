import { assert, it } from "@effect/vitest";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import { RequestId } from "effect/rpc/RpcMessage";

import { RpcInstrumentation, rpcInstrumentationLayer } from "./RpcInstrumentation.ts";

it.effect("starts each RPC in its own trace, linked to the connection span", () =>
  Effect.gen(function* () {
    const middleware = yield* RpcInstrumentation;
    let rpcSpan: Tracer.Span | undefined;
    const handler = Effect.gen(function* () {
      rpcSpan = yield* Effect.currentSpan;
    }).pipe(Effect.orDie, Effect.asVoid);

    const connection = yield* Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      yield* middleware(handler as never, {
        client: new Rpc.ServerClient(0),
        requestId: RequestId(1),
        rpc: Rpc.make(WS_METHODS.reviewGetDiffPreview),
        payload: {},
        headers: Headers.empty,
      });
      return span;
    }).pipe(Effect.withSpan("GET /ws"), Effect.orDie);

    assert.isDefined(rpcSpan);
    assert.equal(rpcSpan!.name, "ws.rpc.review.getDiffPreview");
    assert.isTrue(Option.isNone(rpcSpan!.parent));
    assert.notEqual(rpcSpan!.traceId, connection.traceId);
    assert.deepEqual(
      rpcSpan!.links.map((link) => link.span.spanId),
      [connection.spanId],
    );
  }).pipe(Effect.provide(rpcInstrumentationLayer)),
);
