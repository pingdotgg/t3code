import {
  ClientProvidersError,
  type ClientProviderCaller,
  type ClientProviderDescriptor,
  type ClientProviderServerFrame,
  type ClientProvidersConnectInput,
  type ClientProvidersEmitInput,
  type ClientProvidersRespondInput,
  type ClientTargetInfo,
} from "@t3tools/contracts";
import {
  CLIENT_PROVIDER_APIS,
  CLIENT_PROVIDER_SUPPORTED_RANGE,
} from "@t3tools/extension-sdk/clientProviders";
import type { ExtensionViewContext } from "@t3tools/contracts";
import { copyJson, type Json } from "@t3tools/extension-sdk/contracts";
import { Ajv, type ValidateFunction } from "ajv";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiPrincipal } from "@t3tools/extension-runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as DateTime from "effect/DateTime";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const MAX_EVENTS_PER_SUBSCRIPTION = 8;

/**
 * The declared `t3.client/*` schemas are the seam's runtime contract, checked
 * in both directions: dispatch validates the op input before a frame is
 * queued, `respond` validates the client's output against the schema retained
 * with the pending invoke, and subscription emits validate each event value
 * against the stream's `eventSchema`. Every payload additionally passes the
 * shared `copyJson` envelope bound before it can move.
 */
interface CompiledMethod {
  readonly input: ValidateFunction;
  readonly output: ValidateFunction;
}
interface CompiledStream {
  readonly input: ValidateFunction;
  readonly event: ValidateFunction;
}
const seamAjv = new Ajv({ strict: true, allErrors: false, addUsedSchema: false });
const METHOD_SCHEMAS = new Map<string, Map<string, CompiledMethod>>();
const STREAM_SCHEMAS = new Map<string, Map<string, CompiledStream>>();
for (const definition of CLIENT_PROVIDER_APIS.values()) {
  METHOD_SCHEMAS.set(
    definition.id,
    new Map(
      (definition.methods ?? []).map((method) => [
        method.name,
        {
          input: seamAjv.compile(method.inputSchema),
          output: seamAjv.compile(method.outputSchema),
        },
      ]),
    ),
  );
  STREAM_SCHEMAS.set(
    definition.id,
    new Map(
      (definition.streams ?? []).map((stream) => [
        stream.name,
        {
          input: seamAjv.compile(stream.inputSchema),
          event: seamAjv.compile(stream.eventSchema),
        },
      ]),
    ),
  );
}

export interface ClientProvidersSocket {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly announcedOrigin?: ClientTargetInfo["announcedOrigin"];
}

interface Connection {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly announcedOrigin: ClientTargetInfo["announcedOrigin"];
  readonly connectedAt: string;
  readonly providers: ReadonlyMap<string, string>;
  readonly queue: Queue.Queue<ClientProviderServerFrame>;
}

interface PendingInvoke {
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<Json, ClientProvidersError>;
  /** The declared output schema for this request — `respond` enforces it. */
  readonly output: ValidateFunction;
}

/**
 * A server-minted correlation a client may `emit` against — a subscription
 * (stream events) or a notification (action/dismissal outcome). Ownership is
 * the socket-derived connectionId recorded at creation; emits on any other
 * socket are dropped.
 */
export interface CorrelationEntry {
  readonly connectionId: string;
  readonly kind: "subscription" | "notification";
  readonly deliver: (event: ClientProvidersEmitInput["event"]) => void;
  readonly revoked: () => void;
}

interface SubscriptionSink {
  readonly coalesce: boolean;
  readonly pending: { type: ApiStreamEvent["type"]; value: Json }[];
  readonly waiters: {
    resolve: (result: IteratorResult<ApiStreamEvent>) => void;
    reject: (error: unknown) => void;
  }[];
  closed: { done: true } | { error: ClientProvidersError } | undefined;
  dropped: number;
}

interface BrokerState {
  readonly connections: ReadonlyMap<string, Connection>;
  readonly pending: ReadonlyMap<string, PendingInvoke>;
  readonly correlations: ReadonlyMap<string, CorrelationEntry>;
  readonly subscriptions: ReadonlyMap<string, SubscriptionSink>;
  readonly requestSequence: number;
}

const error = (code: string, detail: string) =>
  new ClientProvidersError({ code, detail: detail.slice(0, 2000) });

const unavailable = (detail: string) => error("client-provider-unavailable", detail);

