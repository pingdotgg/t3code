import {
  RelayClientTracer,
  withLocalTracing,
  withRelayClientTracing,
} from "@t3tools/shared/relayTracing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
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
 * Traces a request that arrived over T3 Connect, continuing the client's
 * trace. The request's span and its authentication timing are exported, so
 * their latency and errors are visible; what the handler then does on the
 * user's machine (database reads, project indexing, processes) is not, unless
 * the handler is connection work and opts back in with {@link traceRelayRequest}.
 *
 * Call it only after the session is verified as T3 Connect: an unverified
 * request must not add spans to a trace it names. Authentication therefore
 * runs on the local tracer, and its timing is recorded here afterwards.
 */
export const traceAuthenticatedRelayRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  authentication: { readonly startTime: bigint; readonly endTime: bigint },
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.all([RelayClientTracer, HttpServerRequest.HttpServerRequest]).pipe(
    Effect.flatMap(([tracer, request]): Effect.Effect<A, E, R> => {
      if (Option.isNone(tracer)) return effect;
      const parent = HttpTraceContext.fromHeaders(request.headers);
      const sampled = Option.isNone(parent) || parent.value.sampled;
      const startSpan = (
        name: string,
        kind: Tracer.SpanKind,
        parent: Option.Option<Tracer.AnySpan>,
      ) =>
        tracer.value.span({
          name,
          parent,
          annotations: Context.empty(),
          links: [],
          startTime: authentication.startTime,
          kind,
          root: Option.isNone(parent),
          sampled,
        });
      const span = startSpan("environment.relay.request", "server", parent);
      startSpan("EnvironmentAuth.authenticateHttpRequest", "internal", Option.some(span)).end(
        authentication.endTime,
        Exit.void,
      );
      return effect.pipe(
        Effect.withParentSpan(span),
        Effect.onExit((exit) =>
          Clock.currentTimeNanos.pipe(Effect.map((endTime) => span.end(endTime, exit))),
        ),
        withRelayClientTracing,
      );
    }),
  );

/**
 * Keeps the work inside a relay-traced handler on the local tracer. The
 * handler's span still records the timing and outcome.
 */
export const traceLocalHandlerWork = withLocalTracing;
