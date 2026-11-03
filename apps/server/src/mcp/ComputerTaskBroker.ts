import {
  COMPUTER_SEND_TIMEOUT_MS,
  ComputerTaskError,
  type ComputerListEntry,
  type ComputerPeer,
  type ComputerTaskHost,
  type ComputerTaskResponse,
  type ComputerTaskSendRequest,
  type ComputerTaskSendResult,
  type ComputerTaskStreamEvent,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { resolveAppDisplayName } from "../appDisplayName.ts";

export class ComputerTaskBroker extends Context.Service<
  ComputerTaskBroker,
  {
    readonly connect: (
      host: ComputerTaskHost,
    ) => Effect.Effect<Stream.Stream<ComputerTaskStreamEvent>>;
    readonly sync: (host: ComputerTaskHost) => Effect.Effect<void, ComputerTaskError>;
    readonly respond: (response: ComputerTaskResponse) => Effect.Effect<void, ComputerTaskError>;
    readonly list: (
      descriptor: ExecutionEnvironmentDescriptor,
    ) => Effect.Effect<ReadonlyArray<ComputerListEntry>>;
    readonly send: (
      request: Omit<ComputerTaskSendRequest, "requestId">,
    ) => Effect.Effect<ComputerTaskSendResult, ComputerTaskError>;
  }
>()("t3/mcp/ComputerTaskBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly computers: ReadonlyArray<ComputerPeer>;
  readonly queue: Queue.Queue<ComputerTaskStreamEvent>;
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<ComputerTaskSendResult, ComputerTaskError>;
  readonly clientId: string;
  readonly connectionId: string;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
}

const removeConnection = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const existing = current.clients.get(clientId);
  if (!existing || existing.queue !== queue) {
    return { state: current, disconnected: [] };
  }
  const clients = new Map(current.clients);
  clients.delete(clientId);
  const disconnected: Array<PendingRequest> = [];
  const pending = new Map(current.pending);
  for (const [requestId, entry] of current.pending) {
    if (entry.clientId === clientId && entry.connectionId === existing.connectionId) {
      pending.delete(requestId);
      disconnected.push(entry);
    }
  }
  return { state: { clients, pending }, disconnected };
};

const toListEntry = (peer: ComputerPeer, thisEnvironmentId: string): ComputerListEntry => ({
  ...peer,
  thisMachine: peer.environmentId === thisEnvironmentId,
});

export const mergeComputerCatalog = (
  descriptor: ExecutionEnvironmentDescriptor,
  catalogs: ReadonlyArray<ReadonlyArray<ComputerPeer>>,
): ReadonlyArray<ComputerListEntry> => {
  const byId = new Map<string, ComputerPeer>();
  byId.set(descriptor.environmentId, {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    kind: "local",
    os: descriptor.platform.os,
    connected: true,
  });
  for (const catalog of catalogs) {
    for (const peer of catalog) {
      const existing = byId.get(peer.environmentId);
      if (
        !existing ||
        (peer.connected && !existing.connected) ||
        (peer.connected === existing.connected &&
          peer.kind !== "local" &&
          existing.kind === "local")
      ) {
        byId.set(peer.environmentId, peer);
      }
    }
  }
  return [...byId.values()]
    .map((peer) => toListEntry(peer, descriptor.environmentId))
    .toSorted((left, right) => {
      if (left.thisMachine !== right.thisMachine) return left.thisMachine ? -1 : 1;
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return left.label.localeCompare(right.label);
    });
};

const pickClientForComputer = (
  clients: ReadonlyMap<string, ClientConnection>,
  environmentId: string,
): ClientConnection | undefined => {
  const advertised = [...clients.values()].filter((client) =>
    client.computers.some((computer) => computer.environmentId === environmentId),
  );
  return (
    advertised.find((client) =>
      client.computers.some(
        (computer) => computer.environmentId === environmentId && computer.connected,
      ),
    ) ??
    advertised[0] ??
    [...clients.values()][0]
  );
};

