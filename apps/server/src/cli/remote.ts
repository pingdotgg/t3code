import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentConflictError,
  EnvironmentId,
  EnvironmentInternalError,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_CLI_API_VERSION,
  OrchestrationCliCreateIdempotencyKey,
  type AuthEnvironmentScope,
  ProviderInteractionMode,
  RemoteInteractionAnswer,
  RemoteInteractionIdempotencyKey,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  RuntimeMode,
  ThreadId,
  TurnId,
  ORCHESTRATION_WS_METHODS,
} from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
} from "@t3tools/client-runtime/authorization";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  createRemoteOrchestrationThread,
  dispatchRemoteOrchestrationCommand,
  answerRemotePendingInteraction,
  approveRemotePendingInteraction,
  fetchRemoteOrchestrationShell,
  fetchRemoteOrchestrationSnapshot,
  fetchRemoteOrchestrationThread,
  fetchRemotePendingInteractions,
  rejectRemotePendingInteraction,
} from "@t3tools/client-runtime/operations";
import { RpcSessionFactory, rpcSessionLayer } from "@t3tools/client-runtime/rpc";
import { oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  DurationFromString,
  projectLocationFlags,
  resolveCliAuthConfig,
  type CliAuthLocationFlags,
} from "./config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  dispatchRemoteCommandSafely,
  makeRemoteSendCommand,
  remoteSessionHasScopes,
} from "./remoteOperations.ts";
import {
  loadRemoteCliToken,
  normalizeRemoteHttpBaseUrl,
  storeRemoteCliToken,
} from "./remoteTokenStore.ts";
import {
  formatRemoteWatchResult,
  observeRemoteWatchStream,
  type RemoteWatchFailure,
  RemoteWatchFailure as RemoteWatchFailureClass,
  type RemoteWatchTransport,
  watchRemoteThread,
} from "./remoteWatch.ts";

const REMOTE_ORCHESTRATION_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;

export class RemoteCliError extends Schema.TaggedErrorClass<RemoteCliError>()("RemoteCliError", {
  reason: Schema.Literals([
    "invalid-host",
    "unexpected-token",
    "authentication-required",
    "scope-required",
    "confirmation-required",
    "invalid-input",
    "capability-required",
    "version-incompatible",
    "local-server-not-running",
    "local-server-mismatch",
    "request-failed",
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-host":
        return "Remote host must be an absolute HTTP or HTTPS URL without credentials.";
      case "unexpected-token":
        return "The remote environment did not issue the requested bearer orchestration scopes.";
      case "authentication-required":
        return "The stored remote CLI token is not authenticated.";
      case "scope-required":
        return `The stored remote CLI token is missing required scope ${this.detail ?? ""}.`.trim();
      case "confirmation-required":
        return this.detail ?? "This remote operation requires explicit confirmation.";
      case "invalid-input":
        return this.detail ?? "Remote command input is invalid.";
      case "capability-required":
        return this.detail ?? "The target environment does not advertise the required capability.";
      case "version-incompatible":
        return this.detail ?? "The target environment has an incompatible orchestration CLI API.";
      case "local-server-not-running":
        return "No live T3 server was discovered for this base directory.";
      case "local-server-mismatch":
        return "The discovered T3 server does not match this base directory.";
      case "request-failed":
        return "The remote environment request failed.";
    }
  }
}

const isRemoteCliError = Schema.is(RemoteCliError);
const isEnvironmentConflictError = Schema.is(EnvironmentConflictError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);

const REMOTE_DIAGNOSTIC_MAX_CHARS = 512;
const REMOTE_DIAGNOSTIC_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex -- remote error text is an untrusted boundary
  /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u001f\u007f]/g;
const REMOTE_DIAGNOSTIC_CREDENTIAL_PATTERN =
  /\b(?:authorization\s*:\s*bearer|bearer|token|password|passwd|secret|api[_-]?key|credential)\s*[:=]?\s*[^\s,;]+/gi;
const REMOTE_DIAGNOSTIC_URL_PATTERN = /\b(?:https?|ssh|git):\/\/[^\s]+/gi;

