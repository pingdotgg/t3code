// @ts-nocheck
import { createHash } from "node:crypto";

import {
  AuthBootstrapInput,
  type AuthBearerBootstrapResult,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
  type ClientOrchestrationCommand,
  MOBILE_HTTP_PREFIX,
  MOBILE_PROTOCOL_VERSION,
  MOBILE_V1_SERVER_CAPABILITIES,
  MOBILE_WS_PATH,
  type MobileAuthBearerBootstrapResult,
  type MobileAuthSessionResult,
  type MobileAuthWebSocketTokenResult,
  type MobileClientCapability,
  type MobileClientOrchestrationCommand,
  type MobileCommandReceipt,
  MobileClientMessage,
  type MobileDescriptorResult,
  type MobileErrorCode,
  type MobileErrorMessage,
  type MobileHelloResponse,
  type MobileReplayEnvelope,
  type MobileRequestMessage,
  type MobileResponseMessage,
  MobileServerMessage,
  type MobileStreamMessage,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { deriveAuthClientMetadata } from "./auth/utils.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { dispatchThroughStartupGate } from "./orchestration/gatedDispatch.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { isThreadDetailEvent } from "./orchestration/threadDetailEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

const MOBILE_COMMAND_RECEIPT_RETENTION_LIMIT = 2_000;
const MOBILE_AUTH_BEARER_BOOTSTRAP_PATH = "/mobile/v1/auth/bootstrap/bearer" as const;
const MOBILE_AUTH_SESSION_PATH = "/mobile/v1/auth/session" as const;
const MOBILE_AUTH_WS_TOKEN_PATH = "/mobile/v1/auth/ws-token" as const;

const MOBILE_METHOD_REQUIRED_CAPABILITY = {
  "orchestration.subscribeShell": "orchestration.shell",
  "orchestration.subscribeThread": "orchestration.thread-detail",
  "orchestration.replayEvents": "orchestration.replay-envelope",
  "orchestration.dispatchCommand": "orchestration.command-receipts",
  "orchestration.getTurnDiff": "diff.turn",
  "orchestration.getFullThreadDiff": "diff.full-thread",
} as const satisfies Record<MobileRequestMessage["method"], MobileClientCapability>;

class MobileJsonParseError extends Data.TaggedError("MobileJsonParseError")<{
  readonly cause: unknown;
}> {}

interface StoredMobileCommandReceipt {
  readonly receipt: MobileCommandReceipt;
  readonly payloadHash: string;
}

const protocolEnvelope = {
  protocolVersion: MOBILE_PROTOCOL_VERSION,
  serverCapabilities: [...MOBILE_V1_SERVER_CAPABILITIES],
} as const;

function mobileError(input: {
  readonly id: string | null;
  readonly code: MobileErrorCode;
  readonly message: string;
}): MobileErrorMessage {
  return {
    ...protocolEnvelope,
    id: input.id,
    type: "error",
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function mobileResponse(
  id: string,
  payload: MobileResponseMessage["payload"],
): MobileResponseMessage {
  return {
    ...protocolEnvelope,
    id,
    type: "response",
    payload,
  };
}

function mobileStream(id: string, payload: MobileStreamMessage["payload"]): MobileStreamMessage {
  return {
    ...protocolEnvelope,
    id,
    type: "stream",
    payload,
  };
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function formatUnknownError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMessageId(value: unknown): string | null {
  const record = asJsonRecord(value);
  const id = record?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

function getProtocolVersion(value: unknown): string | null {
  const record = asJsonRecord(value);
  const protocolVersion = record?.protocolVersion;
  return typeof protocolVersion === "string" ? protocolVersion : null;
}

function getUnsupportedProtocolMessage(value: unknown): MobileErrorMessage | null {
  const protocolVersion = getProtocolVersion(value);
  if (protocolVersion === null || protocolVersion === MOBILE_PROTOCOL_VERSION) {
    return null;
  }
  return mobileError({
    id: getMessageId(value),
    code: "unsupported-protocol-version",
    message: `Unsupported mobile protocol version ${protocolVersion}. Expected ${MOBILE_PROTOCOL_VERSION}.`,
  });
}

function isMobileClientOrchestrationCommand(
  command: ClientOrchestrationCommand,
): command is MobileClientOrchestrationCommand {
  switch (command.type) {
    case "thread.turn.start":
      return command.bootstrap === undefined;
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.session.stop":
      return true;
    default:
      return false;
  }
}

function makeMobileDescriptor(
  environment: MobileDescriptorResult["environment"],
): MobileDescriptorResult {
  return {
    ...protocolEnvelope,
    minSupportedProtocolVersion: MOBILE_PROTOCOL_VERSION,
    endpoints: {
      descriptor: MOBILE_HTTP_PREFIX,
      authBearerBootstrap: MOBILE_AUTH_BEARER_BOOTSTRAP_PATH,
      authSession: MOBILE_AUTH_SESSION_PATH,
      authWebSocketToken: MOBILE_AUTH_WS_TOKEN_PATH,
      websocket: MOBILE_WS_PATH,
    },
    environment,
  };
}

function makeWrappedBearerBootstrapResult(
  result: AuthBearerBootstrapResult,
): MobileAuthBearerBootstrapResult {
  return {
    ...protocolEnvelope,
    result,
  };
}

function makeWrappedSessionResult(result: AuthSessionState): MobileAuthSessionResult {
  return {
    ...protocolEnvelope,
    result,
  };
}

function makeWrappedWebSocketTokenResult(
  result: AuthWebSocketTokenResult,
): MobileAuthWebSocketTokenResult {
  return {
    ...protocolEnvelope,
    result,
  };
}

const decodeMobileClientMessage = Schema.decodeUnknownEffect(MobileClientMessage);
const encodeMobileServerMessage = Schema.encodeUnknownSync(MobileServerMessage);

function encodeServerMessage(message: MobileServerMessage): string {
  return JSON.stringify(encodeMobileServerMessage(message));
}

function toShellStreamEvent(
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  event: OrchestrationEvent,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
      return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
        Effect.map((project) =>
          Option.map(project, (nextProject) => ({
            kind: "project-upserted" as const,
            sequence: event.sequence,
            project: nextProject,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    case "project.deleted":
      return Effect.succeed(
        Option.some({
          kind: "project-removed" as const,
          sequence: event.sequence,
          projectId: event.payload.projectId,
        }),
      );
    case "thread.deleted":
      return Effect.succeed(
        Option.some({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: event.payload.threadId,
        }),
      );
    default:
      if (event.aggregateKind !== "thread") {
        return Effect.succeed(Option.none());
      }
      return projectionSnapshotQuery.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
        Effect.map((thread) =>
          Option.map(thread, (nextThread) => ({
            kind: "thread-upserted" as const,
            sequence: event.sequence,
            thread: nextThread,
          })),
        ),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
  }
}

export const mobileDescriptorRouteLayer = HttpRouter.add(
  "GET",
  MOBILE_HTTP_PREFIX,
  Effect.gen(function* () {
    const serverEnvironment = yield* ServerEnvironment;
    const environment = yield* serverEnvironment.getDescriptor;
    return HttpServerResponse.jsonUnsafe(makeMobileDescriptor(environment), { status: 200 });
  }),
);

export const mobileAuthBearerBootstrapRouteLayer = HttpRouter.add(
  "POST",
  MOBILE_AUTH_BEARER_BOOTSTRAP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid mobile bearer bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );
    return HttpServerResponse.jsonUnsafe(makeWrappedBearerBootstrapResult(result), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const mobileAuthSessionRouteLayer = HttpRouter.add(
  "GET",
  MOBILE_AUTH_SESSION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const result = yield* serverAuth.getSessionState(request);
    return HttpServerResponse.jsonUnsafe(makeWrappedSessionResult(result), { status: 200 });
  }),
);

export const mobileAuthWebSocketTokenRouteLayer = HttpRouter.add(
  "POST",
  MOBILE_AUTH_WS_TOKEN_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketToken(session);
    return HttpServerResponse.jsonUnsafe(makeWrappedWebSocketTokenResult(result), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

function makeReplayEnvelope(input: {
  readonly fromSequenceExclusive: number;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly serverHighWaterSequence: number;
}): MobileReplayEnvelope {
  const returnedToSequenceInclusive = input.events.reduce(
    (max, event) => Math.max(max, event.sequence),
    input.fromSequenceExclusive,
  );
  return {
    status: "complete",
    fromSequenceExclusive: input.fromSequenceExclusive,
    returnedFromSequenceExclusive: input.fromSequenceExclusive,
    returnedToSequenceInclusive,
    serverHighWaterSequence: Math.max(input.serverHighWaterSequence, returnedToSequenceInclusive),
    events: [...input.events],
    resnapshot: [],
  };
}

function makeReplayGapEnvelope(input: {
  readonly fromSequenceExclusive: number;
  readonly serverHighWaterSequence: number;
  readonly message: string;
}): MobileReplayEnvelope {
  return {
    status: "cursor-too-old",
    fromSequenceExclusive: input.fromSequenceExclusive,
    returnedFromSequenceExclusive: input.fromSequenceExclusive,
    returnedToSequenceInclusive: input.fromSequenceExclusive,
    serverHighWaterSequence: input.serverHighWaterSequence,
    events: [],
    resnapshot: ["all"],
    error: {
      code: "replay-gap",
      message: input.message,
    },
  };
}

export const mobileWebSocketRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const commandReceipts = yield* Ref.make(new Map<string, StoredMobileCommandReceipt>());

    return HttpRouter.add(
      "GET",
      MOBILE_WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
        const orchestrationEngine = yield* OrchestrationEngineService;
        const checkpointDiffQuery = yield* CheckpointDiffQuery;
        const startup = yield* ServerRuntimeStartup;
        yield* serverAuth.authenticateWebSocketUpgrade(request);

        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        const send = (message: MobileServerMessage) => write(encodeServerMessage(message));
        const sendError = (id: string | null, code: MobileErrorCode, message: string) =>
          send(mobileError({ id, code, message }));
        let negotiatedCapabilities: ReadonlySet<MobileClientCapability> | null = null;

        const dispatchWithReceipt = (
          requestId: string,
          command: MobileClientOrchestrationCommand,
        ) =>
          Effect.gen(function* () {
            const payloadHash = hashPayload(command);
            const existing = yield* Ref.get(commandReceipts).pipe(
              Effect.map((receipts) => receipts.get(command.commandId)),
            );
            if (existing) {
              if (existing.payloadHash !== payloadHash) {
                yield* send(
                  mobileResponse(requestId, {
                    status: "rejected",
                    commandId: command.commandId,
                    payloadHash,
                    acceptedAt: new Date().toISOString(),
                    error: {
                      code: "command-rejected",
                      message: "A different command payload already used this commandId.",
                    },
                  }),
                );
                return;
              }

              yield* send(
                mobileResponse(requestId, {
                  ...existing.receipt,
                  status: "duplicate",
                }),
              );
              return;
            }

            const acceptedAt = new Date().toISOString();
            const receipt = yield* normalizeDispatchCommand(command).pipe(
              Effect.flatMap((normalizedCommand) =>
                dispatchThroughStartupGate(normalizedCommand, orchestrationEngine, startup),
              ),
              Effect.map(
                (result): MobileCommandReceipt => ({
                  status: "accepted",
                  commandId: command.commandId,
                  payloadHash,
                  acceptedAt,
                  sequence: result.sequence,
                }),
              ),
              Effect.catch((cause) =>
                Effect.succeed({
                  status: "rejected" as const,
                  commandId: command.commandId,
                  payloadHash,
                  acceptedAt,
                  error: {
                    code: "command-rejected" as const,
                    message: formatUnknownError(cause, "Failed to dispatch mobile command."),
                  },
                }),
              ),
            );

            yield* Ref.update(commandReceipts, (receipts) => {
              const next = new Map(receipts);
              next.set(command.commandId, { payloadHash, receipt });
              if (next.size > MOBILE_COMMAND_RECEIPT_RETENTION_LIMIT) {
                const oldest = next.keys().next().value as string | undefined;
                if (oldest) {
                  next.delete(oldest);
                }
              }
              return next;
            });
            yield* send(mobileResponse(requestId, receipt));
          });

        const handleRequest = (message: MobileRequestMessage) =>
          Effect.gen(function* () {
            if (negotiatedCapabilities === null) {
              yield* sendError(
                message.id,
                "invalid-message",
                "Mobile WebSocket hello is required before requests.",
              );
              return;
            }

            const requiredCapability = MOBILE_METHOD_REQUIRED_CAPABILITY[message.method];
            if (
              !negotiatedCapabilities.has(requiredCapability) ||
              !protocolEnvelope.serverCapabilities.includes(requiredCapability)
            ) {
              yield* sendError(
                message.id,
                "invalid-message",
                `Mobile method ${message.method} requires capability ${requiredCapability}.`,
              );
              return;
            }

            switch (message.method) {
              case "orchestration.subscribeShell": {
                const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load mobile shell snapshot.",
                        cause,
                      }),
                  ),
                );
                yield* send(
                  mobileStream(message.id, {
                    kind: "snapshot",
                    snapshot,
                  }),
                );

                yield* orchestrationEngine.streamDomainEvents.pipe(
                  Stream.mapEffect((event) => toShellStreamEvent(projectionSnapshotQuery, event)),
                  Stream.flatMap((event) =>
                    Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                  ),
                  Stream.runForEach((event) => send(mobileStream(message.id, event))),
                  Effect.ignoreCause,
                  Effect.forkScoped,
                );
                return;
              }
              case "orchestration.subscribeThread": {
                const [threadDetail, readModel] = yield* Effect.all([
                  projectionSnapshotQuery.getThreadDetailById(message.payload.threadId),
                  orchestrationEngine.getReadModel(),
                ]);
                if (Option.isNone(threadDetail)) {
                  yield* sendError(
                    message.id,
                    "not-found",
                    `Thread ${message.payload.threadId} was not found.`,
                  );
                  return;
                }

                yield* send(
                  mobileStream(message.id, {
                    kind: "snapshot",
                    snapshot: {
                      snapshotSequence: readModel.snapshotSequence,
                      thread: threadDetail.value,
                    },
                  }),
                );

                yield* orchestrationEngine.streamDomainEvents.pipe(
                  Stream.filter(
                    (event) =>
                      event.aggregateKind === "thread" &&
                      event.aggregateId === message.payload.threadId &&
                      isThreadDetailEvent(event),
                  ),
                  Stream.runForEach((event) =>
                    send(
                      mobileStream(message.id, {
                        kind: "event",
                        event,
                      }),
                    ),
                  ),
                  Effect.ignoreCause,
                  Effect.forkScoped,
                );
                return;
              }
              case "orchestration.replayEvents": {
                const fromSequenceExclusive = Math.max(0, message.payload.fromSequenceExclusive);
                const serverHighWaterSequence = yield* projectionSnapshotQuery
                  .getShellSnapshot()
                  .pipe(
                    Effect.map((snapshot) => snapshot.snapshotSequence),
                    Effect.catch(() => Effect.succeed(fromSequenceExclusive)),
                  );
                const envelope = yield* Stream.runCollect(
                  orchestrationEngine.readEvents(fromSequenceExclusive),
                ).pipe(
                  Effect.map((events) =>
                    makeReplayEnvelope({
                      fromSequenceExclusive,
                      events: Array.from(events),
                      serverHighWaterSequence,
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.succeed(
                      makeReplayGapEnvelope({
                        fromSequenceExclusive,
                        serverHighWaterSequence,
                        message: formatUnknownError(cause, "Replay range is unavailable."),
                      }),
                    ),
                  ),
                );
                yield* send(mobileResponse(message.id, envelope));
                return;
              }
              case "orchestration.dispatchCommand": {
                if (!isMobileClientOrchestrationCommand(message.payload)) {
                  yield* sendError(
                    message.id,
                    "invalid-message",
                    "Mobile dispatch only supports read+chat MVP commands.",
                  );
                  return;
                }
                yield* dispatchWithReceipt(message.id, message.payload);
                return;
              }
              case "orchestration.getTurnDiff": {
                const result = yield* checkpointDiffQuery.getTurnDiff(message.payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetTurnDiffError({
                        message: "Failed to load mobile turn diff.",
                        cause,
                      }),
                  ),
                );
                yield* send(mobileResponse(message.id, result));
                return;
              }
              case "orchestration.getFullThreadDiff": {
                const result = yield* checkpointDiffQuery.getFullThreadDiff(message.payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetFullThreadDiffError({
                        message: "Failed to load mobile full thread diff.",
                        cause,
                      }),
                  ),
                );
                yield* send(mobileResponse(message.id, result));
                return;
              }
            }
          }).pipe(
            Effect.catch((cause) =>
              sendError(
                message.id,
                "internal-error",
                formatUnknownError(cause, "Mobile request failed."),
              ),
            ),
          );

        yield* socket.runRaw((raw) =>
          Effect.gen(function* () {
            const decodedJson = yield* Effect.try({
              try: () => JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)),
              catch: (cause) => new MobileJsonParseError({ cause }),
            }).pipe(
              Effect.catch(() =>
                sendError(null, "invalid-message", "Mobile WebSocket message must be JSON.").pipe(
                  Effect.as(null),
                ),
              ),
            );
            if (decodedJson === null) {
              return;
            }

            const unsupportedProtocol = getUnsupportedProtocolMessage(decodedJson);
            if (unsupportedProtocol !== null) {
              yield* send(unsupportedProtocol);
              return;
            }

            const message = yield* decodeMobileClientMessage(decodedJson).pipe(
              Effect.catch(() =>
                sendError(
                  getMessageId(decodedJson),
                  "invalid-message",
                  "Mobile WebSocket message failed validation.",
                ).pipe(Effect.as(null)),
              ),
            );
            if (message === null) {
              return;
            }

            if (message.type === "hello") {
              negotiatedCapabilities = new Set(message.capabilities);
              const response: MobileHelloResponse = {
                ...protocolEnvelope,
                id: message.id,
                type: "hello",
              };
              yield* send(response);
              return;
            }

            yield* handleRequest(message);
          }),
        );
        return HttpServerResponse.empty();
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    );
  }),
);

export const mobileRouteLayer = Layer.mergeAll(
  mobileDescriptorRouteLayer,
  mobileAuthBearerBootstrapRouteLayer,
  mobileAuthSessionRouteLayer,
  mobileAuthWebSocketTokenRouteLayer,
  mobileWebSocketRouteLayer,
);