export const make = Effect.gen(function* ComputerTaskBrokerMake() {
  const random = yield* SecureRandom.SecureRandom;
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    pending: new Map(),
  });

  const closeConnection = Effect.fn("ComputerTaskBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred }) =>
        Deferred.fail(
          deferred,
          new ComputerTaskError({
            code: "no_client",
            detail: `The ${resolveAppDisplayName()} client that could reach that computer disconnected.`,
          }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("ComputerTaskBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnection(current, clientId, queue);
      return [removed.disconnected, removed.state] as const;
    });
    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("ComputerTaskBroker.acquireConnection")(function* (
    host: ComputerTaskHost,
  ) {
    const queue = yield* Queue.unbounded<ComputerTaskStreamEvent>();
    const connectionId = yield* random.uuidV4();
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId: host.clientId,
      connectionId,
      computers: host.computers,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previous = current.clients.get(host.clientId);
      const removed = previous
        ? removeConnection(current, host.clientId, previous.queue)
        : { state: current, disconnected: [] };
      const clients = new Map(removed.state.clients);
      clients.set(host.clientId, connection);
      return [
        { previous, disconnected: removed.disconnected },
        { ...removed.state, clients },
      ] as const;
    });
    if (registration.previous) {
      yield* closeConnection(registration.previous.queue, registration.disconnected);
    }
    return connection;
  });

  const connect: ComputerTaskBroker["Service"]["connect"] = Effect.fn("ComputerTaskBroker.connect")(
    (host) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(acquireConnection(host), (connection) =>
            disconnect(connection.clientId, connection.queue),
          ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
        ),
      ),
  );

  const sync: ComputerTaskBroker["Service"]["sync"] = Effect.fn("ComputerTaskBroker.sync")(
    function* (host) {
      const updated = yield* SynchronizedRef.modify(state, (current) => {
        const existing = current.clients.get(host.clientId);
        if (!existing) return [false, current] as const;
        const clients = new Map(current.clients);
        clients.set(host.clientId, { ...existing, computers: host.computers });
        return [true, { ...current, clients }] as const;
      });
      if (!updated) {
        return yield* new ComputerTaskError({
          code: "no_client",
          detail: "No computer-task client is connected with that id.",
        });
      }
    },
  );

  const respond: ComputerTaskBroker["Service"]["respond"] = Effect.fn("ComputerTaskBroker.respond")(
    function* (response) {
      const pending = yield* SynchronizedRef.modify(state, (current) => {
        const entry = current.pending.get(response.requestId);
        if (
          !entry ||
          entry.clientId !== response.clientId ||
          entry.connectionId !== response.connectionId
        ) {
          return [undefined, current] as const;
        }
        const pending = new Map(current.pending);
        pending.delete(response.requestId);
        return [entry, { ...current, pending }] as const;
      });
      if (!pending) return;
      if (response.ok && response.result) {
        yield* Deferred.succeed(pending.deferred, response.result);
        return;
      }
      yield* Deferred.fail(
        pending.deferred,
        new ComputerTaskError({
          code: response.error?.code ?? "dispatch_failed",
          detail:
            response.error?.detail ??
            `The ${resolveAppDisplayName()} client could not start the task on that computer.`,
        }),
      );
    },
  );

  const list: ComputerTaskBroker["Service"]["list"] = Effect.fn("ComputerTaskBroker.list")(
    function* (descriptor) {
      const current = yield* SynchronizedRef.get(state);
      return mergeComputerCatalog(
        descriptor,
        [...current.clients.values()].map((client) => client.computers),
      );
    },
  );

  const send: ComputerTaskBroker["Service"]["send"] = Effect.fn("ComputerTaskBroker.send")(
    function* (request) {
      const requestId = yield* random.uuidV4();
      const deferred = yield* Deferred.make<ComputerTaskSendResult, ComputerTaskError>();
      const route = yield* SynchronizedRef.modify(state, (current) => {
        const client = pickClientForComputer(current.clients, request.computer.environmentId);
        if (!client) return [undefined, current] as const;
        const pending = new Map(current.pending);
        pending.set(requestId, {
          deferred,
          clientId: client.clientId,
          connectionId: client.connectionId,
        });
        return [
          { client, requestId },
          { ...current, pending },
        ] as const;
      });
      if (!route) {
        return yield* new ComputerTaskError({
          code: "no_client",
          detail: `No ${resolveAppDisplayName()} client is connected that can reach another computer. Keep the desktop or web app open.`,
        });
      }
      const offered = yield* Queue.offer(route.client.queue, {
        type: "request",
        connectionId: route.client.connectionId,
        request: { ...request, requestId: route.requestId },
      });
      const removePending = SynchronizedRef.update(state, (current) => {
        const pending = new Map(current.pending);
        pending.delete(route.requestId);
        return { ...current, pending };
      });
      if (!offered) {
        yield* removePending;
        return yield* new ComputerTaskError({
          code: "no_client",
          detail: `The ${resolveAppDisplayName()} client disconnected before the task could be sent.`,
        });
      }
      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(COMPUTER_SEND_TIMEOUT_MS),
        Effect.ensuring(removePending),
      );
      return yield* Effect.fromOption(
        result,
        () =>
          new ComputerTaskError({
            code: "dispatch_failed",
            detail: "Timed out waiting for the other computer to accept the task.",
          }),
      );
    },
  );

  return ComputerTaskBroker.of({ connect, sync, respond, list, send });
}).pipe(Effect.withSpan("ComputerTaskBroker.make"));

export const layer = Layer.effect(ComputerTaskBroker, make);
