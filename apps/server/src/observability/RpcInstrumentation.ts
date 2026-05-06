import { WS_METHODS } from "@t3tools/contracts";
import { Duration, Effect, Exit, Metric, Stream } from "effect";

import { outcomeFromExit } from "./Attributes.ts";
import { metricAttributes, rpcRequestDuration, rpcRequestsTotal, withMetrics } from "./Metrics.ts";

const RPC_SPAN_PREFIX = "ws.rpc";
const DEFAULT_RPC_SPAN_ATTRIBUTES = {
  "rpc.transport": "websocket",
  "rpc.system": "effect-rpc",
} as const;
const RPC_METHODS_WITH_TRACING_DISABLED: ReadonlySet<string> = new Set([
  WS_METHODS.serverGetTraceDiagnostics,
  WS_METHODS.serverGetProcessDiagnostics,
  WS_METHODS.serverSignalProcess,
]);

function shouldTraceRpc(method: string): boolean {
  return !RPC_METHODS_WITH_TRACING_DISABLED.has(method);
}

const annotateRpcSpan = (
  method: string,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<void, never, never> =>
  Effect.annotateCurrentSpan({
    "rpc.method": method,
    ...traceAttributes,
  });

const recordRpcStreamMetrics = <E>(
  method: string,
  startedAt: number,
  exit: Exit.Exit<unknown, E>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(rpcRequestDuration, metricAttributes({ method })),
      Duration.millis(Math.max(0, Date.now() - startedAt)),
    );
    yield* Metric.update(
      Metric.withAttributes(
        rpcRequestsTotal,
        metricAttributes({
          method,
          outcome: outcomeFromExit(exit),
        }),
      ),
      1,
    );
  });

export const observeRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> => {
  const instrumented = Effect.gen(function* () {
    yield* annotateRpcSpan(method, traceAttributes);

    return yield* effect.pipe(
      withMetrics({
        counter: rpcRequestsTotal,
        timer: rpcRequestDuration,
        attributes: {
          method,
        },
      }),
    );
  });

  return shouldTraceRpc(method)
    ? instrumented.pipe(
        Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
          attributes: {
            ...DEFAULT_RPC_SPAN_ATTRIBUTES,
            ...traceAttributes,
          },
        }),
      )
    : instrumented.pipe(Effect.withTracerEnabled(false));
};

export const observeRpcStream = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* annotateRpcSpan(method, traceAttributes);
      const startedAt = Date.now();
      return stream.pipe(Stream.onExit((exit) => recordRpcStreamMetrics(method, startedAt, exit)));
    }).pipe(
      shouldTraceRpc(method)
        ? Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
            attributes: {
              ...DEFAULT_RPC_SPAN_ATTRIBUTES,
              ...traceAttributes,
            },
          })
        : Effect.withTracerEnabled(false),
    ),
  );

export const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, StreamError | EffectError, StreamContext | EffectContext> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* annotateRpcSpan(method, traceAttributes);
      const startedAt = Date.now();
      const exit = yield* Effect.exit(effect);

      if (Exit.isFailure(exit)) {
        yield* recordRpcStreamMetrics(method, startedAt, exit);
        return yield* Effect.failCause(exit.cause);
      }

      return exit.value.pipe(
        Stream.onExit((streamExit) => recordRpcStreamMetrics(method, startedAt, streamExit)),
      );
    }).pipe(
      shouldTraceRpc(method)
        ? Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
            attributes: {
              ...DEFAULT_RPC_SPAN_ATTRIBUTES,
              ...traceAttributes,
            },
          })
        : Effect.withTracerEnabled(false),
    ),
  );
