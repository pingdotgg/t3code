import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationPinnedHostUnsupportedOperationError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
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

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  readonly context: PreviewAutomationRequestErrorContext;
}

interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly queue: ClientConnection["queue"];
  readonly tabId?: PreviewTabId;
  readonly tabSequence?: number;
}

interface PreviewAutomationRequestErrorContext {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly providerSessionId: string;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly clientId: string;
  readonly connectionId: ClientConnection["connectionId"];
  readonly requestId: string;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs: number;
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
}

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly assignments: ReadonlyMap<string, HostAssignment>;
  readonly revokedProviderSessionIds: ReadonlySet<string>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

interface RoutedHostRequest {
  readonly kind: "routed";
  readonly connection: ClientConnection;
  readonly requestId: string;
  readonly requestContext: PreviewAutomationRequestErrorContext;
  readonly requestSequence: number;
}

interface PinnedHostUnsupportedOperation {
  readonly kind: "pinned-host-unsupported-operation";
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly supportedOperations: ReadonlyArray<PreviewAutomationOperation>;
}

interface NoRoutableHost {
  readonly kind: "no-routable-host";
}

type HostRoute = RoutedHostRequest | PinnedHostUnsupportedOperation | NoRoutableHost;

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];
  if (current.clients.get(clientId)?.queue === queue) clients.delete(clientId);
  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  return {
    state: { ...current, clients, assignments, pending },
    disconnected,
  };
};

const selectorDiagnosticsFromInput = (
  input: unknown,
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (typeof input !== "object" || input === null) return {};
  if ("locator" in input && typeof input.locator === "string") {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }
  if ("selector" in input && typeof input.selector === "string") {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }
  return {};
};

const hostAssignmentKey = (scope: McpInvocationContext.McpInvocationScope): string =>
  `${scope.environmentId}\u0000${scope.providerSessionId}`;

const MAX_REVOKED_PROVIDER_SESSION_TOMBSTONES = 4_096;

const isPreviewTabId = Schema.is(PreviewTabId);

