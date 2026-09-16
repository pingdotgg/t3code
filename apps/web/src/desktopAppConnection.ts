import {
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcStreamFailure,
  EnvironmentRpcUnavailableError,
  request,
  subscribe,
} from "@t3tools/client-runtime/rpc";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import {
  type DesktopAppConnectionEnvironment,
  type DesktopAppConnectionEnvironmentStatus,
  type DesktopAppConnectionErrorCode,
  type DesktopAppConnectionProvider,
  type DesktopAppConnectionRequest,
  type DesktopAppConnectionResponse,
  type DesktopAppConnectionResult,
  ORCHESTRATION_WS_METHODS,
  type ThreadId,
  type ServerProvider,
  WS_METHODS,
  desktopAppConnectionFailure as failure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Below the main-process deadline so the socket sees a typed failure instead
// of a bare timeout when a remote environment stalls.
const OPERATION_TIMEOUT_MS = 25_000;

function connectionStatus(phase: string): DesktopAppConnectionEnvironmentStatus {
  return phase === "connected"
    ? "connected"
    : phase === "connecting"
      ? "connecting"
      : "disconnected";
}

/** Keeps only presentation fields; `config`, environment, and auth details never leave the renderer. */
export function sanitizeProvider(provider: ServerProvider): DesktopAppConnectionProvider {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName !== undefined ? { displayName: provider.displayName } : {}),
    installed: provider.installed,
    enabled: provider.enabled,
    status: provider.status,
    authStatus: provider.auth.status,
    models: provider.models,
  };
}

const listEnvironments = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  const environments: DesktopAppConnectionEnvironment[] = [];
  for (const [id, entry] of entries) {
    const state = yield* registry.state(id).pipe(Effect.option);
    environments.push({
      id,
      label: entry.target.label,
      status: Option.isSome(state) ? connectionStatus(state.value.phase) : "disconnected",
    });
  }
  return { environments };
});

const firstShellSnapshot = subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
  Stream.filter((item) => item.kind === "snapshot"),
  Stream.map((item) => item.snapshot),
  Stream.runHead,
  Effect.flatMap((snapshot) => Effect.fromOption(snapshot, () => new SubscriptionEndedError())),
);

class SubscriptionEndedError extends Data.TaggedError("SubscriptionEndedError") {}

/** Bridge-level failures that already know which wire error code they map to. */
class BridgeOperationError extends Data.TaggedError("BridgeOperationError")<{
  readonly code: "environment-unavailable" | "operation-failed";
  readonly message: string;
}> {}

interface ThreadWindowInput {
  readonly threadId: ThreadId;
  readonly turnLimit?: number | undefined;
}

// Pre-pagination servers reject a window, so `turnLimit` is only sent when the
// connected session advertised the capability.
const supportsThreadPagination = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return false;
  const config = yield* session.value.initialConfig.pipe(Effect.option);
  return Option.isSome(config) && config.value.threadSnapshotPagination === true;
});

function firstThreadSnapshot(input: ThreadWindowInput) {
  return Stream.unwrap(
    Effect.map(supportsThreadPagination, (paginated) =>
      subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, {
        threadId: input.threadId,
        ...(paginated && input.turnLimit !== undefined ? { turnLimit: input.turnLimit } : {}),
      }),
    ),
  ).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.map((item) => item.snapshot),
    Stream.runHead,
    Effect.flatMap((snapshot) => Effect.fromOption(snapshot, () => new SubscriptionEndedError())),
  );
}

/**
 * Older pages need `beforeCursor`, which only the HTTP detail endpoint accepts.
 * The loader reuses the supervisor's prepared connection, so SSH and relay
 * credentials stay inside the connection layer.
 */
function pagedThreadSnapshot(input: ThreadWindowInput & { readonly beforeCursor: string }) {
  return Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const loader = yield* ThreadSnapshotLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new BridgeOperationError({
        code: "environment-unavailable",
        message: `${supervisor.target.label} is not connected.`,
      });
    }
    if (!(yield* supportsThreadPagination)) {
      return yield* new BridgeOperationError({
        code: "operation-failed",
        message: "This environment does not support thread history pages.",
      });
    }
    const snapshot = yield* loader.load(prepared.value, input.threadId, {
      turnLimit: input.turnLimit ?? 10,
      beforeCursor: input.beforeCursor,
    });
    if (Option.isNone(snapshot)) {
      return yield* new BridgeOperationError({
        code: "operation-failed",
        message: "T3 Code could not load that page of the thread.",
      });
    }
    return snapshot.value;
  });
}

