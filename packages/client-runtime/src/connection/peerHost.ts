import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  PeerEnvironmentFailureCode,
  type PeerEnvironmentOperation,
  type PeerEnvironmentRequest,
  type PeerEnvironmentResult,
  type PeerEnvironmentStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentRpc from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { SupervisorConnectionState } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";

class PeerRequestFailure extends Schema.TaggedError<PeerRequestFailure>()("PeerRequestFailure", {
  code: PeerEnvironmentFailureCode,
  message: Schema.String,
}) {}

const isPeerRequestFailure = Schema.is(PeerRequestFailure);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isRpcUnavailableError = Schema.is(EnvironmentRpc.EnvironmentRpcUnavailableError);
const isNotRegisteredError = Schema.is(EnvironmentRegistry.EnvironmentNotRegisteredError);

const failure = (code: PeerEnvironmentFailureCode, message: string) =>
  new PeerRequestFailure({ code, message });

/** How an agent on another environment should read this client's connection to a peer. */
export function peerEnvironmentStatus(
  entry: Pick<ConnectionCatalogEntry, "unsupportedReason">,
  state: Pick<SupervisorConnectionState, "phase" | "lastFailure">,
): PeerEnvironmentStatus {
  if (state.phase === "connected") return "connected";
  if (entry.unsupportedReason !== undefined) return "incompatible";
  if (state.phase !== "blocked") return "offline";
  switch (state.lastFailure?.reason) {
    case "unsupported":
      return "incompatible";
    case "authentication":
    case "permission":
      return "unauthorized";
    default:
      return "offline";
  }
}

const STATUS_FAILURES = {
  offline: ["environment_offline", "is offline or still connecting"],
  unauthorized: ["environment_unauthorized", "refused this app's access"],
  incompatible: [
    "environment_incompatible",
    "runs an incompatible T3 Code version and must be updated",
  ],
} as const;

const describeError = (error: object) =>
  "message" in error && typeof error.message === "string" ? error.message : "The request failed.";

/**
 * Runs one request from `hostEnvironmentId`'s server against another
 * environment, over this client's own session there. The target enforces this
 * client's permissions; nothing here widens them.
 */
export const executePeerEnvironmentOperation = Effect.fn(
  "clientRuntime.connection.executePeerEnvironmentOperation",
)(function* (input: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly operation: PeerEnvironmentOperation;
  readonly timeoutMs: number;
}): Effect.fn.Return<
  PeerEnvironmentResult,
  PeerRequestFailure,
  EnvironmentRegistry.EnvironmentRegistry
