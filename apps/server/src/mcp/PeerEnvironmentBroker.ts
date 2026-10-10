import {
  PeerEnvironmentFailureCode,
  type PeerEnvironmentHost,
  type PeerEnvironmentOperation,
  type PeerEnvironmentResponse,
  type PeerEnvironmentResult,
  type PeerEnvironmentStreamEvent,
  type PeerEnvironmentSummary,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class PeerEnvironmentBrokerError extends Schema.TaggedError<PeerEnvironmentBrokerError>()(
  "PeerEnvironmentBrokerError",
  {
    /** `host_unavailable`: no connected client could carry the request. */
    code: Schema.Union([PeerEnvironmentFailureCode, Schema.Literal("host_unavailable")]),
    message: Schema.String,
  },
) {}

type OperationName = PeerEnvironmentOperation["operation"];
type ResultFor<Name extends OperationName> = Extract<PeerEnvironmentResult, { operation: Name }>;

/**
 * Routes a server-side request for another environment through a connected
 * client. This server holds no credential for other environments: a client
 * that is connected to both runs the request over its own session there, so
 * the other environment enforces that client's permissions.
 */
export class PeerEnvironmentBroker extends Context.Service<
  PeerEnvironmentBroker,
  {
    readonly connect: (
      host: PeerEnvironmentHost,
    ) => Effect.Effect<Stream.Stream<PeerEnvironmentStreamEvent>>;
    readonly respond: (response: PeerEnvironmentResponse) => Effect.Effect<void>;
    /** Environments any connected client can reach, best status first. */
    readonly list: Effect.Effect<ReadonlyArray<PeerEnvironmentSummary>, PeerEnvironmentBrokerError>;
    readonly invoke: <const Operation extends PeerEnvironmentOperation>(
      operation: Operation,
      timeoutMs?: number,
    ) => Effect.Effect<ResultFor<Operation["operation"]>, PeerEnvironmentBrokerError>;
  }
>()("t3/mcp/PeerEnvironmentBroker") {}

interface HostConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly order: number;
  readonly queue: Queue.Queue<PeerEnvironmentStreamEvent, Cause.Done>;
}

interface PendingRequest {
  readonly host: HostConnection;
  readonly deferred: Deferred.Deferred<PeerEnvironmentResult, PeerEnvironmentBrokerError>;
}

interface BrokerState {
  readonly hosts: ReadonlyMap<string, HostConnection>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly order: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 5_000;

const NO_HOST_MESSAGE =
  "No T3 Code app is connected to this environment right now. Reaching another environment needs the desktop, web, or mobile app open and connected to both.";

const STATUS_RANK: Record<PeerEnvironmentSummary["status"], number> = {
  connected: 0,
  unauthorized: 1,
  incompatible: 2,
  offline: 3,
};

// Another client may reach the target where this one could not.
const canTryNextHost = (error: PeerEnvironmentBrokerError) =>
  error.code === "host_unavailable" ||
  error.code === "environment_not_connected" ||
  error.code === "environment_offline";

const ERROR_RANK: Record<PeerEnvironmentBrokerError["code"], number> = {
  environment_request_failed: 0,
  environment_unauthorized: 1,
  environment_incompatible: 2,
  environment_offline: 3,
  environment_not_connected: 4,
  host_unavailable: 5,
};

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const state = yield* Ref.make<BrokerState>({ hosts: new Map(), pending: new Map(), order: 0 });

  const disconnectedError = new PeerEnvironmentBrokerError({
    code: "host_unavailable",
    message: "The T3 Code app carrying this request disconnected before answering.",
  });

  /** Drops one connection generation and fails whatever it still owed. */
  const release = Effect.fn("PeerEnvironmentBroker.release")(function* (host: HostConnection) {
    const orphaned = yield* Ref.modify(state, (current) => {
      const hosts = new Map(current.hosts);
      if (hosts.get(host.clientId)?.connectionId === host.connectionId) hosts.delete(host.clientId);
      const pending = new Map(current.pending);
      const orphaned: Array<PendingRequest> = [];
      for (const [requestId, entry] of pending) {
        if (entry.host.connectionId !== host.connectionId) continue;
        pending.delete(requestId);
        orphaned.push(entry);
      }
      return [orphaned, { ...current, hosts, pending }];
    });
    yield* Queue.end(host.queue);
    yield* Effect.forEach(orphaned, (entry) => Deferred.fail(entry.deferred, disconnectedError), {
      discard: true,
    });
  });

  const acquire = Effect.fn("PeerEnvironmentBroker.acquire")(function* (
    input: PeerEnvironmentHost,
  ) {
    const queue = yield* Queue.unbounded<PeerEnvironmentStreamEvent, Cause.Done>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const { host, replaced } = yield* Ref.modify(state, (current) => {
      const order = current.order + 1;
      const host: HostConnection = { clientId: input.clientId, connectionId, order, queue };
      const hosts = new Map(current.hosts);
      const replaced = hosts.get(input.clientId);
      hosts.set(input.clientId, host);
      return [
        { host, replaced },
        { ...current, hosts, order },
      ];
    });
    if (replaced !== undefined) yield* release(replaced);
    return host;
  });