function sanitizeRemoteServerDiagnostic(value: string, fallback: string): string {
  const sanitized = value
    .replace(REMOTE_DIAGNOSTIC_CONTROL_PATTERN, " ")
    .replace(REMOTE_DIAGNOSTIC_CREDENTIAL_PATTERN, "[redacted]")
    .replace(REMOTE_DIAGNOSTIC_URL_PATTERN, "[redacted-url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REMOTE_DIAGNOSTIC_MAX_CHARS)
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

function formatRemoteTraceId(traceId: string): string {
  return /^[A-Fa-f0-9]{32}$/.test(traceId) ? traceId : "unavailable";
}

export function formatRemoteCliDiagnostic(error: unknown): string {
  if (isRemoteCliError(error)) {
    return `Remote request failed: ${error.message}`;
  }
  if (isEnvironmentConflictError(error)) {
    return `Remote dispatch failed: ${sanitizeRemoteServerDiagnostic(
      error.message,
      "The requested worktree conflicts with existing local Git state.",
    )} No success was assumed. (trace: ${formatRemoteTraceId(error.traceId)})`;
  }
  if (isEnvironmentInternalError(error)) {
    return `Remote dispatch failed because the server reported an internal error. No success was assumed. (trace: ${formatRemoteTraceId(error.traceId)})`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "RemoteWatchFailure" ||
      error._tag === "RemoteWatchNoTurnError" ||
      error._tag === "RemoteWatchTerminalWithoutMessageError" ||
      error._tag === "RemoteWatchTimeoutError")
  ) {
    return error instanceof Error ? error.message : "Remote watch failed.";
  }
  return "Remote request failed.";
}

export const ORCHESTRATION_CLI_COMMAND_NAMES = new Set([
  "create",
  "send",
  "watch",
  "pending",
  "answer",
  "approve",
  "reject",
  "thread",
  "shell",
  "session",
  "snapshot",
]);

const NON_ORCHESTRATION_ROOT_COMMAND_NAMES = new Set([
  "start",
  "serve",
  "auth",
  "project",
  "service",
  "connect",
]);

const ROOT_FLAGS_WITH_VALUES = new Set([
  "--log-level",
  "--mode",
  "--port",
  "--host",
  "--base-dir",
  "--dev-url",
  "--bootstrap-fd",
  "--tailscale-serve-port",
]);

export function isOrchestrationCliInvocation(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      return false;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && ROOT_FLAGS_WITH_VALUES.has(arg)) {
        index += 1;
      }
      continue;
    }
    if (arg === "remote" || ORCHESTRATION_CLI_COMMAND_NAMES.has(arg)) {
      return true;
    }
    if (NON_ORCHESTRATION_ROOT_COMMAND_NAMES.has(arg)) {
      return false;
    }
    // The root command accepts one optional cwd positional before a subcommand.
  }
  return false;
}

