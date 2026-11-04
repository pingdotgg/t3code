import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import type * as Cause from "effect/Cause";
import {
  McpGatewayRelayCalls,
  McpGatewayUnavailableError,
  toMcpGatewayRelayJson,
  type McpGatewayRelayArgs,
  type McpGatewayRelayEvent,
  type McpGatewayRelayGrants,
  type McpGatewayRelayMethod,
  type McpGatewayRelayResponse,
  type McpGatewayRelayResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const unavailable = (message: string) => new McpGatewayUnavailableError({ message });

interface RelayCodec {
  readonly encodeArgs: (args: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decodeResult: (answer: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
}
const relayCodec = (spec: {
  readonly args: Schema.Codec<unknown, unknown>;
  readonly result: Schema.Codec<unknown, unknown>;
}): RelayCodec => ({
  encodeArgs: Schema.encodeUnknownEffect(spec.args),
  decodeResult: Schema.decodeUnknownEffect(spec.result),
});
/** Each relay call's argument encoder and answer decoder, compiled once. */
const relayCodecs: { readonly [M in McpGatewayRelayMethod]: RelayCodec } = {
  getThread: relayCodec(McpGatewayRelayCalls.getThread),
  listThreads: relayCodec(McpGatewayRelayCalls.listThreads),
  settleThread: relayCodec(McpGatewayRelayCalls.settleThread),
  unsettleThread: relayCodec(McpGatewayRelayCalls.unsettleThread),
  threadTask: relayCodec(McpGatewayRelayCalls.threadTask),
};

interface Host {
  readonly owner: string;
  readonly connectionId: string;
  readonly grants: McpGatewayRelayGrants;
  readonly requests: Queue.Queue<McpGatewayRelayEvent, Cause.Done>;
  /** Timed out since it last answered; other apps that reach the environment go first. */
  stalled: boolean;
}
interface Pending {
  readonly host: Host;
  readonly deferred: Deferred.Deferred<unknown, McpGatewayUnavailableError>;
}

/**
 * Connected apps that run T3 Agents runtime port calls for this server's agents on the other
 * environments they reach. Each app advertises the grants its user set.
 */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hosts = new Map<string, Host>();
  const pending = new Map<string, Pending>();
  /** Fires when an app connects, so queued cross-environment work can retry at once. */
  const connected = yield* PubSub.unbounded<void>();
  const connect = (owner: string, grants: McpGatewayRelayGrants) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const requests = yield* Queue.unbounded<McpGatewayRelayEvent, Cause.Done>();
        const host: Host = { owner, connectionId, grants, requests, stalled: false };
        yield* Effect.acquireRelease(
          Effect.sync(() => hosts.set(connectionId, host)).pipe(
            Effect.andThen(PubSub.publish(connected, undefined)),
          ),
          () =>
            Effect.gen(function* () {
              hosts.delete(connectionId);
              for (const [id, call] of pending) {
                if (call.host !== host) continue;
                pending.delete(id);
                yield* Deferred.fail(
                  call.deferred,
                  unavailable("The T3 app relaying this call disconnected."),
                );
              }
              yield* Queue.end(requests);
            }),
        );
        return Stream.fromQueue(requests);
      }),
    );
  /** Union of every connected app's grants, per environment. */
  const grants = (): Record<string, ReadonlyArray<string>> => {
    const merged: Record<string, Set<string>> = {};
    for (const host of hosts.values()) {
      for (const [environmentId, scopes] of Object.entries(host.grants)) {
        const into = (merged[environmentId] ??= new Set());
        for (const scope of scopes) into.add(scope);
      }
    }
    return Object.fromEntries(Object.entries(merged).map(([id, scopes]) => [id, [...scopes]]));
  };
  /** Sends one call to one app and waits for its answer. */
  const ask = Effect.fn("McpGatewayBroker.ask")(function* (
    host: Host,
    method: keyof GatewayRuntimePort,
    relayedArgs: ReadonlyArray<unknown>,
    timeout: Duration.Input,
  ) {
    const invocationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const deferred = yield* Deferred.make<unknown, McpGatewayUnavailableError>();
    pending.set(invocationId, { host, deferred });
    return yield* Effect.gen(function* () {
      yield* Queue.offer(host.requests, {
        type: "invoke",
        connectionId: host.connectionId,
        invocationId,
        method,
        args: relayedArgs,
      });
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.sync(() => {
            host.stalled = true;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                unavailable("The T3 app relaying this call timed out; it was not retried."),
              ),
            ),
          ),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(invocationId))),
    );
  });
  /**
   * Each app sees the environments its own device reaches, so the listing merges every app's
   * answer; following one app would swap the agent's world whenever another app connects.
   */
  const listEnvironments = Effect.gen(function* () {
    const answers = yield* Effect.forEach(
      [...hosts.values()].toReversed(),
      (host) => ask(host, "listEnvironments", [], "10 seconds").pipe(Effect.option),
      { concurrency: "unbounded" },
    );
    const merged = new Map<string, Record<string, unknown>>();
    for (const answer of answers) {
      if (Option.isNone(answer) || !Array.isArray(answer.value)) continue;
      for (const candidate of answer.value as ReadonlyArray<unknown>) {
        if (typeof candidate !== "object" || candidate === null) continue;
        const environment = candidate as Record<string, unknown>;
        if (typeof environment.environmentId !== "string") continue;
        const known = merged.get(environment.environmentId);
        // The newest app's view wins unless only an older app is connected to the environment.
        if (
          known === undefined ||
          (known.connectionState !== "connected" && environment.connectionState === "connected")
        ) {
          merged.set(environment.environmentId, environment);
        }
      }
    }
    return [...merged.values()];
  });
  const invoke = Effect.fn("McpGatewayBroker.invoke")(function* (
    method: keyof GatewayRuntimePort,
    args: ReadonlyArray<unknown>,
    environmentIds: ReadonlyArray<string>,
  ): Effect.fn.Return<unknown, McpGatewayUnavailableError> {
    if (method === "listEnvironments") return yield* listEnvironments;
    // The newest app that reaches every environment in the call runs it, preferring one that answers.
    const reaching = [...hosts.values()]
      .toReversed()
      .filter((candidate) => environmentIds.every((id) => candidate.grants[id] !== undefined));
    const host = reaching.find((candidate) => !candidate.stalled) ?? reaching[0];
    if (!host) {
      return yield* unavailable(
        hosts.size === 0
          ? "No T3 app with T3 Agents enabled is connected to this environment."
          : `No connected T3 app grants T3 Agents access to ${environmentIds.join(", ")}.`,
      );
    }
    // Omitted trailing arguments stay omitted rather than arriving as null.
    const sent = args.slice(0, args.findLastIndex((arg) => arg !== undefined) + 1);
    const relayedArgs = yield* Effect.try({
      try: () => toMcpGatewayRelayJson(sent) as ReadonlyArray<unknown>,
      catch: () => unavailable(`The arguments of ${method} cannot be relayed to a T3 app.`),
    });
    return yield* ask(host, method, relayedArgs, "60 seconds");
  });
  /**
   * One of this server's own calls on another environment, with its arguments and answer checked
   * against the contract, so an app that answers in another shape fails here, not in the caller.
   */
  const call = <M extends McpGatewayRelayMethod>(
    method: M,
    args: McpGatewayRelayArgs<M>,
  ): Effect.Effect<McpGatewayRelayResult<M>, McpGatewayUnavailableError> => {
    const codec = relayCodecs[method];
    const environmentId = args[0];
    return codec.encodeArgs(args).pipe(
      Effect.mapError(() => unavailable(`The arguments of ${method} do not match its contract.`)),
      Effect.flatMap((encoded) =>
        invoke(method, encoded as ReadonlyArray<unknown>, [environmentId]),
      ),
      Effect.flatMap((answer) =>
        codec
          .decodeResult(answer)
          .pipe(
            Effect.mapError(() =>
              unavailable(
                `Environment ${environmentId} answered ${method} in a shape this server cannot read.`,
              ),
            ),
          ),
      ),
      Effect.map((result) => result as McpGatewayRelayResult<M>),
      Effect.withSpan("McpGatewayBroker.call", { attributes: { method } }),
    );
  };
  const respond = Effect.fn("McpGatewayBroker.respond")(function* (
    owner: string,
    input: McpGatewayRelayResponse,
  ) {
    const call = pending.get(input.invocationId);
    if (!call || call.host.owner !== owner || call.host.connectionId !== input.connectionId) {
      return yield* unavailable("Relay response does not belong to this connection.");
    }
    pending.delete(input.invocationId);
    call.host.stalled = false;
    if (input.error !== undefined) {
      yield* Deferred.fail(call.deferred, unavailable(input.error));
      return;
    }
    yield* Deferred.succeed(call.deferred, input.result);
  });
  return {
    connect,
    grants,
    call,
    /**
     * Runs a gateway tool's runtime port call on another environment as it is. Only the tool
     * catalog uses this: its calls are the port's own surface, typed by the port.
     */
    forward: invoke,
    respond,
    available: () => hosts.size > 0,
    hostConnected: Stream.fromPubSub(connected),
  };
});

export class McpGatewayBroker extends Context.Service<
  McpGatewayBroker,
  Effect.Success<typeof make>
>()("t3/mcp/McpGatewayBroker") {}

export const layer = Layer.effect(McpGatewayBroker, make);