  const invokeOn = Effect.fn("PeerEnvironmentBroker.invokeOn")(function* (
    host: HostConnection,
    operation: PeerEnvironmentOperation,
    timeoutMs: number,
  ) {
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const deferred = yield* Deferred.make<PeerEnvironmentResult, PeerEnvironmentBrokerError>();
    yield* Ref.update(state, (current) => ({
      ...current,
      pending: new Map(current.pending).set(requestId, { host, deferred }),
    }));
    const forget = Ref.update(state, (current) => {
      const pending = new Map(current.pending);
      pending.delete(requestId);
      return { ...current, pending };
    });
    return yield* Effect.gen(function* () {
      const offered = yield* Queue.offer(host.queue, {
        type: "request",
        connectionId: host.connectionId,
        request: { requestId, operation, timeoutMs },
      });
      if (!offered) return yield* disconnectedError;
      const answer = yield* Deferred.await(deferred).pipe(
        // The client enforces timeoutMs itself; the slack covers its reply.
        Effect.timeoutOption(timeoutMs + 2_000),
      );
      if (Option.isSome(answer)) return answer.value;
      // A silent client is not retried on later requests until it reconnects.
      yield* release(host);
      return yield* new PeerEnvironmentBrokerError({
        code: "host_unavailable",
        message: "The T3 Code app carrying this request did not answer in time.",
      });
    }).pipe(Effect.ensuring(forget));
  });

  const hostsNewestFirst = Ref.get(state).pipe(
    Effect.map((current) =>
      Array.from(current.hosts.values()).toSorted((left, right) => right.order - left.order),
    ),
  );

  const invoke = Effect.fn("PeerEnvironmentBroker.invoke")(function* (
    operation: PeerEnvironmentOperation,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    let failure = new PeerEnvironmentBrokerError({
      code: "host_unavailable",
      message: NO_HOST_MESSAGE,
    });
    for (const host of yield* hostsNewestFirst) {
      const attempt = yield* invokeOn(host, operation, timeoutMs).pipe(
        Effect.map((result) => ({ result })),
        Effect.catch((error) => Effect.succeed({ error })),
      );
      if ("result" in attempt) return attempt.result;
      if (ERROR_RANK[attempt.error.code] <= ERROR_RANK[failure.code]) failure = attempt.error;
      if (!canTryNextHost(attempt.error)) break;
    }
    return yield* failure;
  });

  const list = Effect.gen(function* () {
    const hosts = yield* hostsNewestFirst;
    if (hosts.length === 0) {
      return yield* new PeerEnvironmentBrokerError({
        code: "host_unavailable",
        message: NO_HOST_MESSAGE,
      });
    }
    const answers = yield* Effect.forEach(
      hosts,
      (host) => invokeOn(host, { operation: "list" }, LIST_TIMEOUT_MS).pipe(Effect.option),
      { concurrency: "unbounded" },
    );
    const merged = new Map<string, PeerEnvironmentSummary>();
    for (const answer of answers) {
      if (Option.isNone(answer) || answer.value.operation !== "list") continue;
      for (const environment of answer.value.environments) {
        const known = merged.get(environment.environmentId);
        if (known === undefined || STATUS_RANK[environment.status] < STATUS_RANK[known.status]) {
          merged.set(environment.environmentId, environment);
        }
      }
    }
    return Array.from(merged.values());
  });

  return PeerEnvironmentBroker.of({
    connect: (host) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(acquire(host), release).pipe(
            Effect.map((connection) => Stream.fromQueue(connection.queue)),
          ),
        ),
      ),
    respond: Effect.fn("PeerEnvironmentBroker.respond")(function* (response) {
      const entry = (yield* Ref.get(state)).pending.get(response.requestId);
      if (
        entry === undefined ||
        entry.host.clientId !== response.clientId ||
        entry.host.connectionId !== response.connectionId
      ) {
        return;
      }
      yield* response.outcome.ok
        ? Deferred.succeed(entry.deferred, response.outcome.result)
        : Deferred.fail(
            entry.deferred,
            new PeerEnvironmentBrokerError({
              code: response.outcome.code,
              message: response.outcome.message,
            }),
          );
    }),
    list,
    invoke: <const Operation extends PeerEnvironmentOperation>(
      operation: Operation,
      timeoutMs?: number,
    ) =>
      invoke(operation, timeoutMs).pipe(
        Effect.flatMap((result) =>
          result.operation === operation.operation
            ? // The check above is what narrows the union to the requested operation.
              Effect.succeed(result as ResultFor<Operation["operation"]>)
            : Effect.fail(
                new PeerEnvironmentBrokerError({
                  code: "environment_request_failed",
                  message: "The T3 Code app answered a different request.",
                }),
              ),
        ),
      ),
  });
}).pipe(Effect.withSpan("PeerEnvironmentBroker.make"));

export const layer = Layer.effect(PeerEnvironmentBroker, make);