const hostFlag = Flag.string("host").pipe(Flag.withDescription("Remote T3 Code HTTP base URL."));
const credentialFlag = Flag.redacted("credential").pipe(
  Flag.withDescription("One-time bootstrap credential (prompted securely when omitted)."),
  Flag.optional,
);
const yesFlag = Flag.boolean("yes").pipe(
  Flag.withDescription("Explicitly acknowledge the authorized write."),
  Flag.withDefault(false),
);
const confirmCreateFlag = Flag.boolean("confirm-create").pipe(
  Flag.withDescription("Second confirmation required for thread creation."),
  Flag.withDefault(false),
);
const startFromOriginFlag = Flag.boolean("start-from-origin").pipe(
  Flag.withDescription("Fetch origin and resolve the base branch from its remote tracking ref."),
  Flag.optional,
);
const runtimeModeFlag = Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode for the new thread."),
  Flag.optional,
);
const interactionModeFlag = Flag.choice("interaction-mode", ProviderInteractionMode.literals).pipe(
  Flag.withDescription("Interaction mode for the new thread."),
  Flag.optional,
);
const watchFormatFlag = Flag.choice("format", ["text", "json"] as const).pipe(
  Flag.withDescription("Final-result output: assistant text or structured JSON."),
  Flag.withDefault("text"),
);
const watchTimeoutFlag = Flag.string("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Maximum time to wait, for example 10m or 30s."),
  Flag.withDefault(Duration.minutes(10)),
);
const watchTurnFlag = Flag.string("turn").pipe(
  Flag.withDescription("Specific turn id to watch."),
  Flag.optional,
);
const watchInteractionsFlag = Flag.boolean("interactions").pipe(
  Flag.withDescription(
    "Exit promptly with code 26 and one-line redacted JSON when input or approval is pending (enabled by default; use --no-interactions to wait only for completion).",
  ),
  Flag.withDefault(true),
);
const pendingThreadIdFlag = Flag.string("thread-id").pipe(
  Flag.withDescription("Only return interactions for this thread id."),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.string("idempotency-key").pipe(
  Flag.withDescription("Opaque retry key scoped to the authorized remote session."),
);
const optionalIdempotencyKeyFlag = Flag.string("idempotency-key").pipe(
  Flag.withDescription("Opaque retry key scoped to the authenticated CLI principal."),
  Flag.optional,
);
const answersJsonFlag = Flag.string("answers-json").pipe(
  Flag.withDescription('JSON array of {"questionId":"...","values":["..."]} answers.'),
);
const rejectionDecisionFlag = Flag.choice("decision", ["decline", "cancel"] as const).pipe(
  Flag.withDescription("Legacy provider rejection decision."),
  Flag.withDefault("decline"),
);

type CliTargetKind = "local" | "remote";

interface RemoteCommandFlags extends CliAuthLocationFlags {
  readonly host: string;
}

interface ResolvedCliTarget {
  readonly kind: CliTargetKind;
  readonly httpBaseUrl: string;
  readonly stateDirectory: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly localConfig?: ServerConfig.ServerConfig["Service"];
}

export const requireCliApiCompatibility = (
  descriptor: ResolvedCliTarget["descriptor"],
  operation: string,
) => {
  const capabilities = descriptor.capabilities.orchestration;
  if (capabilities?.cliApiVersion !== ORCHESTRATION_CLI_API_VERSION) {
    return Effect.fail(
      new RemoteCliError({
        reason: "version-incompatible",
        detail: `Target orchestration CLI API version ${String(
          capabilities?.cliApiVersion ?? "missing",
        )} is incompatible with client version ${ORCHESTRATION_CLI_API_VERSION}.`,
      }),
    );
  }
  if (operation === "create" && capabilities.serverAuthoritativeCreate !== true) {
    return Effect.fail(
      new RemoteCliError({
        reason: "capability-required",
        detail: "The target environment does not support server-authoritative CLI create.",
      }),
    );
  }
  if (operation === "watch" && capabilities.watchResume !== true) {
    return Effect.fail(
      new RemoteCliError({
        reason: "capability-required",
        detail: "The target environment does not support resumable CLI watch.",
      }),
    );
  }
  if (
    ["pending", "answer", "approve", "reject"].includes(operation) &&
    capabilities.pendingInteractions !== true
  ) {
    return Effect.fail(
      new RemoteCliError({
        reason: "capability-required",
        detail: "The target environment does not support pending CLI interactions.",
      }),
    );
  }
  return Effect.void;
};

const resolveRemoteTarget = Effect.fn("remoteCli.resolveTarget")(function* (
  flags: RemoteCommandFlags,
) {
  const path = yield* Path.Path;
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeRemoteHttpBaseUrl(flags.host),
    catch: () => new RemoteCliError({ reason: "invalid-host" }),
  });
  return { httpBaseUrl, stateDirectory: path.join(baseDir, "remote-cli") };
});

const fetchCompatibleDescriptor = Effect.fn("orchestrationCli.fetchCompatibleDescriptor")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly operation: string;
    readonly timeoutMs?: number;
  }) {
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: input.httpBaseUrl,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
    yield* requireCliApiCompatibility(descriptor, input.operation);
    return descriptor;
  },
);

