import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationHostAssignmentConflictError,
  PreviewAutomationHostUnavailableError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type PreviewAutomationError,
  type PreviewAutomationAvailableHost,
  type PreviewAutomationHostList,
  type PreviewAutomationHostSelection,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "./McpInvocationContext.ts";

export const DEFAULT_PREVIEW_AUTOMATION_TIMEOUT_MS = 15_000;

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
  /** Background metadata reads must not change the agent's current tab. */
  readonly updateCurrentTab?: boolean;
  /** Capture the routed tab before another request changes the current assignment. */
  readonly onTargetTab?: (tabId: PreviewTabId | undefined) => void;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly listHosts: (
      scope: McpInvocationContext.McpInvocationScope,
    ) => Effect.Effect<PreviewAutomationHostList>;
    readonly selectHost: (
      scope: McpInvocationContext.McpInvocationScope,
      hostId: string,
    ) => Effect.Effect<
      PreviewAutomationHostSelection,
      PreviewAutomationHostUnavailableError | PreviewAutomationHostAssignmentConflictError
    >;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("t3/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly hostId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly label: string;
  readonly platform: PreviewAutomationAvailableHost["platform"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent, Cause.Done>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  readonly context: PreviewAutomationRequestErrorContext;
}

/**
 * A lease pinning one provider session to one desktop runtime. Implicit leases
 * live as long as their connection. Explicit leases retain the stable physical
 * host id across transport replacement and fail closed while that host is
 * disconnected. Neither lease has a clock of its own because credential expiry
 * is unrelated to desktop and tab identity.
 */
interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly hostId: ClientConnection["hostId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly environmentId: ClientConnection["environmentId"];
  readonly queue: ClientConnection["queue"];
  readonly selection: "implicit" | "explicit";
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
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

type HostSelectionOutcome =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Conflict"; readonly assignedHostId: string }
  | { readonly _tag: "Selected"; readonly host: PreviewAutomationAvailableHost };

type HostRouteOutcome =
  | { readonly _tag: "NoRoute" }
  | { readonly _tag: "SelectedUnavailable"; readonly hostId: string }
  | {
      readonly _tag: "Route";
      readonly connection: ClientConnection;
      readonly requestId: string;
      readonly requestContext: PreviewAutomationRequestErrorContext;
      readonly requestSequence: number;
    };

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
    if (assignment.queue === queue && assignment.selection === "implicit") {
      assignments.delete(assignmentKey);
    }
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

const availableHost = (connection: ClientConnection): PreviewAutomationAvailableHost => ({
  hostId: connection.hostId,
  label: connection.label,
  platform: connection.platform,
  supportedOperations: [...connection.supportedOperations],
  focused: connection.focused,
});

const normalizeAssignments = (current: BrokerState): ReadonlyMap<string, HostAssignment> => {
  const assignments = new Map<string, HostAssignment>();
  for (const [assignmentKey, assignment] of current.assignments) {
    const connection = Array.from(current.clients.values()).find(
      (candidate) =>
        candidate.hostId === assignment.hostId &&
        candidate.environmentId === assignment.environmentId,
    );
    if (connection) {
      assignments.set(assignmentKey, {
        ...assignment,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        queue: connection.queue,
      });
    } else if (assignment.selection === "explicit") {
      assignments.set(assignmentKey, assignment);
    }
  }
  return assignments;
};

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
    case "PreviewAutomationRecordingDesktopUpdateRequiredError":
      return new PreviewAutomationRecordingDesktopUpdateRequiredError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingTooLargeError":
      return new PreviewAutomationRecordingTooLargeError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingDeadlineExpiredError":
      return new PreviewAutomationRecordingDeadlineExpiredError({
        threadId: context.threadId,
        cause: error,
      });
    case "PreviewAutomationRecordingTransferError":
      return new PreviewAutomationRecordingTransferError({
        threadId: context.threadId,
        cause: error,
      });
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
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    pending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
    completeStream = false,
  ) {
    if (completeStream) {
      // Discard this generation's commands and complete the RPC stream so a
      // responsive desktop can re-register after a timeout eviction.
      yield* Queue.clear(queue);
      yield* Queue.end(queue);
    } else {
      // Replaced registrations must not reconnect and displace their successor.
      yield* Queue.shutdown(queue);
    }
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
    completeStream = false,
  ) {
    yield* SynchronizedRef.modifyEffect(state, (current) => {
      // Retired generations were already closed by their replacement or eviction.
      if (current.clients.get(clientId)?.queue !== queue) {
        return Effect.succeed([undefined, current] as const);
      }
      const removed = removeConnectionFromState(current, clientId, queue);
      return closeConnection(queue, removed.disconnected, completeStream).pipe(
        Effect.as([undefined, removed.state] as const),
      );
    });
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent, Cause.Done>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      hostId: host.hostId ?? clientId,
      connectionId,
      environmentId: host.environmentId,
      label: host.label ?? `Preview host ${clientId.slice(-8)}`,
      platform: host.platform ?? "unknown",
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = Array.from(current.clients.values()).find(
        (candidate) =>
          candidate.hostId === connection.hostId &&
          candidate.environmentId === connection.environmentId,
      );
      const removed = previousConnection
        ? removeConnectionFromState(current, previousConnection.clientId, previousConnection.queue)
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

  const listHosts: PreviewAutomationBroker["Service"]["listHosts"] = Effect.fn(
    "PreviewAutomationBroker.listHosts",
  )(function* (scope) {
    return yield* SynchronizedRef.modify(state, (current) => {
      const assignments = normalizeAssignments(current);
      const assignment = assignments.get(hostAssignmentKey(scope));
      const hosts = Array.from(current.clients.values())
        .filter((host) => host.environmentId === scope.environmentId)
        .sort(
          (left, right) =>
            left.label.localeCompare(right.label) || left.hostId.localeCompare(right.hostId),
        )
        .map(availableHost);
      return [
        {
          hosts,
          assignedHostId: assignment?.hostId ?? null,
        },
        { ...current, assignments },
      ] as const;
    });
  });

  const selectHost: PreviewAutomationBroker["Service"]["selectHost"] = Effect.fn(
    "PreviewAutomationBroker.selectHost",
  )(function* (scope, hostId) {
    const outcome = yield* SynchronizedRef.modify(
      state,
      (current): readonly [HostSelectionOutcome, BrokerState] => {
        const assignments = new Map(normalizeAssignments(current));
        const assignmentKey = hostAssignmentKey(scope);
        const assigned = assignments.get(assignmentKey);
        const assignedConnection = assigned
          ? Array.from(current.clients.values()).find(
              (candidate) =>
                candidate.hostId === assigned.hostId &&
                candidate.environmentId === scope.environmentId,
            )
          : undefined;
        const requested = Array.from(current.clients.values()).find(
          (candidate) =>
            candidate.hostId === hostId && candidate.environmentId === scope.environmentId,
        );
        if (!requested) {
          return [{ _tag: "Unavailable" as const }, { ...current, assignments }] as const;
        }
        if (
          assigned &&
          assigned.hostId !== hostId &&
          (assigned.selection === "explicit" || assignedConnection !== undefined)
        ) {
          return [
            { _tag: "Conflict" as const, assignedHostId: assigned.hostId },
            { ...current, assignments },
          ] as const;
        }
        assignments.set(assignmentKey, {
          clientId: requested.clientId,
          hostId: requested.hostId,
          connectionId: requested.connectionId,
          environmentId: requested.environmentId,
          queue: requested.queue,
          selection: "explicit",
          ...(assigned?.hostId === requested.hostId && assigned.tabId !== undefined
            ? { tabId: assigned.tabId }
            : {}),
          ...(assigned?.hostId === requested.hostId && assigned.tabSequence !== undefined
            ? { tabSequence: assigned.tabSequence }
            : {}),
        });
        return [
          { _tag: "Selected" as const, host: availableHost(requested) },
          { ...current, assignments },
        ] as const;
      },
    );
    if (outcome._tag === "Unavailable") {
      return yield* new PreviewAutomationHostUnavailableError({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        hostId,
      });
    }
    if (outcome._tag === "Conflict") {
      return yield* new PreviewAutomationHostAssignmentConflictError({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        requestedHostId: hostId,
        assignedHostId: outcome.assignedHostId,
      });
    }
    return { host: outcome.host };
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

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_PREVIEW_AUTOMATION_TIMEOUT_MS;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const route = yield* SynchronizedRef.modify(
      state,
      (current): readonly [HostRouteOutcome, BrokerState] => {
        const assignments = new Map(normalizeAssignments(current));
        const assignmentKey = hostAssignmentKey(input.scope);
        const assigned = assignments.get(assignmentKey);
        const assignedConnection = assigned
          ? Array.from(current.clients.values()).find(
              (candidate) =>
                candidate.hostId === assigned.hostId &&
                candidate.environmentId === input.scope.environmentId,
            )
          : undefined;
        const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
        // Keep one provider session on one physical desktop runtime so a
        // multi-step browser interaction cannot jump between independent
        // Electron cookie/DOM state. A live assignment that predates an
        // operation is not silently moved to a newer client: the caller gets a
        // capability failure and can deliberately start a fresh provider
        // session. An implicit dead lease is pruned above and may fail over. An
        // explicit lease keeps its stable host id and fails closed until that
        // physical renderer reconnects or the caller starts a new session.
        const connection =
          assigned?.selection === "explicit"
            ? hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
              ? assignedConnection
              : undefined
            : hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
              ? assignedConnection
              : hasLiveAssignment
                ? undefined
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
          if (!hasLiveAssignment && assigned?.selection !== "explicit") {
            assignments.delete(assignmentKey);
          }
          return [
            assigned?.selection === "explicit"
              ? { _tag: "SelectedUnavailable" as const, hostId: assigned.hostId }
              : { _tag: "NoRoute" as const },
            { ...current, assignments },
          ] as const;
        }
        const canReuseAssignedTab =
          assigned !== undefined &&
          assigned.connectionId === connection.connectionId &&
          assigned.queue === connection.queue;
        assignments.set(assignmentKey, {
          clientId: connection.clientId,
          hostId: connection.hostId,
          connectionId: connection.connectionId,
          environmentId: connection.environmentId,
          queue: connection.queue,
          selection: assigned?.selection ?? "implicit",
          ...(canReuseAssignedTab && assigned.tabId !== undefined ? { tabId: assigned.tabId } : {}),
          ...(canReuseAssignedTab && assigned.tabSequence !== undefined
            ? { tabSequence: assigned.tabSequence }
            : {}),
        });

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
            _tag: "Route" as const,
            connection,
            requestId,
            requestContext: context,
            requestSequence,
          },
          { ...current, assignments, pending, requestSequence: current.requestSequence + 1 },
        ] as const;
      },
    );
    if (route._tag === "SelectedUnavailable") {
      return yield* new PreviewAutomationHostUnavailableError({
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        hostId: route.hostId,
        operation: input.operation,
      });
    }
    if (route._tag === "NoRoute") {
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
      });
    }
    const { connection, requestId, requestContext, requestSequence } = route;
    input.onTargetTab?.(requestContext.tabId);
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* SynchronizedRef.modifyEffect(state, (current) => {
        // A route can outlive its generation while another request evicts it.
        // Serialize the live-generation check and offer with queue closure.
        if (
          current.clients.get(connection.clientId)?.queue !== connection.queue ||
          !current.pending.has(requestId)
        ) {
          return Effect.succeed([false, current] as const);
        }
        return Queue.offer(connection.queue, {
          type: "request",
          connectionId: connection.connectionId,
          request: {
            requestId,
            threadId: input.scope.threadId,
            tabId: requestContext.tabId,
            tabIdExplicit: input.tabId !== undefined,
            operation: input.operation,
            input: input.input,
            timeoutMs,
          },
        }).pipe(Effect.map((offered) => [offered, current] as const));
      });
      if (!offered) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) {
          return (yield* completion.value) as A;
        }
        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      return yield* Option.match(result, {
        onNone: () =>
          Effect.gen(function* () {
            // An unanswered request invalidates this connection. Do not replay
            // actions: the client may have applied them before becoming unreachable.
            yield* disconnect(connection.clientId, connection.queue, true);
            return yield* new PreviewAutomationTimeoutError(requestContext);
          }),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
    if (input.updateCurrentTab === false) return result;
    const responseTabId = readResultTabId(result);
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

  return PreviewAutomationBroker.of({ connect, focusHost, listHosts, selectHost, respond, invoke });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);
