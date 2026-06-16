import {
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnavailableError,
  PreviewAutomationUnsupportedClientError,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationOwner,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "./McpInvocationContext.ts";

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface PreviewAutomationBrokerShape {
  readonly connect: (clientId: string) => Effect.Effect<Stream.Stream<PreviewAutomationRequest>>;
  readonly reportOwner: (
    owner: PreviewAutomationOwner,
  ) => Effect.Effect<void, PreviewAutomationError>;
  readonly clearOwner: (clientId: string) => Effect.Effect<void>;
  readonly respond: (
    response: PreviewAutomationResponse,
  ) => Effect.Effect<void, PreviewAutomationError>;
  readonly invoke: <A = unknown>(
    request: PreviewAutomationInvokeInput,
  ) => Effect.Effect<A, PreviewAutomationError>;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  PreviewAutomationBrokerShape
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly queue: Queue.Queue<
    Parameters<PreviewAutomationBrokerShape["respond"]>[0] extends never
      ? never
      : import("@t3tools/contracts").PreviewAutomationRequest
  >;
}

interface PendingRequest {
  readonly clientId: string;
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly owners: ReadonlyMap<string, PreviewAutomationOwner>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly requestSequence: number;
}

const makeResponseError = (
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  switch (error._tag) {
    case "PreviewAutomationNoFocusedOwnerError":
      return new PreviewAutomationNoFocusedOwnerError({ message: error.message });
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({ message: error.message });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({ message: error.message });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({ message: error.message });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({ message: error.message });
    case "PreviewAutomationInvalidSelectorError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      return new PreviewAutomationInvalidSelectorError({
        message: error.message,
        selector:
          detail && "selector" in detail && typeof detail.selector === "string"
            ? detail.selector
            : "",
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      return new PreviewAutomationResultTooLargeError({
        message: error.message,
        maximumBytes:
          detail && "maximumBytes" in detail && typeof detail.maximumBytes === "number"
            ? detail.maximumBytes
            : 64_000,
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationUnavailableError({ message: error.message });
    default:
      return new PreviewAutomationExecutionError({
        message: error.message,
        detail: error.detail,
      });
  }
};

const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    owners: new Map(),
    pending: new Map(),
    requestSequence: 0,
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const toFail = yield* SynchronizedRef.modify(state, (current) => {
      if (current.clients.get(clientId)?.queue !== queue) {
        return [[] as ReadonlyArray<PendingRequest>, current] as const;
      }
      const clients = new Map(current.clients);
      const owners = new Map(current.owners);
      const pending = new Map(current.pending);
      const disconnected: PendingRequest[] = [];
      clients.delete(clientId);
      owners.delete(clientId);
      for (const [requestId, entry] of pending) {
        if (entry.clientId === clientId) {
          pending.delete(requestId);
          disconnected.push(entry);
        }
      }
      return [disconnected, { ...current, clients, owners, pending }] as const;
    });
    yield* Effect.forEach(
      toFail,
      ({ deferred }) =>
        Deferred.fail(
          deferred,
          new PreviewAutomationUnavailableError({
            message: "The preview automation client disconnected.",
          }),
        ),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const connect: PreviewAutomationBrokerShape["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )(function* (clientId) {
    const queue = yield* Queue.unbounded<import("@t3tools/contracts").PreviewAutomationRequest>();
    const previous = yield* SynchronizedRef.modify(state, (current) => {
      const clients = new Map(current.clients);
      clients.set(clientId, { clientId, queue });
      return [current.clients.get(clientId), { ...current, clients }] as const;
    });
    if (previous) yield* disconnect(clientId, previous.queue);
    return Stream.fromQueue(queue).pipe(Stream.ensuring(disconnect(clientId, queue)));
  });

  const reportOwner: PreviewAutomationBrokerShape["reportOwner"] = Effect.fn(
    "PreviewAutomationBroker.reportOwner",
  )(function* (owner) {
    yield* SynchronizedRef.update(state, (current) => {
      const owners = new Map(current.owners);
      owners.set(owner.clientId, owner);
      return { ...current, owners };
    });
  });

  const clearOwner: PreviewAutomationBrokerShape["clearOwner"] = Effect.fn(
    "PreviewAutomationBroker.clearOwner",
  )(function* (clientId) {
    yield* SynchronizedRef.update(state, (current) => {
      const owners = new Map(current.owners);
      owners.delete(clientId);
      return { ...current, owners };
    });
  });

  const respond: PreviewAutomationBrokerShape["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (!entry) return [undefined, current] as const;
      const next = new Map(current.pending);
      next.delete(response.requestId);
      return [entry, { ...current, pending: next }] as const;
    });
    if (!pending) return;
    if (response.ok) {
      yield* Deferred.succeed(pending.deferred, response.result);
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? makeResponseError(response.error)
          : new PreviewAutomationExecutionError({
              message: "Preview automation failed without an error payload.",
            }),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBrokerShape["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const current = yield* SynchronizedRef.get(state);
    const candidates = Array.from(current.owners.values())
      .filter(
        (owner) =>
          owner.environmentId === input.scope.environmentId &&
          owner.threadId === input.scope.threadId &&
          owner.supportsAutomation,
      )
      .sort((left, right) => right.focusedAt.localeCompare(left.focusedAt));
    const owner = candidates[0];
    if (!owner) {
      return yield* new PreviewAutomationNoFocusedOwnerError({
        message: "No desktop browser host is available for this thread.",
      });
    }
    const connection = current.clients.get(owner.clientId);
    if (!connection) {
      return yield* new PreviewAutomationUnavailableError({
        message: "The browser host is not connected.",
      });
    }
    if (
      input.operation !== "open" &&
      input.operation !== "status" &&
      !owner.tabId &&
      !input.tabId
    ) {
      return yield* new PreviewAutomationTabNotFoundError({
        message: "The browser host does not have an active tab.",
      });
    }
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const requestId = yield* SynchronizedRef.modify(state, (next) => {
      const requestId = `preview-${next.requestSequence}`;
      const pending = new Map(next.pending);
      pending.set(requestId, { clientId: owner.clientId, deferred });
      return [requestId, { ...next, pending, requestSequence: next.requestSequence + 1 }] as const;
    });
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        requestId,
        threadId: input.scope.threadId,
        tabId: input.tabId ?? owner.tabId ?? undefined,
        operation: input.operation,
        input: input.input,
        timeoutMs,
      });
      if (!offered) {
        return yield* new PreviewAutomationUnavailableError({
          message: "The preview automation client is no longer accepting requests.",
        });
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      return yield* Option.match(result, {
        onNone: () =>
          Effect.fail(
            new PreviewAutomationTimeoutError({
              message: `Preview automation timed out after ${timeoutMs}ms.`,
            }),
          ),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    return yield* awaitResponse().pipe(Effect.ensuring(removePending));
  });

  return PreviewAutomationBroker.of({ connect, reportOwner, clearOwner, respond, invoke });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);

/** Exposed for tests. */
export const __testing = {
  make,
};