const resolveCliTarget = Effect.fn("orchestrationCli.resolveTarget")(function* (
  kind: CliTargetKind,
  flags: CliAuthLocationFlags & { readonly host?: string },
  operation: string,
) {
  if (kind === "remote") {
    if (flags.host === undefined) {
      return yield* new RemoteCliError({ reason: "invalid-host" });
    }
    const remote = yield* resolveRemoteTarget({
      ...flags,
      host: flags.host,
    });
    const descriptor = yield* fetchCompatibleDescriptor({
      httpBaseUrl: remote.httpBaseUrl,
      operation,
    });
    return { kind, ...remote, descriptor };
  }

  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return yield* new RemoteCliError({ reason: "local-server-not-running" });
  }
  const processIsLive = yield* Effect.sync(() => {
    try {
      process.kill(runtimeState.value.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (!processIsLive) {
    return yield* new RemoteCliError({ reason: "local-server-not-running" });
  }
  const descriptor = yield* fetchCompatibleDescriptor({
    httpBaseUrl: runtimeState.value.origin,
    operation,
    timeoutMs: 1_000,
  }).pipe(
    Effect.catchTag("RemoteCliError", (error) =>
      error.reason === "version-incompatible" || error.reason === "capability-required"
        ? Effect.fail(error)
        : Effect.fail(new RemoteCliError({ reason: "local-server-not-running" })),
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  const expectedEnvironmentId = yield* fs.readFileString(config.environmentIdPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (expectedEnvironmentId.length === 0 || descriptor.environmentId !== expectedEnvironmentId) {
    return yield* new RemoteCliError({ reason: "local-server-mismatch" });
  }
  const path = yield* Path.Path;
  return {
    kind,
    httpBaseUrl: runtimeState.value.origin,
    stateDirectory: path.join(config.stateDir, "local-cli"),
    descriptor,
    localConfig: config,
  };
});

const remoteRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  rpcSessionLayer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
);

const runRemote = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(remoteRuntimeLayer));

const targetLocationFlags = (kind: CliTargetKind) =>
  kind === "remote" ? { ...projectLocationFlags, host: hostFlag } : { ...projectLocationFlags };

const resolveCommandTarget = (
  kind: CliTargetKind,
  flags: CliAuthLocationFlags & { readonly host?: string },
  operation: string,
) => resolveCliTarget(kind, flags, operation);

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const decodeCliValue = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
) =>
  Option.match(Schema.decodeUnknownOption(schema)(value), {
    onNone: () =>
      Effect.fail(
        new RemoteCliError({
          reason: "invalid-input",
          detail: `${label} is invalid.`,
        }),
      ),
    onSome: Effect.succeed,
  });

const decodeRemoteAnswersJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(RemoteInteractionAnswer)),
);

const decodeAnswersJson = (value: string) =>
  Option.match(decodeRemoteAnswersJson(value, { onExcessProperty: "error" }), {
    onNone: () =>
      Effect.fail(
        new RemoteCliError({ reason: "invalid-input", detail: "Answers JSON is invalid." }),
      ),
    onSome: Effect.succeed,
  });

const loadRemoteAuthorization = Effect.fn("remoteCli.loadAuthorization")(function* (input: {
  readonly kind?: CliTargetKind;
  readonly stateDirectory: string;
  readonly httpBaseUrl: string;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
  readonly localConfig?: ServerConfig.ServerConfig["Service"];
  readonly requiredScopes: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const tokenLocation = {
    stateDirectory: input.stateDirectory,
    httpBaseUrl: input.httpBaseUrl,
    ...(input.kind === "local" && input.descriptor !== undefined
      ? { tokenStorageKey: `environment:${input.descriptor.environmentId}` }
      : {}),
  };
  const validateToken = (accessToken: string) =>
    fetchRemoteSessionState({
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: accessToken,
    }).pipe(
      Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
      Effect.flatMap((session) => {
        if (!session.authenticated) {
          return Effect.fail(new RemoteCliError({ reason: "authentication-required" }));
        }
        const missingScope = input.requiredScopes.find(
          (scope) => !remoteSessionHasScopes(session, [scope]),
        );
        return missingScope === undefined
          ? Effect.succeed({ accessToken, session })
          : Effect.fail(new RemoteCliError({ reason: "scope-required", detail: missingScope }));
      }),
    );

  if (input.kind !== "local") {
    const token = yield* loadRemoteCliToken(tokenLocation);
    return yield* validateToken(token.accessToken);
  }

  const stored = yield* Effect.option(loadRemoteCliToken(tokenLocation));
  if (Option.isSome(stored)) {
    const validated = yield* Effect.option(validateToken(stored.value.accessToken));
    if (Option.isSome(validated)) {
      return validated.value;
    }
  }
  if (input.localConfig === undefined || input.descriptor === undefined) {
    return yield* new RemoteCliError({ reason: "request-failed" });
  }
  const localConfig = input.localConfig;
  const descriptor = input.descriptor;

  const issued = yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* environmentAuth.issueSession({
      scopes: REMOTE_ORCHESTRATION_SCOPES,
      subject: `local-cli:${descriptor.environmentId}`,
      label: "T3 local CLI",
      ttl: Duration.days(30),
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer).pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layer(localConfig)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
    Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
  );
  yield* storeRemoteCliToken({
    ...tokenLocation,
    token: {
      accessToken: issued.token,
      expiresAtEpochMs: issued.expiresAt.epochMilliseconds,
    },
  });
  return yield* validateToken(issued.token);
});

const readThreadOption = (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: ThreadId;
}) =>
  fetchRemoteOrchestrationThread({
    httpBaseUrl: input.httpBaseUrl,
    authorization: { accessToken: input.accessToken },
    threadId: input.threadId,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("EnvironmentResourceNotFoundError", () => Effect.succeed(Option.none())),
  );

function websocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

function remoteWatchFailure(
  error: unknown,
  fallback: RemoteWatchFailure["kind"],
): RemoteWatchFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "EnvironmentAuthInvalidError" ||
      error._tag === "EnvironmentScopeRequiredError" ||
      (error._tag === "ConnectionBlockedError" &&
        "reason" in error &&
        error.reason === "permission"))
  ) {
    return new RemoteWatchFailureClass({ kind: "auth" });
  }
  return new RemoteWatchFailureClass({ kind: fallback });
}