type OperationFailure =
  | BridgeOperationError
  | SubscriptionEndedError
  | EnvironmentRpcUnavailableError
  | EnvironmentRpcStreamFailure<typeof ORCHESTRATION_WS_METHODS.subscribeShell>
  | EnvironmentRpcStreamFailure<typeof ORCHESTRATION_WS_METHODS.subscribeThread>
  | EnvironmentRpcFailure<typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot>
  | EnvironmentRpcFailure<typeof WS_METHODS.serverGetConfig>
  | EnvironmentRpcFailure<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;

function operation(
  req: Exclude<DesktopAppConnectionRequest, { operation: "listEnvironments" }>,
): Effect.Effect<
  DesktopAppConnectionResult,
  OperationFailure,
  EnvironmentSupervisor | ThreadSnapshotLoader
> {
  switch (req.operation) {
    case "shell":
      return firstShellSnapshot;
    case "archived":
      return request(ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot, {});
    case "thread":
      return req.beforeCursor === undefined
        ? firstThreadSnapshot(req)
        : pagedThreadSnapshot({ ...req, beforeCursor: req.beforeCursor });
    case "providers":
      return request(WS_METHODS.serverGetConfig, {}).pipe(
        Effect.map((config) => ({ providers: config.providers.map(sanitizeProvider) })),
      );
    case "dispatch":
      return request(ORCHESTRATION_WS_METHODS.dispatchCommand, req.command);
  }
}

/**
 * Maps failures to wire codes. Only messages built here leave the renderer:
 * upstream errors can quote URLs, hosts, or auth details, so they contribute
 * their tag at most.
 */
function describeFailure(cause: Cause.Cause<unknown>): {
  readonly code: DesktopAppConnectionErrorCode;
  readonly message: string;
} {
  const error = Cause.squash(cause);
  if (error instanceof BridgeOperationError) return { code: error.code, message: error.message };
  if (error instanceof SubscriptionEndedError) {
    return {
      code: "operation-failed",
      message: "The environment closed the subscription before sending a snapshot.",
    };
  }
  const tag =
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : null;
  switch (tag) {
    case "TimeoutError":
      return { code: "request-timeout", message: "The environment did not answer in time." };
    case "EnvironmentNotRegisteredError":
      return { code: "environment-not-found", message: "Unknown environmentId." };
    case "EnvironmentRpcUnavailableError":
      return { code: "environment-unavailable", message: "The environment is not connected." };
    case "EnvironmentAuthorizationError":
      return {
        code: "operation-failed",
        message: "This connection is not allowed to perform that operation.",
      };
    case "OrchestrationDispatchCommandError":
      return { code: "operation-failed", message: "The environment rejected the command." };
    case null:
      return { code: "operation-failed", message: "The environment rejected the request." };
    default:
      return {
        code: "operation-failed",
        message: `The environment rejected the request (${tag}).`,
      };
  }
}

export function handleDesktopAppConnectionRequest(
  req: DesktopAppConnectionRequest,
): Effect.Effect<DesktopAppConnectionResponse, never, EnvironmentRegistry | ThreadSnapshotLoader> {
  const success = (result: DesktopAppConnectionResult): DesktopAppConnectionResponse => ({
    version: 1,
    requestId: req.requestId,
    ok: true,
    result,
  });
  const run: Effect.Effect<
    DesktopAppConnectionResult,
    OperationFailure | EnvironmentNotRegisteredError,
    EnvironmentRegistry | ThreadSnapshotLoader
  > =
    req.operation === "listEnvironments"
      ? listEnvironments
      : Effect.flatMap(EnvironmentRegistry, (registry) =>
          registry.run(req.environmentId, operation(req)),
        );
  return run.pipe(
    Effect.timeout(OPERATION_TIMEOUT_MS),
    Effect.map(success),
    Effect.catchCause((cause) => {
      const described = describeFailure(cause);
      return Effect.succeed(failure(req.requestId, described.code, described.message));
    }),
  );
}
