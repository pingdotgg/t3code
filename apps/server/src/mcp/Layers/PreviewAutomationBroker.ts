import {
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnavailableError,
  PreviewAutomationUnsupportedClientError,
  type PreviewAutomationError,
  type PreviewAutomationOwner,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  PreviewAutomationBroker,
  type PreviewAutomationBrokerShape,
} from "../Services/PreviewAutomationBroker.ts";

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

export const makePreviewAutomationBroker = (): PreviewAutomationBrokerShape => {
  const state = Effect.runSync(
    Ref.make<BrokerState>({
      clients: new Map(),
      owners: new Map(),
      pending: new Map(),
    }),
  );
  let requestSequence = 0;

  const disconnect = (clientId: string, queue: ClientConnection["queue"]) =>
    Effect.gen(function* () {
      const toFail: PendingRequest[] = [];
      yield* Ref.update(state, (current) => {
        if (current.clients.get(clientId)?.queue !== queue) return current;
        const clients = new Map(current.clients);
        const owners = new Map(current.owners);
        const pending = new Map(current.pending);
        clients.delete(clientId);
        owners.delete(clientId);
        for (const [requestId, entry] of pending) {
          if (entry.clientId === clientId) {
            pending.delete(requestId);
            toFail.push(entry);
          }
        }
        return { clients, owners, pending };
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

  const connect: PreviewAutomationBrokerShape["connect"] = (clientId) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<import("@t3tools/contracts").PreviewAutomationRequest>();
      let previous: ClientConnection | undefined;
      yield* Ref.update(state, (current) => {
        previous = current.clients.get(clientId);
        const clients = new Map(current.clients);
        clients.set(clientId, { clientId, queue });
        return { ...current, clients };
      });
      if (previous) yield* disconnect(clientId, previous.queue);
      return Stream.fromQueue(queue).pipe(Stream.ensuring(disconnect(clientId, queue)));
    });

  const reportOwner: PreviewAutomationBrokerShape["reportOwner"] = (owner) =>
    Ref.update(state, (current) => {
      const owners = new Map(current.owners);
      owners.set(owner.clientId, owner);
      return { ...current, owners };
    });

  const clearOwner: PreviewAutomationBrokerShape["clearOwner"] = (clientId) =>
    Ref.update(state, (current) => {
      const owners = new Map(current.owners);
      owners.delete(clientId);
      return { ...current, owners };
    });

  const respond: PreviewAutomationBrokerShape["respond"] = (response) =>
    Effect.gen(function* () {
      let pending: PendingRequest | undefined;
      yield* Ref.update(state, (current) => {
        pending = current.pending.get(response.requestId);
        if (!pending) return current;
        const next = new Map(current.pending);
        next.delete(response.requestId);
        return { ...current, pending: next };
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

  const invoke = <A = unknown>(
    input: Parameters<PreviewAutomationBrokerShape["invoke"]>[0],
  ): Effect.Effect<A, PreviewAutomationError> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const candidates = Array.from(current.owners.values())
        .filter(
          (owner) =>
            owner.environmentId === input.scope.environmentId &&
            owner.threadId === input.scope.threadId &&
            owner.supportsAutomation &&
            (input.operation === "open" || input.operation === "status" || owner.visible),
        )
        .sort((left, right) => right.focusedAt.localeCompare(left.focusedAt));
      const owner = candidates[0];
      if (!owner) {
        return yield* new PreviewAutomationNoFocusedOwnerError({
          message: "No focused desktop preview owner is available for this thread.",
        });
      }
      const connection = current.clients.get(owner.clientId);
      if (!connection) {
        return yield* new PreviewAutomationUnavailableError({
          message: "The focused preview owner is not connected.",
        });
      }
      if (
        input.operation !== "open" &&
        input.operation !== "status" &&
        !owner.tabId &&
        !input.tabId
      ) {
        return yield* new PreviewAutomationTabNotFoundError({
          message: "The focused preview owner does not have an active tab.",
        });
      }
      const requestId = `preview-${requestSequence++}`;
      const timeoutMs = input.timeoutMs ?? 15_000;
      const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
      yield* Ref.update(state, (next) => {
        const pending = new Map(next.pending);
        pending.set(requestId, { clientId: owner.clientId, deferred });
        return { ...next, pending };
      });
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
      yield* Ref.update(state, (next) => {
        const pending = new Map(next.pending);
        pending.delete(requestId);
        return { ...next, pending };
      });
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

  return PreviewAutomationBroker.of({ connect, reportOwner, clearOwner, respond, invoke });
};

export const previewAutomationBroker = makePreviewAutomationBroker();

export const PreviewAutomationBrokerLive: Layer.Layer<PreviewAutomationBroker> = Layer.succeed(
  PreviewAutomationBroker,
  previewAutomationBroker,
);