const makeRemoteWatchTransport = Effect.fn("remoteCli.makeWatchTransport")(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: ThreadId;
}): Effect.fn.Return<RemoteWatchTransport, never, RpcSessionFactory | HttpClient.HttpClient> {
  const sessions = yield* RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;
  const readThread = () =>
    fetchRemoteOrchestrationThread({
      httpBaseUrl: input.httpBaseUrl,
      authorization: { accessToken: input.accessToken },
      threadId: input.threadId,
    }).pipe(
      Effect.mapError((error) => remoteWatchFailure(error, "transport")),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  const subscribeThread: RemoteWatchTransport["subscribeThread"] = (watchInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ticket = yield* issueRemoteWebSocketTicket({
          httpBaseUrl: input.httpBaseUrl,
          bearerToken: input.accessToken,
        }).pipe(Effect.mapError((error) => remoteWatchFailure(error, "unavailable")));
        const socketUrl = new URL(websocketBaseUrl(input.httpBaseUrl));
        socketUrl.searchParams.set("wsTicket", ticket.ticket);
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make(`remote-cli:${new URL(input.httpBaseUrl).host}`),
          label: new URL(input.httpBaseUrl).host,
          httpBaseUrl: input.httpBaseUrl,
          wsBaseUrl: websocketBaseUrl(input.httpBaseUrl),
        });
        const connection: PreparedConnection = {
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: socketUrl.toString(),
          // Remote CLI targets are normalized to an origin and do not carry
          // persisted connection-profile query parameters.
          queryParameters: [],
          httpAuthorization: { _tag: "Bearer", token: input.accessToken },
          target,
        };
        const session = yield* sessions
          .connect(connection)
          .pipe(Effect.mapError((error) => remoteWatchFailure(error, "unavailable")));
        yield* session.ready.pipe(
          Effect.mapError((error) => remoteWatchFailure(error, "unavailable")),
        );
        return yield* observeRemoteWatchStream({
          stream: session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: watchInput.threadId,
            afterSequence: watchInput.afterSequence,
          }).pipe(Stream.mapError((error) => remoteWatchFailure(error, "transport"))),
          initialSequence: watchInput.afterSequence,
          targetTurnId: watchInput.targetTurnId,
          observedRunning: watchInput.observedRunning,
          interactionAware: watchInput.interactionAware,
        });
      }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  return { readThread, subscribeThread };
});

const remoteEnvironmentCommand = Command.make("environment", {
  ...projectLocationFlags,
  host: hostFlag,
}).pipe(
  Command.withDescription("Read the unauthenticated remote environment descriptor."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: target.httpBaseUrl,
        });
        yield* Console.log(formatJson(descriptor));
      }),
    ),
  ),
);

const remoteAuthCommand = Command.make("auth", {
  ...projectLocationFlags,
  host: hostFlag,
  credential: credentialFlag,
}).pipe(
  Command.withDescription("Exchange a one-time credential for narrow remote orchestration access."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        yield* fetchCompatibleDescriptor({
          httpBaseUrl: target.httpBaseUrl,
          operation: "session",
        });
        const credential = Option.isSome(flags.credential)
          ? flags.credential.value
          : yield* Prompt.run(Prompt.password({ message: "One-time bootstrap credential" }));
        const exchanged = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: target.httpBaseUrl,
          credential: Redacted.value(credential),
          scopes: REMOTE_ORCHESTRATION_SCOPES,
          clientMetadata: { label: "T3 remote CLI", deviceType: "bot" },
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        if (
          exchanged.token_type !== "Bearer" ||
          !oauthScopeSetEquals(exchanged.scope, REMOTE_ORCHESTRATION_SCOPES)
        ) {
          return yield* new RemoteCliError({ reason: "unexpected-token" });
        }
        const now = yield* Clock.currentTimeMillis;
        const expiresAtEpochMs = now + exchanged.expires_in * 1_000;
        yield* storeRemoteCliToken({
          ...target,
          token: { accessToken: exchanged.access_token, expiresAtEpochMs },
        });
        yield* Console.log(formatJson({ authenticated: true, expiresAtEpochMs }));
      }),
    ),
  ),
);

const makeSessionCommand = (kind: CliTargetKind) =>
  Command.make("session", targetLocationFlags(kind)).pipe(
    Command.withDescription("Report the target environment and authenticated CLI principal."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "session",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          yield* Console.log(
            formatJson({
              target: {
                kind: target.kind,
                httpBaseUrl: target.httpBaseUrl,
                environment: target.descriptor,
              },
              auth: authorization.session,
            }),
          );
        }),
      ),
    ),
  );

