/**
 * The host's end of one mounted view's MessagePort, shared by every client.
 *
 * A host creates one bridge per mount, after its window-message handshake has
 * handed the view the other port end, and passes every port message to
 * `receive`. The bridge enforces the contract bounds on what the view sends
 * (JSON text only, byte size, nesting depth, a message rate budget, in-flight
 * calls) and turns `call` messages into calls on the host's binding. Every
 * message it sends keeps the same byte and depth bounds: an answer that would
 * not, or that is not JSON, is replaced by a small `error`. Every call it admits or refuses gets
 * exactly one answer, so the view's promise always settles. The
 * binding (environment, installation, generation, view) lives in the host's
 * `call` closure; nothing in a message can name another target.
 *
 * Closing the bridge (its scope, `close`, too many violations, or a missed
 * ping) interrupts every call in flight and drops any answer that arrives
 * later. A host closes it when the view's `(installationId, generation,
 * viewId)` leaves the views snapshot, when the session or environment
 * changes, and when it unmounts the frame.
 */
import {
  PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS,
  PLUGIN_VIEW_MAX_VIOLATIONS,
  PLUGIN_VIEW_MESSAGE_BURST,
  PLUGIN_VIEW_MESSAGE_MAX_BYTES,
  PLUGIN_VIEW_MESSAGE_MAX_DEPTH,
  PLUGIN_VIEW_MESSAGES_PER_SECOND,
  PLUGIN_VIEW_PING_INTERVAL_MS,
  PluginViewHostMessage,
  PluginViewMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The host's end of the view's MessagePort. */
interface PluginViewPort {
  readonly post: (text: string) => void;
  readonly close: () => void;
}

/** Why a mount ended: `closed` by the host, or the bridge's own `violations` / `unresponsive`. */
export type PluginViewCloseReason = "closed" | "violations" | "unresponsive";

export interface PluginViewBridge {
  /** Every message event from the port: its data and how many ports it transferred. */
  readonly receive: (data: unknown, transferredPorts: number) => void;
  readonly close: () => void;
}

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeMessage = Schema.decodeUnknownExit(PluginViewMessage);
const encodeHostMessage = Schema.encodeExit(Schema.fromJsonString(PluginViewHostMessage));
const encoder = new TextEncoder();

/** Encoded UTF-8 bytes, without allocating for text that is too long either way. */
const fitsMessageBytes = (text: string) =>
  // UTF-8 never takes fewer bytes than UTF-16 code units.
  text.length <= PLUGIN_VIEW_MESSAGE_MAX_BYTES &&
  encoder.encode(text).length <= PLUGIN_VIEW_MESSAGE_MAX_BYTES;

const withinDepth = (value: unknown) => {
  const stack: Array<readonly [unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth > PLUGIN_VIEW_MESSAGE_MAX_DEPTH) return false;
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return true;
};

/** What a view's call failed with: a `PluginViewError` reason, or `unavailable`. */
const failureOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "PluginViewError" &&
  "reason" in error &&
  typeof error.reason === "string" &&
  "message" in error &&
  typeof error.message === "string"
    ? { code: error.reason, message: error.message }
    : { code: "unavailable", message: "The view's environment could not take the call." };

export const makePluginViewBridge = Effect.fnUntraced(function* <E, R>(options: {
  /** Sent to the view as `init`, the first message on the port. */
  readonly view: { readonly pluginId: string; readonly viewId: string; readonly title: string };
  readonly port: PluginViewPort;
  /** Calls the bound view's plugin handler; the host fixes the target. */
  readonly call: (handler: string, input: Schema.Json) => Effect.Effect<Schema.Json, E, R>;
  /** Told once, when the mount ends for any reason. The host then removes the frame. */
  readonly onClose: (reason: PluginViewCloseReason) => void;
}) {
  const clock = yield* Clock.Clock;
  const calls = yield* FiberMap.make<number>();
  const run = yield* FiberMap.runtime(calls)<R>();
  const runVoid = Effect.runForkWith(yield* Effect.context<never>());

  // Ids of calls in flight; the fiber of each is in `calls` under the same id.
  const inFlight = new Set<number>();
  let closed = false;
  let violations = 0;
  let tokens = PLUGIN_VIEW_MESSAGE_BURST;
  let refilledAt = clock.currentTimeMillisUnsafe();
  let awaitedPing: number | null = null;
  let pings = 0;

  const post = (message: PluginViewHostMessage) => {
    if (closed) return;
    // Depth first: it is cheap and bounds the recursion of encoding.
    const text = withinDepth(message) ? encodeHostMessage(message) : undefined;
    if (text !== undefined && Exit.isSuccess(text) && fitsMessageBytes(text.value))
      return options.port.post(text.value);
    // Only answers carry plugin data. `init`, `ping` and `violation` are bounded host fields.
    // The replacement errors are small and encodable, so this recursion ends.
    if (message._tag === "result")
      post(
        text === undefined
          ? {
              _tag: "error",
              id: message.id,
              code: "too-deep",
              message: "The answer is nested too deeply.",
            }
          : Exit.isFailure(text)
            ? { _tag: "error", id: message.id, code: "invalid", message: "The answer is not JSON." }
            : {
                _tag: "error",
                id: message.id,
                code: "too-large",
                message: "The answer is too large.",
              },
      );
    else if (message._tag === "error")
      post({
        _tag: "error",
        id: message.id,
        code: "too-large",
        message: "The error is too large.",
      });
  };

  const close = (reason: PluginViewCloseReason) => {
    if (closed) return;
    closed = true;
    inFlight.clear();
    options.port.close();
    runVoid(FiberMap.clear(calls));
    options.onClose(reason);
  };

  const violation = (reason: string) => {
    violations += 1;
    post({ _tag: "violation", reason });
    if (violations >= PLUGIN_VIEW_MAX_VIOLATIONS) close("violations");
  };

  const admit = () => {
    const now = clock.currentTimeMillisUnsafe();
    tokens = Math.min(
      PLUGIN_VIEW_MESSAGE_BURST,
      // A wall clock that steps back refills nothing rather than draining the bucket.
      tokens + (Math.max(0, now - refilledAt) * PLUGIN_VIEW_MESSAGES_PER_SECOND) / 1000,
    );
    refilledAt = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  const startCall = (id: number, handler: string, input: Schema.Json) => {
    if (inFlight.has(id)) return violation("duplicate-call-id");
    if (inFlight.size >= PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS)
      return post({ _tag: "error", id, code: "busy", message: "Too many calls are in flight." });
    inFlight.add(id);
    run(
      id,
      options.call(handler, input).pipe(
        Effect.exit,
        // Cancelling or closing interrupts this fiber before here, so its answer goes nowhere.
        Effect.map((exit) => {
          inFlight.delete(id);
          if (Exit.isSuccess(exit)) return post({ _tag: "result", id, value: exit.value });
          post({
            _tag: "error",
            id,
            ...failureOf(Option.getOrUndefined(Cause.findErrorOption(exit.cause))),
          });
        }),
      ),
    );
  };

  const receive = (data: unknown, transferredPorts: number) => {
    if (closed) return;
    // An over-rate message is still read, so a refused call can be answered.
    // Each one is a violation, which bounds that work per mount.
    const admitted = admit();
    if (transferredPorts > 0) return violation("transfer");
    if (typeof data !== "string") return violation("not-text");
    if (!fitsMessageBytes(data)) return violation("too-large");
    const json = decodeJson(data);
    if (Exit.isFailure(json)) return violation("not-json");
    if (!withinDepth(json.value)) return violation("too-deep");
    const message = decodeMessage(json.value);
    if (Exit.isFailure(message)) return violation("invalid");
    if (!admitted) {
      const refused = message.value;
      if (refused._tag === "call" && !inFlight.has(refused.id))
        post({
          _tag: "error",
          id: refused.id,
          code: "rate",
          message: "Too many messages; try again shortly.",
        });
      return violation("rate");
    }
    switch (message.value._tag) {
      case "call":
        return startCall(message.value.id, message.value.handler, message.value.input);
      case "cancel": {
        const { id } = message.value;
        if (!inFlight.delete(id)) return;
        runVoid(FiberMap.remove(calls, id));
        return post({ _tag: "error", id, code: "cancelled", message: "The call was cancelled." });
      }
      case "pong":
        if (message.value.n === awaitedPing) awaitedPing = null;
        return;
    }
  };

  post({ _tag: "init", ...options.view });
  yield* Effect.addFinalizer(() => Effect.sync(() => close("closed")));
  // Liveness: a view that replaced its document, or is stuck, stops answering.
  const heartbeat: Effect.Effect<void> = Effect.sleep(PLUGIN_VIEW_PING_INTERVAL_MS).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        if (closed) return Effect.void;
        if (awaitedPing !== null) return Effect.sync(() => close("unresponsive"));
        pings += 1;
        awaitedPing = pings;
        post({ _tag: "ping", n: pings });
        return heartbeat;
      }),
    ),
  );
  yield* Effect.forkScoped(heartbeat);

  return { receive, close: () => close("closed") } satisfies PluginViewBridge;
});
