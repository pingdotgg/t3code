/**
 * Only clients can render canvas screenshots, so requests route to a connected browser.
 * Screenshots require a mounted document; open requests prefer the visible thread,
 * then the focused client, then the most recently registered host.
 */
import {
  CanvasHostRequestFailedError,
  CanvasHostUnavailableError,
  type CanvasDocumentId,
  type CanvasHostRegistration,
  type CanvasHostRequest,
  type CanvasHostResponse,
  type CanvasHostScreenshot,
  type CanvasHostStreamEvent,
  type CanvasHostUpdate,
  type CanvasNodeId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { builtinService } from "../plugins/PluginKernel.ts";

const REQUEST_TIMEOUT_MS = 20_000;

export type CanvasHostError = CanvasHostUnavailableError | CanvasHostRequestFailedError;

export class CanvasHostBroker extends Context.Service<
  CanvasHostBroker,
  {
    readonly connect: (
      registration: CanvasHostRegistration,
    ) => Stream.Stream<CanvasHostStreamEvent>;
    readonly update: (update: CanvasHostUpdate) => Effect.Effect<void>;
    readonly respond: (response: CanvasHostResponse) => Effect.Effect<void>;
    readonly screenshot: (input: {
      readonly documentId: CanvasDocumentId;
      readonly nodeId?: CanvasNodeId | undefined;
      readonly scale: number;
    }) => Effect.Effect<CanvasHostScreenshot, CanvasHostError>;
    readonly open: (input: {
      readonly threadId: ThreadId;
      readonly documentId?: CanvasDocumentId | undefined;
    }) => Effect.Effect<void, CanvasHostError>;
  }
>()("t3/canvas/CanvasHostBroker") {}

interface Host {
  readonly clientId: string;
  readonly connectionId: string;
  readonly queue: Queue.Queue<CanvasHostStreamEvent, Cause.Done>;
  readonly focused: boolean;
  readonly mountedDocumentIds: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
  readonly order: number;
}

interface Pending {
  readonly clientId: string;
  readonly connectionId: string;
  readonly deferred: Deferred.Deferred<CanvasHostResponse, CanvasHostError>;
}

interface State {
  readonly closed: boolean;
  readonly hosts: ReadonlyMap<string, Host>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly sequence: number;
}

const disconnectedError = new CanvasHostUnavailableError({
  reason: "The T3 Code client handling this canvas request disconnected.",
});

const make = Effect.gen(function* () {
  const secureRandom = yield* SecureRandom.SecureRandom;
  const state = yield* SynchronizedRef.make<State>({
    closed: false,
    hosts: new Map(),
    pending: new Map(),
    sequence: 0,
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const previous = yield* SynchronizedRef.modify(
        state,
        (current) =>
          [current, { ...current, closed: true, hosts: new Map(), pending: new Map() }] as const,
      );
      yield* Effect.forEach(
        previous.pending.values(),
        (entry) => Deferred.fail(entry.deferred, disconnectedError),
        { discard: true },
      );
      yield* Effect.forEach(
        previous.hosts.values(),
        (host) => Queue.clear(host.queue).pipe(Effect.andThen(Queue.end(host.queue))),
        { discard: true },
      );
    }),
  );

  /** Fails the requests one host generation still owed. */
  const failHostRequests = Effect.fn("CanvasHostBroker.failHostRequests")(function* (
    connectionId: string,
  ) {
    const orphaned = yield* SynchronizedRef.modify(state, (current) => {
      const pending = new Map(current.pending);
      const orphaned: Pending[] = [];
      for (const [requestId, entry] of current.pending) {
        if (entry.connectionId !== connectionId) continue;
        pending.delete(requestId);
        orphaned.push(entry);
      }
      return [orphaned, { ...current, pending }] as const;
    });
    yield* Effect.forEach(orphaned, (entry) => Deferred.fail(entry.deferred, disconnectedError), {
      discard: true,
    });
  });

  const removeHost = (clientId: string, connectionId: string) =>
    SynchronizedRef.update(state, (current) => {
      if (current.hosts.get(clientId)?.connectionId !== connectionId) return current;
      const hosts = new Map(current.hosts);
      hosts.delete(clientId);
      return { ...current, hosts };
    }).pipe(Effect.andThen(failHostRequests(connectionId)));

  const connect: CanvasHostBroker["Service"]["connect"] = (registration) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<CanvasHostStreamEvent, Cause.Done>();
          const connectionId = yield* secureRandom.uuidV4();
          yield* Queue.offer(queue, { type: "connected", connectionId });
          const [previous, closed] = yield* SynchronizedRef.modify(
            state,
            (current): readonly [readonly [Host | undefined, boolean], State] => {
              if (current.closed) return [[undefined, true], current] as const;
              const hosts = new Map(current.hosts);
              const previous = hosts.get(registration.clientId);
              hosts.set(registration.clientId, {
                clientId: registration.clientId,
                connectionId,
                queue,
                focused: false,
                mountedDocumentIds: new Set(),
                threadIds: new Set(),
                order: current.sequence + 1,
              });
              return [
                [previous, false],
                { ...current, hosts, sequence: current.sequence + 1 },
              ] as const;
            },
          );
          if (closed) yield* Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)));
          if (previous) {
            // The replaced generation's stream ends; its requests fail fast.
            yield* Queue.shutdown(previous.queue);
            yield* failHostRequests(previous.connectionId);
          }
          return { queue, connectionId };
        }),
        ({ queue, connectionId }) =>
          removeHost(registration.clientId, connectionId).pipe(
            Effect.andThen(Queue.shutdown(queue)),
          ),
      ).pipe(Effect.map(({ queue }) => Stream.fromQueue(queue))),
    );

  const update: CanvasHostBroker["Service"]["update"] = (input) =>
    SynchronizedRef.update(state, (current) => {
      const host = current.hosts.get(input.clientId);
      if (!host || host.connectionId !== input.connectionId) return current;
      const hosts = new Map(current.hosts);
      const sequence = input.focused && !host.focused ? current.sequence + 1 : current.sequence;
      hosts.set(input.clientId, {
        ...host,
        focused: input.focused,
        mountedDocumentIds: new Set(input.mountedDocumentIds),
        threadIds: new Set(input.threadIds),
        order: sequence === current.sequence ? host.order : sequence,
      });
      return { ...current, hosts, sequence };
    });

  const respond: CanvasHostBroker["Service"]["respond"] = Effect.fn("CanvasHostBroker.respond")(
    function* (response) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
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
      if (entry) yield* Deferred.succeed(entry.deferred, response);
    },
  );

  /** Offers one request to the best host and waits for its answer. */
  const request = Effect.fn("CanvasHostBroker.request")(function* (
    pick: (hosts: ReadonlyArray<Host>) => Host | undefined,
    unavailableReason: string,
    build: (requestId: string) => CanvasHostRequest,
  ) {
    const deferred = yield* Deferred.make<CanvasHostResponse, CanvasHostError>();
    const routed = yield* SynchronizedRef.modifyEffect(state, (current) => {
      const host = pick(
        Array.from(current.hosts.values()).sort(
          (left, right) => Number(right.focused) - Number(left.focused) || right.order - left.order,
        ),
      );
      if (!host) return Effect.succeed([undefined, current] as const);
      const requestId = `canvas-${current.sequence + 1}`;
      const request = build(requestId);
      const pending = new Map(current.pending);
      pending.set(requestId, {
        clientId: host.clientId,
        connectionId: host.connectionId,
        deferred,
      });
      return Queue.offer(host.queue, { type: "request", request }).pipe(
        Effect.map((offered) =>
          offered
            ? ([
                { requestId, requestType: request.type },
                { ...current, pending, sequence: current.sequence + 1 },
              ] as const)
            : ([undefined, current] as const),
        ),
      );
    });
    if (!routed) {
      return yield* new CanvasHostUnavailableError({ reason: unavailableReason });
    }
    const dropPending = SynchronizedRef.update(state, (current) => {
      if (!current.pending.has(routed.requestId)) return current;
      const pending = new Map(current.pending);
      pending.delete(routed.requestId);
      return { ...current, pending };
    });
    const response = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.ensuring(dropPending),
    );
    if (Option.isNone(response)) {
      return yield* new CanvasHostUnavailableError({
        reason: `The T3 Code client did not answer the canvas ${routed.requestType} request in time.`,
      });
    }
    if (!response.value.ok) {
      return yield* new CanvasHostRequestFailedError({
        requestType: routed.requestType,
        reason: response.value.error ?? "unknown error",
      });
    }
    return response.value;
  });

  const screenshot: CanvasHostBroker["Service"]["screenshot"] = (input) =>
    request(
      (hosts) => hosts.find((host) => host.mountedDocumentIds.has(input.documentId)),
      "No connected T3 Code client has this canvas open. Call canvas_open, then retry.",
      (requestId) => ({
        type: "screenshot",
        requestId,
        documentId: input.documentId,
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        scale: input.scale,
      }),
    ).pipe(
      Effect.flatMap((response) =>
        response.screenshot
          ? Effect.succeed(response.screenshot)
          : Effect.fail(
              new CanvasHostRequestFailedError({
                requestType: "screenshot",
                reason: "the client returned no image",
              }),
            ),
      ),
    );

  const open: CanvasHostBroker["Service"]["open"] = (input) =>
    request(
      (hosts) => hosts.find((host) => host.threadIds.has(input.threadId)) ?? hosts[0],
      "No T3 Code client that can show canvases is connected.",
      (requestId) => ({
        type: "open",
        requestId,
        threadId: input.threadId,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      }),
    ).pipe(Effect.asVoid);

  return CanvasHostBroker.of({ connect, update, respond, screenshot, open });
});

export const layer = Layer.effect(
  CanvasHostBroker,
  builtinService("t3.canvas", CanvasHostBroker.key, make, { lifecycle: true }),
);