const makeShellCommand = (kind: CliTargetKind) =>
  Command.make("shell", targetLocationFlags(kind)).pipe(
    Command.withDescription("Read the authenticated orchestration shell snapshot."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "shell",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          const snapshot = yield* fetchRemoteOrchestrationShell({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
          });
          yield* Console.log(formatJson(snapshot));
        }),
      ),
    ),
  );

const makeSnapshotCommand = (kind: CliTargetKind) =>
  Command.make("snapshot", targetLocationFlags(kind)).pipe(
    Command.withDescription("Advanced/debug: read the authenticated full orchestration snapshot."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "snapshot",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          const snapshot = yield* fetchRemoteOrchestrationSnapshot({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
          });
          yield* Console.log(formatJson(snapshot));
        }),
      ),
    ),
  );

const makeThreadCommand = (kind: CliTargetKind) =>
  Command.make("thread", {
    ...targetLocationFlags(kind),
    threadId: Argument.string("thread-id"),
  }).pipe(
    Command.withDescription("Read an authenticated thread detail snapshot."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "thread",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          const snapshot = yield* fetchRemoteOrchestrationThread({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            threadId: ThreadId.make(flags.threadId),
          });
          yield* Console.log(formatJson(snapshot));
        }),
      ),
    ),
  );

const makeSendCommand = (kind: CliTargetKind) =>
  Command.make("send", {
    ...targetLocationFlags(kind),
    yes: yesFlag,
    idempotencyKey: optionalIdempotencyKeyFlag,
    threadId: Argument.string("thread-id"),
    message: Argument.string("message"),
  }).pipe(
    Command.withDescription("Send a turn to an existing thread after explicit acknowledgement."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          if (!flags.yes) {
            return yield* new RemoteCliError({
              reason: "confirmation-required",
              detail: "Send requires --yes.",
            });
          }
          if (flags.message.trim().length === 0) {
            return yield* new RemoteCliError({
              reason: "invalid-input",
              detail: "Message must not be empty.",
            });
          }
          const idempotencyKey = Option.isSome(flags.idempotencyKey)
            ? yield* decodeCliValue(
                OrchestrationCliCreateIdempotencyKey,
                flags.idempotencyKey.value,
                "Idempotency key",
              )
            : undefined;
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "send",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: REMOTE_ORCHESTRATION_SCOPES,
          });
          const threadId = ThreadId.make(flags.threadId);
          const snapshot = yield* fetchRemoteOrchestrationThread({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            threadId,
          });
          const crypto = yield* Crypto.Crypto;
          const commandId = CommandId.make(
            idempotencyKey !== undefined && authorization.session.principal !== undefined
              ? `cli-send:${NodeCrypto.createHash("sha256")
                  .update(`${authorization.session.principal.sessionId}\0${idempotencyKey}`)
                  .digest("hex")}`
              : yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          );
          const command = makeRemoteSendCommand({
            snapshot,
            commandId,
            message: flags.message,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          const dispatch = dispatchRemoteOrchestrationCommand({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            command,
          });
          const result = yield* dispatchRemoteCommandSafely({
            command,
            dispatch,
            retryDispatch: dispatch,
            readThread: readThreadOption({
              httpBaseUrl: target.httpBaseUrl,
              accessToken: authorization.accessToken,
              threadId,
            }),
          });
          yield* Console.log(formatJson({ threadId, commandId, ...result }));
        }),
      ),
    ),
  );

