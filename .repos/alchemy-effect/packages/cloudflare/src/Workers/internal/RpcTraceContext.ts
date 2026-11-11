import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

/**
 * Key of the trailing argument a Durable Object RPC stub appends to carry the
 * caller's W3C `traceparent`. Native RPC has no headers, so the trace context
 * rides in the arguments the same way the HTTP path carries it in a header.
 */
const TRACEPARENT_KEY = "~alchemy/traceparent";

interface TraceContextArg {
  readonly [TRACEPARENT_KEY]: string;
}

// Checked on every call's last argument, which is often a large payload: test
// the key before counting keys, since `Object.keys` of a multi-megabyte
// `Uint8Array` allocates a string per byte and exhausts the isolate's memory.
const isTraceContextArg = (value: unknown): value is TraceContextArg =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  typeof (value as Record<string, unknown>)[TRACEPARENT_KEY] === "string" &&
  Object.keys(value).length === 1;

/**
 * Append the caller's active span to an RPC call's arguments. Without an
 * active span, or with propagation disabled, the arguments are unchanged.
 */
export const withRpcTraceContext = Effect.fn(function* (args: ReadonlyArray<unknown>) {
  if (yield* Tracer.DisablePropagation) return args;
  const span = yield* Effect.currentParentSpan.pipe(Effect.option);
  if (Option.isNone(span)) return args;
  const { traceId, spanId, sampled } = span.value;
  const traceparent = `00-${traceId.padStart(32, "0")}-${spanId}-${sampled ? "01" : "00"}`;
  return [...args, { [TRACEPARENT_KEY]: traceparent } satisfies TraceContextArg];
});

/**
 * Split the trace context a caller appended (see {@link withRpcTraceContext})
 * off an RPC call's arguments. Calls from stubs that predate it carry none, so
 * their arguments pass through untouched.
 */
export const takeRpcTraceContext = (
  args: ReadonlyArray<unknown>,
): readonly [args: ReadonlyArray<unknown>, parent: Option.Option<Tracer.ExternalSpan>] => {
  const last = args.at(-1);
  if (!isTraceContextArg(last)) return [args, Option.none()];
  return [
    args.slice(0, -1),
    HttpTraceContext.w3c(Headers.fromRecordUnsafe({ traceparent: last[TRACEPARENT_KEY] })),
  ];
};
