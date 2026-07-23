import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpTraceContext } from "effect/unstable/http";

export const traceRelayRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(withRelayClientTracing);

export const traceAuthenticatedRelayRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) =>
      Option.match(HttpTraceContext.fromHeaders(request.headers), {
        onNone: () => effect,
        onSome: (parent) => effect.pipe(Effect.withParentSpan(parent)),
      }),
    ),
    withRelayClientTracing,
  );