const makeCreateCommand = (kind: CliTargetKind) =>
  Command.make("create", {
    ...targetLocationFlags(kind),
    yes: yesFlag,
    confirmCreate: confirmCreateFlag,
    idempotencyKey: optionalIdempotencyKeyFlag,
    startFromOrigin: startFromOriginFlag,
    runtimeMode: runtimeModeFlag,
    interactionMode: interactionModeFlag,
    title: Flag.string("title").pipe(Flag.optional),
    branch: Flag.string("branch").pipe(Flag.optional),
    baseBranch: Flag.string("base-branch").pipe(Flag.optional),
    projectId: Argument.string("project-id"),
    message: Argument.string("message"),
  }).pipe(
    Command.withDescription("Create an isolated-worktree thread with double confirmation."),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          if (!flags.yes || !flags.confirmCreate) {
            return yield* new RemoteCliError({
              reason: "confirmation-required",
              detail: "Create requires both --yes and --confirm-create.",
            });
          }
          if (
            flags.message.trim().length === 0 ||
            (Option.isSome(flags.branch) && flags.branch.value.trim().length === 0) ||
            (Option.isSome(flags.baseBranch) && flags.baseBranch.value.trim().length === 0)
          ) {
            return yield* new RemoteCliError({
              reason: "invalid-input",
              detail: "Message, branch, and base branch must not be empty when supplied.",
            });
          }
          const idempotencyKey = Option.isSome(flags.idempotencyKey)
            ? yield* decodeCliValue(
                OrchestrationCliCreateIdempotencyKey,
                flags.idempotencyKey.value,
                "Idempotency key",
              )
            : yield* Crypto.Crypto.pipe(
                Effect.flatMap((crypto) => crypto.randomUUIDv4),
                Effect.orDie,
              );
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "create",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: REMOTE_ORCHESTRATION_SCOPES,
          });
          const result = yield* createRemoteOrchestrationThread({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            payload: {
              project: flags.projectId,
              message: flags.message,
              idempotencyKey,
              ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
              ...(Option.isSome(flags.branch) ? { branch: flags.branch.value } : {}),
              ...(Option.isSome(flags.baseBranch) ? { baseBranch: flags.baseBranch.value } : {}),
              ...(Option.isSome(flags.startFromOrigin)
                ? { startFromOrigin: flags.startFromOrigin.value }
                : {}),
              ...(Option.isSome(flags.runtimeMode) ? { runtimeMode: flags.runtimeMode.value } : {}),
              ...(Option.isSome(flags.interactionMode)
                ? { interactionMode: flags.interactionMode.value }
                : {}),
            },
          });
          yield* Console.log(formatJson({ ...result, idempotencyKey }));
        }),
      ),
    ),
  );

const makeWatchCommand = (kind: CliTargetKind) =>
  Command.make("watch", {
    ...targetLocationFlags(kind),
    timeout: watchTimeoutFlag,
    format: watchFormatFlag,
    turn: watchTurnFlag,
    interactions: watchInteractionsFlag,
    threadId: Argument.string("thread-id"),
  }).pipe(
    Command.withDescription(
      "Wait for the next actionable interaction or a turn's final assistant result.",
    ),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "watch",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          const threadId = ThreadId.make(flags.threadId);
          const transport = yield* makeRemoteWatchTransport({
            httpBaseUrl: target.httpBaseUrl,
            accessToken: authorization.accessToken,
            threadId,
          });
          const result = yield* watchRemoteThread({
            transport,
            threadId,
            timeoutMs: Duration.toMillis(flags.timeout),
            interactionAware: flags.interactions,
            ...(Option.isSome(flags.turn)
              ? { requestedTurnId: TurnId.make(flags.turn.value) }
              : {}),
          }).pipe(
            Effect.catchTag("RemoteWatchInteractionRequiredError", (error) =>
              Console.log(error.message).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
          yield* Console.log(formatRemoteWatchResult(result, flags.format));
        }),
      ),
    ),
  );

const makePendingCommand = (kind: CliTargetKind) =>
  Command.make("pending", {
    ...targetLocationFlags(kind),
    threadId: pendingThreadIdFlag,
  }).pipe(
    Command.withDescription(
      "Inspect sanitized pending/responding interactions as one JSON document.",
    ),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "pending",
          );
          const threadId = Option.isSome(flags.threadId)
            ? yield* decodeCliValue(RemoteInteractionThreadId, flags.threadId.value, "Thread id")
            : undefined;
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationReadScope],
          });
          const result = yield* fetchRemotePendingInteractions({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            ...(threadId === undefined ? {} : { threadId }),
          }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
          yield* Console.log(formatJson(result));
        }),
      ),
    ),
  );

const makeAnswerCommand = (kind: CliTargetKind) =>
  Command.make("answer", {
    ...targetLocationFlags(kind),
    yes: yesFlag,
    idempotencyKey: idempotencyKeyFlag,
    answersJson: answersJsonFlag,
    threadId: Argument.string("thread-id"),
    requestId: Argument.string("request-id"),
  }).pipe(
    Command.withDescription(
      "Answer a pending user-input interaction with operate authorization and explicit --yes.",
    ),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          if (!flags.yes) {
            return yield* new RemoteCliError({
              reason: "confirmation-required",
              detail: "Answer requires --yes.",
            });
          }
          const [threadId, requestId, idempotencyKey, answers] = yield* Effect.all([
            decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
            decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
            decodeCliValue(
              RemoteInteractionIdempotencyKey,
              flags.idempotencyKey,
              "Idempotency key",
            ),
            decodeAnswersJson(flags.answersJson),
          ]);
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "answer",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationOperateScope],
          });
          const result = yield* answerRemotePendingInteraction({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            payload: { threadId, requestId, idempotencyKey, answers },
          }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
          yield* Console.log(formatJson(result));
        }),
      ),
    ),
  );