> {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  const statusOf = (environmentId: EnvironmentId, entry: ConnectionCatalogEntry) =>
    registry.state(environmentId).pipe(
      Effect.map((state) => peerEnvironmentStatus(entry, state)),
      Effect.orElseSucceed((): PeerEnvironmentStatus => "offline"),
    );
  const operation = input.operation;
  if (operation.operation === "list") {
    const environments = yield* Effect.forEach(
      Array.from(entries).filter(([environmentId]) => environmentId !== input.hostEnvironmentId),
      ([environmentId, entry]) =>
        statusOf(environmentId, entry).pipe(
          Effect.map((status) => ({ environmentId, label: entry.target.label, status })),
        ),
    );
    return { operation: "list", environments };
  }

  const environmentId = operation.environmentId;
  const entry = entries.get(environmentId);
  if (entry === undefined || environmentId === input.hostEnvironmentId) {
    return yield* failure(
      "environment_not_connected",
      `Environment ${environmentId} is not one of this app's other connected environments.`,
    );
  }
  const status = yield* statusOf(environmentId, entry);
  if (status !== "connected") {
    const [code, reason] = STATUS_FAILURES[status];
    return yield* failure(code, `${entry.target.label} ${reason}.`);
  }

  const request = Effect.gen(function* () {
    switch (operation.operation) {
      case "catalog": {
        const config = yield* EnvironmentRpc.request(WS_METHODS.serverGetConfig, {});
        const shell = yield* EnvironmentRpc.subscribe(
          ORCHESTRATION_V2_WS_METHODS.subscribeShell,
          {},
        ).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
        );
        return {
          operation: "catalog" as const,
          label: config.environment.label,
          serverVersion: config.environment.serverVersion,
          providers: config.providers,
          projects: Option.match(shell, {
            onNone: () => [],
            onSome: (item) => item.snapshot.projects,
          }),
        };
      }
      case "launch":
        return {
          operation: "launch" as const,
          result: yield* EnvironmentRpc.request(
            ORCHESTRATION_V2_WS_METHODS.launchThread,
            operation.input,
          ),
        };
      case "thread_projection":
        return {
          operation: "thread_projection" as const,
          projection: yield* EnvironmentRpc.request(
            ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
            { threadId: operation.threadId },
          ),
        };
    }
  });

  return yield* registry.run(environmentId, request).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          failure("environment_request_failed", `${entry.target.label} did not answer in time.`),
        ),
    }),
    Effect.mapError((error) => {
      if (isPeerRequestFailure(error)) return error;
      if (isAuthorizationError(error)) {
        return failure(
          "environment_unauthorized",
          `${entry.target.label} refused the request: ${describeError(error)}`,
        );
      }
      if (
        EnvironmentRpc.isRpcClientError(error) ||
        isRpcUnavailableError(error) ||
        isNotRegisteredError(error)
      ) {
        return failure("environment_offline", `${entry.target.label} is not reachable.`);
      }
      return failure(
        "environment_request_failed",
        `${entry.target.label} rejected the request: ${describeError(error)}`,
      );
    }),
  );
});

/**
 * Offers this client to one environment's server as a carrier for its agents'
 * requests to the client's other environments, on each session whose server
 * supports it.
 */
const servePeerRequests = (hostEnvironmentId: EnvironmentId, clientId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const answer = (session: RpcSession, connectionId: string, request: PeerEnvironmentRequest) =>
        executePeerEnvironmentOperation({
          hostEnvironmentId,
          operation: request.operation,
          timeoutMs: request.timeoutMs,
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
          Effect.match({
            onSuccess: (result) => ({ ok: true as const, result }),
            onFailure: (error) => ({
              ok: false as const,
              code: error.code,
              message: error.message,
            }),
          }),
          Effect.flatMap((outcome) =>
            session.client[WS_METHODS.peerEnvironmentsRespond]({
              clientId,
              connectionId,
              requestId: request.requestId,
              outcome,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not answer a peer environment request.", {
              hostEnvironmentId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config) =>
                    config.environment.capabilities.peerEnvironments === true
                      ? session.client[WS_METHODS.peerEnvironmentsConnect]({ clientId }).pipe(
                          // The server completes the stream to evict a silent
                          // client; a live one registers again.
                          Stream.repeat(Schedule.spaced("1 second")),
                          Stream.mapEffect(
                            (event) =>
                              event.type === "request"
                                ? answer(session, event.connectionId, event.request)
                                : Effect.void,
                            { concurrency: 8, unordered: true },
                          ),
                        )
                      : Stream.empty,
                  ),
                ),
                // A failed stream waits for the next session like any other subscription.
              ).pipe(Stream.catchCause(() => Stream.empty)),
          }),
        ),
      );
    }),
  );

/** Keeps this client registered as a peer carrier with every saved environment. */
export const runPeerEnvironmentHost = Effect.fn("clientRuntime.connection.runPeerEnvironmentHost")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const clientId = `peer-${(yield* Random.nextInt).toString(36)}-${(yield* Random.nextInt).toString(36)}`;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Array.from(entries.keys()).sort().join("\n")),
      Stream.changes,
      Stream.switchMap((key) =>
        Stream.mergeAll(
          (key === "" ? [] : (key.split("\n") as Array<EnvironmentId>)).map((environmentId) =>
            registry.followStream(
              environmentId,
              servePeerRequests(environmentId, clientId).pipe(
                Stream.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ),
      Stream.runDrain,
    );
  },
);