const readResultTabId = (result: unknown): PreviewTabId | null | undefined => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return undefined;
  const tabId = result.tabId;
  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function remoteDetailKind(detail: unknown): RemoteDetailKind {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };
  switch (error._tag) {
    case "PreviewAutomationNoAvailableHostError":
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationInvalidSelectorError": {
      return new PreviewAutomationInvalidSelectorError({
        ...context,
        ...remoteDiagnostics,
      });
    }
    case "PreviewAutomationTargetNotEditableError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteSelectorKind =
        detail &&
        "selectorKind" in detail &&
        (detail.selectorKind === "focused-element" ||
          detail.selectorKind === "locator" ||
          detail.selectorKind === "selector")
          ? detail.selectorKind
          : undefined;
      const remoteSelectorLength =
        detail &&
        "selectorLength" in detail &&
        typeof detail.selectorLength === "number" &&
        Number.isInteger(detail.selectorLength) &&
        detail.selectorLength >= 0
          ? detail.selectorLength
          : undefined;
      return new PreviewAutomationTargetNotEditableError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteSelectorKind === undefined && context.selectorKind === undefined
          ? {}
          : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
        ...(remoteSelectorLength === undefined && context.selectorLength === undefined
          ? {}
          : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const maximumBytes =
        detail &&
        "maximumBytes" in detail &&
        typeof detail.maximumBytes === "number" &&
        Number.isInteger(detail.maximumBytes) &&
        detail.maximumBytes > 0
          ? detail.maximumBytes
          : undefined;
      return new PreviewAutomationResultTooLargeError({
        ...context,
        ...remoteDiagnostics,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    default:
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
      });
  }
};

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const hostRouteChanges = yield* PubSub.unbounded<void>();
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    revokedProviderSessionIds: new Set(),
    pending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);
      return [removed.disconnected, removed.state] as const;
    });
    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);
      const removed = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [] };
      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);
      return [
        {
          previousConnection,
          disconnected: removed.disconnected,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }
    yield* PubSub.publish(hostRouteChanges, undefined);
    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    yield* SynchronizedRef.update(state, (current) => {
      const currentHost = current.clients.get(host.clientId);
      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return current;
      }
      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
      });
      return { ...current, clients, focusSequence };
    });
  });

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
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
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const revokeProviderSession: PreviewAutomationBroker["Service"]["revokeProviderSession"] =
    Effect.fn("PreviewAutomationBroker.revokeProviderSession")(function* (providerSessionId) {
      yield* SynchronizedRef.update(state, (current) => {
        const assignments = new Map(current.assignments);
        for (const key of assignments.keys()) {
          if (key.endsWith(`\u0000${providerSessionId}`)) {
            assignments.delete(key);
          }
        }
        const revokedProviderSessionIds = new Set(current.revokedProviderSessionIds);
        revokedProviderSessionIds.delete(providerSessionId);
        revokedProviderSessionIds.add(providerSessionId);
        while (revokedProviderSessionIds.size > MAX_REVOKED_PROVIDER_SESSION_TOMBSTONES) {
          const oldest = revokedProviderSessionIds.values().next().value;
          if (oldest === undefined) break;
          revokedProviderSessionIds.delete(oldest);
        }
        return { ...current, assignments, revokedProviderSessionIds };
      });
    });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + timeoutMs;
    const selectHostRoute = Effect.fn("PreviewAutomationBroker.selectHostRoute")(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* SynchronizedRef.modify(state, (current): readonly [HostRoute, BrokerState] => {
        const assignments = new Map(
          Array.from(current.assignments).filter(([, assignment]) => {
            const connection = current.clients.get(assignment.clientId);
            return (
              connection?.connectionId === assignment.connectionId &&
              connection.queue === assignment.queue
            );
          }),
        );
        const assignmentKey = hostAssignmentKey(input.scope);
        const providerSessionRevoked = current.revokedProviderSessionIds.has(
          input.scope.providerSessionId,
        );
        const assigned = providerSessionRevoked ? undefined : assignments.get(assignmentKey);
        const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
        const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
        if (hasLiveAssignment && !supportsOperation(assignedConnection, input.operation)) {
          return [
            {
              kind: "pinned-host-unsupported-operation",
              clientId: assignedConnection.clientId,
              connectionId: assignedConnection.connectionId,
              supportedOperations: Array.from(assignedConnection.supportedOperations),
            } satisfies PinnedHostUnsupportedOperation,
            { ...current, assignments },
          ] as const;
        }
        if (now >= deadline) {
          return [
            { kind: "no-routable-host" } satisfies NoRoutableHost,
            { ...current, assignments },
          ] as const;
        }
        // Keep one provider session on one physical desktop runtime so a
        // multi-step browser interaction cannot jump between independent
        // Electron cookie/DOM state. Dead or expired assignments are pruned
        // above and may fail over to another live host.
        const connection = hasLiveAssignment
          ? assignedConnection
          : Array.from(current.clients.values())
              .filter(
                (host) =>
                  host.environmentId === input.scope.environmentId &&
                  supportsOperation(host, input.operation),
              )
              .sort(
                (left, right) =>
                  right.supportedOperations.size - left.supportedOperations.size ||
                  Number(right.focused) - Number(left.focused) ||
                  right.focusOrder - left.focusOrder,
              )[0];
        if (!connection) {
          if (!hasLiveAssignment) assignments.delete(assignmentKey);
          return [
            { kind: "no-routable-host" } satisfies NoRoutableHost,
            { ...current, assignments },
          ] as const;
        }
        const canReuseAssignedTab =
          assigned !== undefined &&
          assigned.connectionId === connection.connectionId &&
          assigned.queue === connection.queue;
        if (!providerSessionRevoked) {
          assignments.set(assignmentKey, {
            clientId: connection.clientId,
            connectionId: connection.connectionId,
            queue: connection.queue,
            ...(canReuseAssignedTab && assigned.tabId !== undefined
              ? { tabId: assigned.tabId }
              : {}),
            ...(canReuseAssignedTab && assigned.tabSequence !== undefined
              ? { tabSequence: assigned.tabSequence }
              : {}),
          });
        }

        const requestSequence = current.requestSequence;
        const requestId = `preview-${requestSequence}`;
        const tabId = input.tabId ?? (canReuseAssignedTab ? assigned.tabId : undefined);
        const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);
        const context: PreviewAutomationRequestErrorContext = {
          operation: input.operation,
          environmentId: input.scope.environmentId,
          threadId: input.scope.threadId,
          providerSessionId: input.scope.providerSessionId,
          providerInstanceId: input.scope.providerInstanceId,
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          requestId,
          ...(tabId === undefined ? {} : { tabId }),
          timeoutMs,
          ...selectorDiagnostics,
        };
        const pending = new Map(current.pending);
        pending.set(requestId, { queue: connection.queue, deferred, context });
        return [
          {
            kind: "routed",
            connection,
            requestId,
            requestContext: context,
            requestSequence,
          } satisfies RoutedHostRequest,
          { ...current, assignments, pending, requestSequence: current.requestSequence + 1 },
        ] as const;
      });
    });
    // Distinguishes "nothing is connected to this environment" from "a client is
    // connected but cannot automate" (a browser-served UI registers with zero
    // supported operations), so the caller gets an actionable remediation.
    const noAvailableHostError = Effect.fn("PreviewAutomationBroker.noAvailableHostError")(
      function* () {
        const current = yield* SynchronizedRef.get(state);
        return new PreviewAutomationNoAvailableHostError({
          operation: input.operation,
          environmentId: input.scope.environmentId,
          threadId: input.scope.threadId,
          providerSessionId: input.scope.providerSessionId,
          providerInstanceId: input.scope.providerInstanceId,
          timeoutMs,
          environmentHasConnectedClients: Array.from(current.clients.values()).some(
            (host) => host.environmentId === input.scope.environmentId,
          ),
        });
      },
    );
    const route = yield* Effect.scoped(
      Effect.gen(function* () {
        const registration = yield* PubSub.subscribe(hostRouteChanges);
        while (true) {
          const selected = yield* selectHostRoute();
          if (selected.kind === "pinned-host-unsupported-operation") {
            return yield* new PreviewAutomationPinnedHostUnsupportedOperationError({
              operation: input.operation,
              environmentId: input.scope.environmentId,
              threadId: input.scope.threadId,
              providerSessionId: input.scope.providerSessionId,
              providerInstanceId: input.scope.providerInstanceId,
              clientId: selected.clientId,
              connectionId: selected.connectionId,
              supportedOperations: selected.supportedOperations,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          const remainingTimeoutMs = deadline - now;
          if (selected.kind === "routed" && remainingTimeoutMs > 0) {
            return { route: selected, remainingTimeoutMs };
          }
          if (remainingTimeoutMs <= 0) {
            if (selected.kind === "routed") {
              yield* SynchronizedRef.update(state, (current) => {
                if (!current.pending.has(selected.requestId)) return current;
                const pending = new Map(current.pending);
                pending.delete(selected.requestId);
                return { ...current, pending };
              });
            }
            return yield* yield* noAvailableHostError();
          }
          const registered = yield* PubSub.take(registration).pipe(
            Effect.timeoutOption(remainingTimeoutMs),
          );
          if (Option.isNone(registered)) return yield* yield* noAvailableHostError();
        }
      }),
    );
    // Routing can create a pin. Wake concurrent waiters so one that is now
    // blocked behind an incapable pin fails fast instead of burning its budget.
    yield* PubSub.publish(hostRouteChanges, undefined);
    const { connection, requestId, requestContext, requestSequence } = route.route;
    const requestTimeoutMs = route.remainingTimeoutMs;
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        type: "request",
        connectionId: connection.connectionId,
        request: {
          requestId,
          threadId: input.scope.threadId,
          tabId: requestContext.tabId,
          tabIdExplicit: input.tabId !== undefined,
          operation: input.operation,
          input: input.input,
          timeoutMs: requestTimeoutMs,
        },
      });
      if (!offered) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) {
          return (yield* completion.value) as A;
        }
        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(requestTimeoutMs));
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
    // A stop artifact identifies the globally recorded tab, not the caller's browsing target.
    const responseTabId = input.operation === "recordingStop" ? undefined : readResultTabId(result);
    const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;
    if (resultTabId === undefined) return result;
    const assignmentKey = hostAssignmentKey(input.scope);
    yield* SynchronizedRef.update(state, (current) => {
      const assignment = current.assignments.get(assignmentKey);
      if (
        !assignment ||
        assignment.connectionId !== connection.connectionId ||
        assignment.queue !== connection.queue ||
        (assignment.tabSequence ?? -1) > requestSequence
      ) {
        return current;
      }
      const assignments = new Map(current.assignments);
      if (resultTabId === null) {
        const { tabId: _tabId, ...withoutTabId } = assignment;
        assignments.set(assignmentKey, { ...withoutTabId, tabSequence: requestSequence });
      } else {
        assignments.set(assignmentKey, {
          ...assignment,
          ...(resultTabId === undefined ? {} : { tabId: resultTabId }),
          tabSequence: requestSequence,
        });
      }
      return { ...current, assignments };
    });
    return result;
  });

  return PreviewAutomationBroker.of({
    connect,
    focusHost,
    respond,
    revokeProviderSession,
    invoke,
  });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

let activePreviewAutomationBroker: PreviewAutomationBroker["Service"] | undefined;

const managedMake = Effect.acquireRelease(
  make.pipe(
    Effect.tap((broker) =>
      Effect.sync(() => {
        activePreviewAutomationBroker = broker;
      }),
    ),
  ),
  (broker) =>
    Effect.sync(() => {
      if (activePreviewAutomationBroker === broker) {
        activePreviewAutomationBroker = undefined;
      }
    }),
);

export const revokeActivePreviewAutomationProviderSession = (
  providerSessionId: string,
): Effect.Effect<void> =>
  activePreviewAutomationBroker
    ? activePreviewAutomationBroker.revokeProviderSession(providerSessionId)
    : Effect.void;

export const layer = Layer.effect(PreviewAutomationBroker, managedMake);