const makeApproveCommand = (kind: CliTargetKind) =>
  Command.make("approve", {
    ...targetLocationFlags(kind),
    yes: yesFlag,
    idempotencyKey: idempotencyKeyFlag,
    threadId: Argument.string("thread-id"),
    requestId: Argument.string("request-id"),
  }).pipe(
    Command.withDescription(
      "Approve an allowlisted interaction with operate authorization and explicit --yes.",
    ),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          if (!flags.yes) {
            return yield* new RemoteCliError({
              reason: "confirmation-required",
              detail: "Approve requires --yes.",
            });
          }
          const [threadId, requestId, idempotencyKey] = yield* Effect.all([
            decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
            decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
            decodeCliValue(
              RemoteInteractionIdempotencyKey,
              flags.idempotencyKey,
              "Idempotency key",
            ),
          ]);
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "approve",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationOperateScope],
          });
          const result = yield* approveRemotePendingInteraction({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            payload: { threadId, requestId, idempotencyKey },
          }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
          yield* Console.log(formatJson(result));
        }),
      ),
    ),
  );

const makeRejectCommand = (kind: CliTargetKind) =>
  Command.make("reject", {
    ...targetLocationFlags(kind),
    yes: yesFlag,
    idempotencyKey: idempotencyKeyFlag,
    decision: rejectionDecisionFlag,
    threadId: Argument.string("thread-id"),
    requestId: Argument.string("request-id"),
  }).pipe(
    Command.withDescription(
      "Decline/cancel an approval with operate authorization and explicit --yes.",
    ),
    Command.withHandler((flags) =>
      runRemote(
        Effect.gen(function* () {
          if (!flags.yes) {
            return yield* new RemoteCliError({
              reason: "confirmation-required",
              detail: "Reject requires --yes.",
            });
          }
          const [threadId, requestId, idempotencyKey] = yield* Effect.all([
            decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
            decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
            decodeCliValue(
              RemoteInteractionIdempotencyKey,
              flags.idempotencyKey,
              "Idempotency key",
            ),
          ]);
          const target = yield* resolveCommandTarget(
            kind,
            flags as CliAuthLocationFlags & { readonly host?: string },
            "reject",
          );
          const authorization = yield* loadRemoteAuthorization({
            ...target,
            requiredScopes: [AuthOrchestrationOperateScope],
          });
          const result = yield* rejectRemotePendingInteraction({
            httpBaseUrl: target.httpBaseUrl,
            authorization,
            payload: {
              threadId,
              requestId,
              idempotencyKey,
              decision: flags.decision,
            },
          }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
          yield* Console.log(formatJson(result));
        }),
      ),
    ),
  );

const remoteSessionCommand = makeSessionCommand("remote");
const remoteShellCommand = makeShellCommand("remote");
const remoteSnapshotCommand = makeSnapshotCommand("remote");
const remoteThreadCommand = makeThreadCommand("remote");
const remoteSendCommand = makeSendCommand("remote");
const remoteCreateCommand = makeCreateCommand("remote");
const remoteWatchCommand = makeWatchCommand("remote");
const remotePendingCommand = makePendingCommand("remote");
const remoteAnswerCommand = makeAnswerCommand("remote");
const remoteApproveCommand = makeApproveCommand("remote");
const remoteRejectCommand = makeRejectCommand("remote");

export const localOrchestrationCommands = [
  makeCreateCommand("local"),
  makeSendCommand("local"),
  makeWatchCommand("local"),
  makePendingCommand("local"),
  makeAnswerCommand("local"),
  makeApproveCommand("local"),
  makeRejectCommand("local"),
  makeThreadCommand("local"),
  makeShellCommand("local"),
  makeSessionCommand("local"),
  makeSnapshotCommand("local"),
] as const;

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Use the supported remote orchestration API."),
  Command.withSubcommands([
    remoteEnvironmentCommand,
    remoteAuthCommand,
    remoteSessionCommand,
    remoteShellCommand,
    remoteSnapshotCommand,
    remoteThreadCommand,
    remoteSendCommand,
    remoteCreateCommand,
    remoteWatchCommand,
    remotePendingCommand,
    remoteAnswerCommand,
    remoteApproveCommand,
    remoteRejectCommand,
  ]),
);