const EMPTY_STATE: BrokerState = {
  connections: new Map(),
  pending: new Map(),
  correlations: new Map(),
  subscriptions: new Map(),
  requestSequence: 0,
};

/**
 * Socket-derived ownership registry for `t3.client/*` client providers.
 *
 * The WS layer mints `connectionId` at socket accept and binds it to the
 * socket's authenticated session for the socket's lifetime. `respond`/`emit`
 * payloads carry no client-asserted identity — the arriving socket's
 * connectionId must equal the recorded owner of the requestId/correlationId
 * before the result is accepted. There is no failover: a vanished
 * connection's work fails `client-provider-unavailable`, never lands on a
 * sibling.
 */
export class ClientApiProviders extends Context.Service<
  ClientApiProviders,
  {
    readonly connect: (
      socket: ClientProvidersSocket,
      input: ClientProvidersConnectInput,
    ) => Effect.Effect<Stream.Stream<ClientProviderServerFrame>, ClientProvidersError>;
    readonly respond: (
      connectionId: string,
      input: ClientProvidersRespondInput,
    ) => Effect.Effect<void, ClientProvidersError>;
    readonly emit: (
      connectionId: string,
      input: ClientProvidersEmitInput,
    ) => Effect.Effect<void, ClientProvidersError>;
    readonly invoke: (request: {
      readonly connectionId: string;
      readonly apiId: string;
      readonly method: string;
      readonly input: Json;
      readonly context: ExtensionViewContext;
      readonly caller: ClientProviderCaller;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }) => Effect.Effect<Json, ClientProvidersError>;
    readonly openSubscription: (request: {
      readonly connectionId: string;
      readonly apiId: string;
      readonly name: string;
      readonly input: Json;
      readonly context: ExtensionViewContext;
      readonly caller: ClientProviderCaller;
      readonly coalesce?: boolean;
    }) => Effect.Effect<
      { readonly events: AsyncIterable<ApiStreamEvent>; readonly close: () => Effect.Effect<void> },
      ClientProvidersError
    >;
    readonly registerCorrelation: (
      correlationId: string,
      entry: CorrelationEntry,
    ) => Effect.Effect<void, ClientProvidersError>;
    readonly unregisterCorrelation: (correlationId: string) => Effect.Effect<void>;
    readonly listTargets: (environmentId: string) => Effect.Effect<readonly ClientTargetInfo[]>;
    /**
     * Resolves the seam's two target kinds from invocation metadata.
     * `environment-session` principals get `self` — the hint must name a live
     * connection bound to the same session. `host` principals get an explicit
     * `connection` target. `provider-session` principals are denied (V1).
     */
    readonly resolveTarget: (
      environmentId: string,
      principal: HostApiPrincipal | undefined,
      clientConnectionId: string | undefined,
    ) => Effect.Effect<string, ClientProvidersError>;
    readonly hasProvider: (environmentId: string, apiId: string) => Effect.Effect<boolean>;
    readonly connectionForSession: (
      sessionId: string,
      connectionId: string,
    ) => Effect.Effect<boolean>;
  }
>()("t3/extensions/ClientApiProviders") {}

