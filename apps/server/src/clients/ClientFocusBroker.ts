import type {
  AuthSessionId,
  ClientActivityLease,
  ClientFocusHost,
  ClientFocusInput,
  ClientFocusRequest,
  ClientFocusResult,
  ConnectedClient,
  RpcClientId,
} from "@t3tools/contracts";
import { ClientNotConnectedError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";

/**
 * Routes "bring this on screen" requests to connected clients. A client is
 * focusable while it holds a `clients.connectFocus` stream open; its activity
 * lease (see BackgroundPolicy) says whether it is visible or focused.
 */
export class ClientFocusBroker extends Context.Service<
  ClientFocusBroker,
  {
    readonly connect: (
      connection: { readonly sessionId: AuthSessionId; readonly rpcClientId: RpcClientId },
      host: ClientFocusHost,
    ) => Effect.Effect<Stream.Stream<ClientFocusRequest>>;
    readonly list: Effect.Effect<ReadonlyArray<ConnectedClient>>;
    readonly focus: (
      input: ClientFocusInput,
    ) => Effect.Effect<ClientFocusResult, ClientNotConnectedError>;
  }
>()("t3/clients/ClientFocusBroker") {}

interface Connection {
  readonly sessionId: AuthSessionId;
  readonly rpcClientId: RpcClientId;
  readonly host: ClientFocusHost;
  readonly connectedAt: DateTime.Utc;
  readonly queue: Queue.Queue<ClientFocusRequest>;
}

interface Activity {
  readonly visible: boolean;
  readonly focused: boolean;
}

const INACTIVE: Activity = { visible: false, focused: false };

function activityOf(connection: Connection, leases: ReadonlyArray<ClientActivityLease>): Activity {
  const lease = leases.find(
    (candidate) =>
      candidate.clientId === connection.host.clientId &&
      candidate.sessionId === connection.sessionId &&
      candidate.rpcClientId === connection.rpcClientId,
  );
  return lease ? { visible: lease.visible, focused: lease.focused } : INACTIVE;
}

const rank = (activity: Activity) => (activity.focused ? 2 : 0) + (activity.visible ? 1 : 0);

/**
 * Picks the window most likely in front of the user: focused, then visible,
 * then the most recent connection. Several browser tabs share one clientId.
 */
function preferredConnection(
  connections: ReadonlyArray<Connection>,
  leases: ReadonlyArray<ClientActivityLease>,
): Connection | undefined {
  let best: { connection: Connection; score: number } | undefined;
  for (const connection of connections) {
    const score = rank(activityOf(connection, leases));
    if (
      best === undefined ||
      score > best.score ||
      (score === best.score &&
        DateTime.isGreaterThan(connection.connectedAt, best.connection.connectedAt))
    ) {
      best = { connection, score };
    }
  }
  return best?.connection;
}

/** @public */
export const make = Effect.fn("clients.focusBroker.make")(function* (
  leases: Effect.Effect<ReadonlyArray<ClientActivityLease>>,
) {
  const connectionsRef = yield* Ref.make<ReadonlySet<Connection>>(new Set());
  const random = yield* SecureRandom.SecureRandom;

  // Registers on call so a focus request can target the client as soon as the
  // stream exists; the stream's finalizer unregisters it.
  const connect: ClientFocusBroker["Service"]["connect"] = Effect.fn("clients.focusBroker.connect")(
    function* (identity, host) {
      const queue = yield* Queue.unbounded<ClientFocusRequest>();
      const connection: Connection = {
        ...identity,
        host,
        connectedAt: yield* DateTime.now,
        queue,
      };
      yield* Ref.update(connectionsRef, (current) => new Set(current).add(connection));
      return Stream.fromQueue(queue).pipe(
        Stream.ensuring(
          Ref.update(connectionsRef, (current) => {
            const next = new Set(current);
            next.delete(connection);
            return next;
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
        ),
      );
    },
  );

  const list: ClientFocusBroker["Service"]["list"] = Effect.gen(function* () {
    const [connections, currentLeases] = yield* Effect.all([Ref.get(connectionsRef), leases]);
    const byClient = new Map<string, ConnectedClient>();
    // Oldest first, so the newest connection's label and kind win.
    const ordered = [...connections].toSorted((left, right) =>
      DateTime.Order(left.connectedAt, right.connectedAt),
    );
    for (const connection of ordered) {
      const activity = activityOf(connection, currentLeases);
      const existing = byClient.get(connection.host.clientId);
      byClient.set(connection.host.clientId, {
        ...connection.host,
        visible: activity.visible || (existing?.visible ?? false),
        focused: activity.focused || (existing?.focused ?? false),
        connectedAt: connection.connectedAt,
      });
    }
    return [...byClient.values()].toSorted((left, right) => left.label.localeCompare(right.label));
  });

  const focus: ClientFocusBroker["Service"]["focus"] = Effect.fn("clients.focusBroker.focus")(
    function* (input) {
      const [connections, currentLeases] = yield* Effect.all([Ref.get(connectionsRef), leases]);
      const target = preferredConnection(
        [...connections].filter((connection) => connection.host.clientId === input.clientId),
        currentLeases,
      );
      if (target === undefined) {
        return yield* new ClientNotConnectedError({ clientId: input.clientId });
      }
      const requestId = yield* random.uuidV4();
      yield* Queue.offer(target.queue, { requestId, target: input.target });
      return { requestId, clientId: input.clientId, label: target.host.label };
    },
  );

  return ClientFocusBroker.of({ connect, list, focus });
});

export const layer = Layer.effect(
  ClientFocusBroker,
  Effect.gen(function* () {
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    return yield* make(Effect.map(backgroundPolicy.snapshot, (snapshot) => snapshot.leases));
  }),
);
