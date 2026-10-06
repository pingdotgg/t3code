import { withLocalTracing, withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpTraceContext } from "effect/http";

/**
 * Exports every span of a handler that is itself T3 Connect work (the token
 * exchange, the environment descriptor, credential minting), so the whole
 * connection path can be measured.
 */
export const traceRelayRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(withRelayClientTracing);

/**
 * Traces a request that arrived over T3 Connect. The request, its
 * authentication and the handler's own span are exported, so their latency
 * and errors are visible; what the handler then does on the user's machine
 * (database reads, project indexing, processes) is not, unless the handler is
 * connection work and opts back in with {@link traceRelayRequest}.
 */
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

/**
 * Keeps the work inside a relay-traced handler on the local tracer. The
 * handler's span still records the timing and outcome.
 */
export const traceLocalHandlerWork = withLocalTracing;