export const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const state = yield* SynchronizedRef.make<BrokerState>(EMPTY_STATE);

  const sinkPush = (sink: SubscriptionSink, event: ApiStreamEvent) => {
    if (sink.closed) return;
    if (sink.coalesce && event.type !== "closed") {
      // State-sync areas are latest-wins — a fresh value replaces the queue.
      sink.pending.length = 0;
      sink.pending.push({ type: event.type, value: event.value });
    } else {
      while (sink.pending.length >= MAX_EVENTS_PER_SUBSCRIPTION) {
        sink.pending.shift();
        sink.dropped++;
      }
      if (sink.dropped > 0) {
        // Non-coalescing streams disclose dropped events instead of losing them.
        sink.pending.push({
          type: "data",
          value: { type: "gap", dropped: sink.dropped },
        });
        sink.dropped = 0;
      }
      sink.pending.push({ type: event.type, value: event.value });
    }
    while (sink.waiters.length && sink.pending.length) {
      const next = sink.pending.shift()!;
      sink.waiters.shift()!.resolve({ done: false, value: next as ApiStreamEvent });
    }
  };

  const sinkClose = (sink: SubscriptionSink, failure?: ClientProvidersError) => {
    if (sink.closed) return;
    sink.closed = failure ? { error: failure } : { done: true };
    for (const waiter of sink.waiters.splice(0)) {
      if (failure) waiter.reject(failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  };

  const sinkIterable = (sink: SubscriptionSink): AsyncIterable<ApiStreamEvent> => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ApiStreamEvent>> {
          const head = sink.pending.shift();
          if (head) return Promise.resolve({ done: false, value: head as ApiStreamEvent });
          if (sink.closed) {
            if ("error" in sink.closed) return Promise.reject(sink.closed.error);
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve, reject) => {
            sink.waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<ApiStreamEvent>> {
          sinkClose(sink);
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  });

  /**
   * Fails every pending invoke and revokes every correlation owned by a dead
   * connection object. Identity matters: a reconnect under the same
   * connectionId installs a new Connection, and the old stream's teardown
   * must not kill the live one.
   */
  const teardownConnection = (current: BrokerState, dead: Connection): BrokerState => {
    const connections = new Map(current.connections);
    if (connections.get(dead.connectionId) === dead) connections.delete(dead.connectionId);
    const pending = new Map(current.pending);
    const correlations = new Map(current.correlations);
    const subscriptions = new Map(current.subscriptions);
    const failure = unavailable("The client provider connection closed.");
    for (const [requestId, entry] of pending) {
      if (entry.connectionId !== dead.connectionId) continue;
      pending.delete(requestId);
      Effect.runFork(Deferred.fail(entry.deferred, failure));
    }
    for (const [correlationId, entry] of correlations) {
      if (entry.connectionId !== dead.connectionId) continue;
      correlations.delete(correlationId);
      try {
        entry.revoked();
      } catch {
        /* A revoked route cannot break disconnect cleanup. */
      }
    }
    for (const [subscriptionId, sink] of subscriptions) {
      const correlation = current.correlations.get(subscriptionId);
      if (correlation?.connectionId !== dead.connectionId) continue;
      subscriptions.delete(subscriptionId);
      sinkClose(sink, failure);
    }
    return { ...current, connections, pending, correlations, subscriptions };
  };

  const dropConnection = (dead: Connection) =>
    SynchronizedRef.update(state, (current) => {
      // A stream that outlived its replacement tears down nothing.
      if (current.connections.get(dead.connectionId) !== dead) return current;
      return teardownConnection(current, dead);
    });

  const connect: (typeof ClientApiProviders)["Service"]["connect"] = (socket, input) =>
    Effect.gen(function* () {
      const accepted: ClientProviderDescriptor[] = [];
      const rejected: { id: string; reason: string }[] = [];
      for (const provider of input.providers) {
        const definition = CLIENT_PROVIDER_APIS.get(provider.id);
        if (!definition) {
          rejected.push({ id: provider.id, reason: "unknown-provider" });
          continue;
        }
        if (!satisfiesSemverRange(provider.version, CLIENT_PROVIDER_SUPPORTED_RANGE)) {
          rejected.push({ id: provider.id, reason: "unsupported-version" });
          continue;
        }
        accepted.push(provider);
      }
      const queue = yield* Queue.unbounded<ClientProviderServerFrame>();
      const connectedAt = DateTime.formatIso(yield* DateTime.now);
      const connection: Connection = {
        connectionId: socket.connectionId,
        sessionId: socket.sessionId,
        announcedOrigin: socket.announcedOrigin,
        connectedAt,
        providers: new Map(accepted.map((item) => [item.id, item.version])),
        queue,
      };
      yield* SynchronizedRef.update(state, (current) => {
        // A reconnect under the same id replaces the old Connection: its
        // pending invokes, correlations, and subscriptions die with it —
        // dispatched frames could never be responded to on the new socket.
        const previous = current.connections.get(socket.connectionId);
        const base = previous ? teardownConnection(current, previous) : current;
        return {
          ...base,
          connections: new Map(base.connections).set(socket.connectionId, connection),
        };
      });
      yield* Queue.offer(queue, {
        type: "registered",
        connectionId: socket.connectionId,
        accepted,
        rejected,
      } satisfies ClientProviderServerFrame);
      return Stream.fromQueue(queue).pipe(Stream.ensuring(dropConnection(connection)));
    });

  const respond: (typeof ClientApiProviders)["Service"]["respond"] = Effect.fn(
    "ClientApiProviders.respond",
  )(function* (connectionId, input) {
    const pending = yield* SynchronizedRef.modify(
      state,
      (current): readonly [PendingInvoke | undefined, BrokerState] => {
        const entry = current.pending.get(input.requestId);
        // A respond on any socket other than the recorded owner is dropped.
        if (!entry || entry.connectionId !== connectionId) return [undefined, current] as const;
        const next = new Map(current.pending);
        next.delete(input.requestId);
        return [entry, { ...current, pending: next }] as const;
      },
    );
    if (!pending) return;
    if (input.ok) {
      // A claimed success still has to satisfy the declared output schema —
      // a malformed result fails the waiter rather than landing upstream.
      const bounded = yield* Effect.try({
        try: () => copyJson(input.value),
        catch: () =>
          error("provider-rejected", "Client provider output exceeds the envelope bound."),
      }).pipe(Effect.result);
      if (!Result.isSuccess(bounded)) {
        yield* Deferred.fail(pending.deferred, bounded.failure);
        return;
      }
      const value = bounded.success;
      if (!pending.output(value)) {
        yield* Deferred.fail(
          pending.deferred,
          error(
            "provider-rejected",
            `Client provider output does not match schema: ${seamAjv.errorsText(pending.output.errors)}`,
          ),
        );
        return;
      }
      yield* Deferred.succeed(pending.deferred, value);
    } else {
      yield* Deferred.fail(pending.deferred, error(input.error.code, input.error.message));
    }
  });

  const emit: (typeof ClientApiProviders)["Service"]["emit"] = Effect.fn("ClientApiProviders.emit")(
    function* (connectionId, input) {
      const correlation = (yield* SynchronizedRef.get(state)).correlations.get(input.correlationId);
      // Emits are accepted only on the socket that owns the correlation.
      if (!correlation || correlation.connectionId !== connectionId) return;
      yield* Effect.sync(() => correlation.deliver(input.event));
    },
  );

  const nextRequestId = SynchronizedRef.modify(state, (current) => {
    const id = `cpr-${current.requestSequence + 1}`;
    return [id, { ...current, requestSequence: current.requestSequence + 1 }] as const;
  });

  const invoke: (typeof ClientApiProviders)["Service"]["invoke"] = Effect.fn(
    "ClientApiProviders.invoke",
  )(function* (request) {
    const method = METHOD_SCHEMAS.get(request.apiId)?.get(request.method);
    if (!method)
      return yield* unavailable(`Unknown client provider op: ${request.apiId}.${request.method}`);
    const input = yield* Effect.try({
      try: () => copyJson(request.input),
      catch: () => error("provider-rejected", "Client provider input exceeds the envelope bound."),
    });
    if (!method.input(input))
      return yield* error(
        "provider-rejected",
        `Client provider input does not match schema: ${seamAjv.errorsText(method.input.errors)}`,
      );
    const timeoutMs = request.timeoutMs ?? 5_000;
    const requestId = yield* nextRequestId;
    const deferred = yield* Deferred.make<Json, ClientProvidersError>();
    const deadlineMs = (yield* Clock.currentTimeMillis) + timeoutMs;
    const routed = yield* SynchronizedRef.modify(
      state,
      (current): readonly [Connection | false, BrokerState] => {
        const connection = current.connections.get(request.connectionId);
        if (!connection || !connection.providers.has(request.apiId))
          return [false, current] as const;
        const pending = new Map(current.pending);
        pending.set(requestId, {
          connectionId: request.connectionId,
          deferred,
          output: method.output,
        });
        return [connection, { ...current, pending }] as const;
      },
    );
    if (routed === false) {
      return yield* unavailable("The targeted client connection does not host this provider.");
    }
    const connection = routed;
    const onAbort = () => {
      const removed = Effect.runSync(
        SynchronizedRef.modify(state, (current) => {
          const entry = current.pending.get(requestId);
          if (!entry || entry.connectionId !== request.connectionId)
            return [false, current] as const;
          const pending = new Map(current.pending);
          pending.delete(requestId);
          return [true, { ...current, pending }] as const;
        }),
      );
      if (!removed) return;
      // Server-side aborts reach the client as a cancel frame; cancellation
      // after dispatch is not rollback.
      Effect.runFork(Queue.offer(connection.queue, { type: "cancel", requestId }));
      Effect.runFork(
        Deferred.fail(deferred, error("client-request-timeout", "Client request aborted.")),
      );
    };
    const signal = request.signal;
    if (signal?.aborted) {
      // Dead on arrival: no invoke is dispatched, so the cancel frame it would
      // pair with is dropped on the client side as an unknown requestId.
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
      yield* Queue.offer(connection.queue, {
        type: "invoke",
        requestId,
        apiId: request.apiId,
        method: request.method,
        input,
        context: request.context,
        caller: request.caller,
        deadlineMs,
      } satisfies ClientProviderServerFrame);
    }
    const result = yield* Deferred.await(deferred).pipe(
      Effect.timeout(timeoutMs + 2_000),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(error("client-request-timeout", "Client provider request timed out.")),
      ),
      // Every exit — resolve, client error, timeout, interruption — drops the
      // pending record and the abort listener. A respond that lands later
      // finds no entry and is dropped rather than resolving a dead waiter.
      Effect.ensuring(
        Effect.suspend(() => {
          signal?.removeEventListener("abort", onAbort);
          return SynchronizedRef.update(state, (current) => {
            const pending = new Map(current.pending);
            pending.delete(requestId);
            return { ...current, pending };
          });
        }),
      ),
    );
    return result;
  });

  const openSubscription: (typeof ClientApiProviders)["Service"]["openSubscription"] = Effect.fn(
    "ClientApiProviders.openSubscription",
  )(function* (request) {
    const stream = STREAM_SCHEMAS.get(request.apiId)?.get(request.name);
    if (!stream)
      return yield* unavailable(`Unknown client provider stream: ${request.apiId}.${request.name}`);
    const input = yield* Effect.try({
      try: () => copyJson(request.input),
      catch: () => error("provider-rejected", "Client provider input exceeds the envelope bound."),
    });
    if (!stream.input(input))
      return yield* error(
        "provider-rejected",
        `Client provider stream input does not match schema: ${seamAjv.errorsText(stream.input.errors)}`,
      );
    const subscriptionId = yield* nextRequestId;
    const sink: SubscriptionSink = {
      coalesce: request.coalesce === true,
      pending: [],
      waiters: [],
      closed: undefined,
      dropped: 0,
    };
    const routed = yield* SynchronizedRef.modify(
      state,
      (current): readonly [Connection | undefined, BrokerState] => {
        const connection = current.connections.get(request.connectionId);
        if (!connection || !connection.providers.has(request.apiId))
          return [undefined, current] as const;
        const correlations = new Map(current.correlations);
        correlations.set(subscriptionId, {
          connectionId: request.connectionId,
          kind: "subscription",
          deliver: (event) => {
            if (event.type === "notificationOutcome") return;
            // Every emitted payload obeys the envelope bound — including the
            // terminal `closed` frame — before any schema checks.
            let value: Json;
            try {
              value = copyJson(event.value);
            } catch {
              sinkClose(
                sink,
                error("provider-rejected", "Client provider event exceeds the envelope bound."),
              );
              return;
            }
            // `closed` terminates the stream; payload events must satisfy the
            // declared event schema — an invalid event fails the subscription.
            if (event.type === "closed") {
              sinkPush(sink, { type: event.type, value });
              sinkClose(sink);
              return;
            }
            if (!stream.event(value)) {
              sinkClose(
                sink,
                error(
                  "provider-rejected",
                  `Client provider event does not match schema: ${seamAjv.errorsText(stream.event.errors)}`,
                ),
              );
              return;
            }
            sinkPush(sink, { type: event.type, value });
          },
          revoked: () => sinkClose(sink, unavailable("The client provider connection closed.")),
        });
        const subscriptions = new Map(current.subscriptions);
        subscriptions.set(subscriptionId, sink);
        return [connection, { ...current, correlations, subscriptions }] as const;
      },
    );
    if (!routed) {
      return yield* unavailable("The targeted client connection does not host this provider.");
    }
    yield* Queue.offer(routed.queue, {
      type: "subscriptionOpen",
      subscriptionId,
      apiId: request.apiId,
      name: request.name,
      input,
      context: request.context,
      caller: request.caller,
    } satisfies ClientProviderServerFrame);
    const close = Effect.fn("ClientApiProviders.closeSubscription")(function* () {
      yield* SynchronizedRef.update(state, (current) => {
        const correlations = new Map(current.correlations);
        correlations.delete(subscriptionId);
        const subscriptions = new Map(current.subscriptions);
        subscriptions.delete(subscriptionId);
        return { ...current, correlations, subscriptions };
      });
      sinkClose(sink);
      const connection = (yield* SynchronizedRef.get(state)).connections.get(request.connectionId);
      // The client removes its watcher on subscriptionClose; emits after
      // close are dropped by the removed correlation record.
      if (connection) {
        yield* Queue.offer(connection.queue, {
          type: "subscriptionClose",
          subscriptionId,
        } satisfies ClientProviderServerFrame);
      }
    });
    return { events: sinkIterable(sink), close };
  });

  const registerCorrelation: (typeof ClientApiProviders)["Service"]["registerCorrelation"] =
    Effect.fn("ClientApiProviders.registerCorrelation")(function* (correlationId, entry) {
      const live = yield* SynchronizedRef.modify(state, (current) => {
        const connection = current.connections.get(entry.connectionId);
        if (!connection) return [false, current] as const;
        const correlations = new Map(current.correlations);
        correlations.set(correlationId, entry);
        return [true, { ...current, correlations }] as const;
      });
      if (!live) return yield* unavailable("The owning client connection is gone.");
    });

  const unregisterCorrelation: (typeof ClientApiProviders)["Service"]["unregisterCorrelation"] =
    Effect.fn("ClientApiProviders.unregisterCorrelation")(function* (correlationId) {
      yield* SynchronizedRef.update(state, (current) => {
        const correlations = new Map(current.correlations);
        correlations.delete(correlationId);
        return { ...current, correlations };
      });
    });

  const listTargets: (typeof ClientApiProviders)["Service"]["listTargets"] = Effect.fn(
    "ClientApiProviders.listTargets",
  )(function* (requestedEnvironmentId) {
    if (requestedEnvironmentId !== environmentId) return [];
    return [...(yield* SynchronizedRef.get(state)).connections.values()].map((connection) => ({
      connectionId: connection.connectionId,
      ...(connection.announcedOrigin ? { announcedOrigin: connection.announcedOrigin } : {}),
      providers: [...connection.providers.entries()].map(([id, version]) => ({ id, version })),
      connectedAt: connection.connectedAt,
    }));
  });

  const resolveTarget: (typeof ClientApiProviders)["Service"]["resolveTarget"] = Effect.fn(
    "ClientApiProviders.resolveTarget",
  )(function* (requestedEnvironmentId, principal, clientConnectionId) {
    if (requestedEnvironmentId !== environmentId) {
      return yield* unavailable("The targeted environment has no client-provider registry.");
    }
    if (!principal || principal.kind === "provider-session") {
      // MCP/provider-session callers cannot reach client ops in V1.
      return yield* error("client-target-denied", "Provider sessions cannot target clients.");
    }
    if (!clientConnectionId) {
      return yield* error(
        "client-target-required",
        principal.kind === "environment-session"
          ? "The call needs the client's own connection hint."
          : "Host-originated calls must name an explicit connectionId.",
      );
    }
    const connection = (yield* SynchronizedRef.get(state)).connections.get(clientConnectionId);
    if (!connection) {
      return yield* unavailable("The targeted client connection is gone.");
    }
    if (principal.kind === "environment-session" && connection.sessionId !== principal.id) {
      // The hint can only resolve to self inside the caller's authenticated session.
      return yield* error(
        "client-target-denied",
        "The named connection belongs to a different session.",
      );
    }
    return connection.connectionId;
  });

  const hasProvider: (typeof ClientApiProviders)["Service"]["hasProvider"] = Effect.fn(
    "ClientApiProviders.hasProvider",
  )(function* (requestedEnvironmentId, apiId) {
    if (requestedEnvironmentId !== environmentId) return false;
    for (const connection of (yield* SynchronizedRef.get(state)).connections.values()) {
      if (connection.providers.has(apiId)) return true;
    }
    return false;
  });

  const connectionForSession: (typeof ClientApiProviders)["Service"]["connectionForSession"] =
    Effect.fn("ClientApiProviders.connectionForSession")(function* (sessionId, connectionId) {
      const connection = (yield* SynchronizedRef.get(state)).connections.get(connectionId);
      return connection?.sessionId === sessionId;
    });

  return {
    connect,
    respond,
    emit,
    invoke,
    openSubscription,
    registerCorrelation,
    unregisterCorrelation,
    listTargets,
    resolveTarget,
    hasProvider,
    connectionForSession,
  } satisfies ClientApiProviders["Service"];
});

export const layer = Layer.effect(ClientApiProviders, make);
