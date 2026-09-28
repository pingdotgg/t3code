import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodePath from "@effect/platform-node/NodePath";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  AuthWebSocketTokenResult,
  ClientOrchestrationCommand,
  CommandId,
  DispatchResult,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationReadThreadInput,
  OrchestrationReadThreadResult,
  OrchestrationShellStreamItem,
  OrchestrationReadThreadInputError,
  OrchestrationDispatchCommandError,
  ORCHESTRATION_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";

import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { inspectPersistedServerRuntimeState, runtimePidIsAlive } from "../serverRuntimeState.ts";
import { resolveCliEnvironmentCandidate, withAccountEnvironment } from "./accountEnvironment.ts";
import { readEnvironmentRegistry, type CliEnvironmentCandidate } from "./environmentRegistry.ts";
import { withRpcDeadlines } from "./rpcDeadline.ts";
import { buildRevision } from "../buildIdentity.ts";
import { projectThreadDetailSnapshot } from "../orchestration/ActivityPayloadProjection.ts";
import { OrchestrationProjectionSnapshotQueryDependenciesLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";

export interface CliLiveTargetFlags {
  readonly url: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly environment: Option.Option<string>;
  readonly registryBaseDir?: Option.Option<string>;
}

export const makeCommandId = (tag: string): CommandId =>
  CommandId.make(`cli:${tag}:${crypto.randomUUID()}`);

export const nowIso = (): string => new Date().toISOString();

export const cliCompatibilityMessage = (subject: string): string =>
  `CLI_SERVER_INCOMPATIBLE: CLI ${buildRevision} could not decode ${subject}. ` +
  "Use the CLI from the running server's build, or update the CLI and server together. " +
  "Run 't3 installation identity --json' to inspect the executable; package versions alone may match across different builds.";

export class CliPayloadError extends Schema.TaggedErrorClass<CliPayloadError>()("CliPayloadError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CliLiveTargetError extends Schema.TaggedErrorClass<CliLiveTargetError>()(
  "CliLiveTargetError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class CliRpcError extends Schema.TaggedErrorClass<CliRpcError>()("CliRpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  definitiveCommandRejection: Schema.optional(Schema.Boolean),
}) {}

export const isDefinitiveCommandRejectionResponse = (body: string): boolean => {
  try {
    const decoded: unknown = JSON.parse(body);
    return (
      typeof decoded === "object" &&
      decoded !== null &&
      "code" in decoded &&
      decoded.code === "command-rejected"
    );
  } catch {
    return false;
  }
};

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonRecord = Schema.decodeUnknownEffect(JsonRecord);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeShellSnapshot = HttpClientResponse.schemaBodyJson(OrchestrationShellSnapshot);
const decodeThreadSnapshot = HttpClientResponse.schemaBodyJson(OrchestrationThreadDetailSnapshot);
const decodeDispatchResult = HttpClientResponse.schemaBodyJson(DispatchResult);
const decodeWsToken = HttpClientResponse.schemaBodyJson(AuthWebSocketTokenResult);
const makeWsRpcClient = RpcClient.make(WsRpcGroup).pipe(Effect.map(withRpcDeadlines));
const isCliRpcError = Schema.is(CliRpcError);
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationReadThreadInputError = Schema.is(OrchestrationReadThreadInputError);
export const isDefinitiveCommandRejectionError = (error: unknown): boolean => {
  if (isCliRpcError(error)) {
    return error.definitiveCommandRejection === true;
  }
  if (!isOrchestrationDispatchCommandError(error)) return false;

  const cause = error.cause;
  const isCommandRejection =
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "OrchestrationCommandInvariantError" ||
      cause._tag === "OrchestrationCommandPreviouslyRejectedError");
  if (!isCommandRejection) return false;

  const detail =
    typeof cause === "object" &&
    cause !== null &&
    "detail" in cause &&
    typeof cause.detail === "string"
      ? cause.detail
      : "";
  return !/delegation audit persistence (?:is not available|is unavailable)/iu.test(
    `${error.message} ${detail}`,
  );
};
const isCliLiveTargetError = Schema.is(CliLiveTargetError);
const isCliPayloadError = Schema.is(CliPayloadError);

// Every live request to the local server borrows an auth session and issues a
// single HTTP round-trip. `fetch` has no built-in timeout, so a server that
// accepts the socket but never responds (wedged mid-restart, deadlocked) would
// hang the CLI indefinitely. Bound each request so commands fail fast with a
// typed error instead of blocking forever.
const LIVE_REQUEST_TIMEOUT = Duration.seconds(10);

export type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface CliLiveOrchestrationClient {
  readonly getSnapshot: Effect.Effect<OrchestrationShellSnapshot, unknown, HttpClient.HttpClient>;
  readonly dispatch: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<DispatchResult, unknown, HttpClient.HttpClient>;
}

export interface CliLiveSnapshotRpcClient {
  readonly getSnapshot: Effect.Effect<OrchestrationShellSnapshot, unknown, never>;
  readonly getThreadSnapshot: (
    threadId: import("@t3tools/contracts").ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot, unknown, never>;
  readonly client: WsRpcClient;
}

export interface CliLiveSnapshotClient {
  readonly getSnapshot: Effect.Effect<OrchestrationShellSnapshot, unknown, HttpClient.HttpClient>;
  readonly getThreadSnapshot: (
    threadId: import("@t3tools/contracts").ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot, unknown, HttpClient.HttpClient>;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const printJson = (value: unknown) => Console.log(formatJson(value));

export const readJsonPayload = (input: {
  readonly payload: Option.Option<string>;
  readonly file: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    if (Option.isSome(input.payload) && Option.isSome(input.file)) {
      return yield* new CliPayloadError({
        message: "Use either --payload or --payload-file, not both.",
      });
    }

    const payload = Option.getOrUndefined(input.payload);
    if (payload !== undefined) {
      return yield* parseJsonPayload(payload, "--payload");
    }
    const file = Option.getOrUndefined(input.file);
    if (file !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFileString(file).pipe(
        Effect.mapError(
          (cause) =>
            new CliPayloadError({
              message: `Failed to read payload file: ${file}`,
              cause,
            }),
        ),
      );
      return yield* parseJsonPayload(raw, file);
    }
    return {};
  });

const parseJsonPayload = (raw: string, source: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new CliPayloadError({
        message: `Invalid JSON payload in ${source}.`,
        cause,
      }),
  });

const resolveCliBaseDir = (baseDir: Option.Option<string>) =>
  resolveBaseDir(Option.getOrUndefined(baseDir) ?? process.env.T3CODE_HOME);

export type ResolvedCliLiveTarget =
  | {
      readonly kind: "bearer";
      readonly origin: string;
      readonly token?: string;
      readonly baseDir?: string;
      readonly source: "explicit-url" | "explicit-base-dir" | "manual" | "implicit-local";
      readonly selectionReason:
        | "--url"
        | "--base-dir"
        | "--token"
        | "--environment"
        | "persisted-selection"
        | "legacy-local-discovery";
      readonly id?: string;
      readonly label?: string;
      readonly environmentId?: string;
    }
  | {
      readonly kind: "account";
      readonly baseDir: string;
      readonly accountId: string;
      readonly environmentId: string;
      readonly source: "account";
      readonly selectionReason: "--environment" | "persisted-selection";
      readonly label?: string;
    };

const resolveLocalRuntimeTarget = (
  baseDir: string,
  input: {
    readonly token?: string;
    readonly source: "explicit-base-dir" | "implicit-local";
    readonly selectionReason: "--base-dir" | "--token" | "legacy-local-discovery";
  },
) =>
  Effect.gen(function* () {
    const paths = yield* deriveServerPaths(baseDir, undefined);
    const runtimeState = yield* inspectPersistedServerRuntimeState(paths.serverRuntimeStatePath);
    if (runtimeState._tag === "Missing") {
      return yield* new CliLiveTargetError({
        message:
          "No running T3 server found. Start one with `t3 serve`, or pass --url and --token.",
      });
    }
    if (runtimeState._tag === "Invalid") {
      return yield* new CliLiveTargetError({
        message: `Invalid or unreadable T3 server runtime state at '${paths.serverRuntimeStatePath}'. Remove it and restart T3, or pass --url and --token.`,
        cause: runtimeState.cause,
      });
    }
    if (!runtimePidIsAlive(runtimeState.state.pid)) {
      return yield* new CliLiveTargetError({
        message: `Stale T3 server runtime state at '${paths.serverRuntimeStatePath}' belongs to stopped process ${String(runtimeState.state.pid)}. Remove it and restart T3, or pass --url and --token.`,
      });
    }

    return {
      kind: "bearer",
      origin: yield* normalizeHttpOrigin(runtimeState.state.origin),
      ...(input.token === undefined ? {} : { token: input.token }),
      baseDir,
      source: input.source,
      selectionReason: input.selectionReason,
    } satisfies ResolvedCliLiveTarget;
  });

const candidateTarget = (
  candidate: CliEnvironmentCandidate,
  baseDir: string,
  selectionReason: "--environment" | "persisted-selection",
  manualAuthBaseDir?: string,
): Effect.Effect<ResolvedCliLiveTarget, CliLiveTargetError> =>
  candidate.source === "manual"
    ? normalizeHttpOrigin(candidate.profile.url).pipe(
        Effect.map(
          (origin) =>
            ({
              kind: "bearer",
              origin,
              ...(candidate.profile.token === undefined ? {} : { token: candidate.profile.token }),
              ...(manualAuthBaseDir === undefined ? {} : { baseDir: manualAuthBaseDir }),
              source: "manual",
              selectionReason,
              id: candidate.id,
              label: candidate.label,
              ...(candidate.profile.environmentId === undefined
                ? {}
                : { environmentId: candidate.profile.environmentId }),
            }) satisfies ResolvedCliLiveTarget,
        ),
      )
    : Effect.succeed({
        kind: "account",
        baseDir,
        accountId: candidate.accountId,
        environmentId: candidate.environment.environmentId,
        source: "account",
        selectionReason,
        label: candidate.label,
      } satisfies ResolvedCliLiveTarget);

export const resolveLiveTarget = (flags: CliLiveTargetFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.url)) {
      return {
        kind: "bearer",
        origin: yield* normalizeHttpOrigin(flags.url.value),
        ...(Option.isSome(flags.token) ? { token: flags.token.value } : {}),
        ...(Option.isSome(flags.baseDir) ? { baseDir: flags.baseDir.value } : {}),
        source: "explicit-url",
        selectionReason: "--url",
      } satisfies ResolvedCliLiveTarget;
    }

    if (Option.isSome(flags.baseDir) || Option.isSome(flags.token)) {
      const baseDir = yield* resolveCliBaseDir(flags.baseDir);
      return yield* resolveLocalRuntimeTarget(baseDir, {
        ...(Option.isSome(flags.token) ? { token: flags.token.value } : {}),
        source: "explicit-base-dir",
        selectionReason: Option.isSome(flags.baseDir) ? "--base-dir" : "--token",
      });
    }

    const registryBaseDir = flags.registryBaseDir ?? Option.none();
    const baseDir = yield* resolveCliBaseDir(registryBaseDir);
    const manualAuthBaseDir = Option.isSome(registryBaseDir) ? baseDir : undefined;
    const registry = yield* readEnvironmentRegistry(Option.some(baseDir)).pipe(
      Effect.mapError(
        (cause) =>
          new CliLiveTargetError({
            message: cause.message,
            cause,
          }),
      ),
    );

    if (Option.isSome(flags.environment)) {
      const candidate = yield* resolveCliEnvironmentCandidate(
        baseDir,
        registry,
        flags.environment.value,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CliLiveTargetError({
              message:
                typeof cause === "object" &&
                cause !== null &&
                "message" in cause &&
                typeof cause.message === "string"
                  ? cause.message
                  : String(cause),
              cause,
            }),
        ),
      );
      return yield* candidateTarget(candidate, baseDir, "--environment", manualAuthBaseDir);
    }

    if (registry.current?.source === "manual") {
      const profile = registry.environments[registry.current.id];
      if (profile === undefined) {
        return yield* new CliLiveTargetError({
          message:
            `Selected manual environment '${registry.current.id}' no longer exists. ` +
            "Run `t3 env list` and choose another environment.",
        });
      }
      return yield* candidateTarget(
        {
          source: "manual",
          id: profile.id,
          label: profile.label,
          profile,
        },
        baseDir,
        "persisted-selection",
        manualAuthBaseDir,
      );
    }

    if (registry.current?.source === "account") {
      return {
        kind: "account",
        baseDir,
        accountId: registry.current.accountId,
        environmentId: registry.current.environmentId,
        source: "account",
        selectionReason: "persisted-selection",
      } satisfies ResolvedCliLiveTarget;
    }

    return yield* resolveLocalRuntimeTarget(baseDir, {
      source: "implicit-local",
      selectionReason: "legacy-local-discovery",
    });
  });

const normalizeHttpOrigin = (rawUrl: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(rawUrl),
      catch: (cause) =>
        new CliLiveTargetError({
          message: `Invalid server URL: ${rawUrl}`,
          cause,
        }),
    });
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* new CliLiveTargetError({
        message: `Expected an http(s) server URL, got '${url.protocol}' in ${rawUrl}.`,
      });
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  });

const originToWsUrl = (origin: string, wsToken: string): string => {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsToken", wsToken);
  return url.toString();
};

const requestWebSocketToken = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(`${origin}/api/auth/ws-token`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    );
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliLiveTargetError({
        message: `Failed to issue WebSocket token: HTTP ${response.status}.`,
      });
    }
    return yield* decodeWsToken(response).pipe(
      Effect.mapError(
        (cause) =>
          new CliLiveTargetError({
            message: "Failed to decode WebSocket token response.",
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_REQUEST_TIMEOUT,
      orElse: () =>
        new CliLiveTargetError({
          message: `Timed out requesting a WebSocket token after ${Duration.toSeconds(
            LIVE_REQUEST_TIMEOUT,
          )}s. Is the T3 server responsive?`,
        }),
    }),
  );

export const fetchLiveOrchestrationShellSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${origin}/api/orchestration/shell-snapshot`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    );
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliRpcError({
        message: `Failed to fetch orchestration shell snapshot: HTTP ${response.status}.`,
      });
    }
    return yield* decodeShellSnapshot(response).pipe(
      Effect.mapError(
        (cause) =>
          new CliRpcError({
            message: cliCompatibilityMessage("orchestration shell snapshot"),
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_REQUEST_TIMEOUT,
      orElse: () =>
        new CliRpcError({
          message: `Timed out fetching orchestration shell snapshot after ${Duration.toSeconds(
            LIVE_REQUEST_TIMEOUT,
          )}s. Is the T3 server responsive?`,
        }),
    }),
  );

export const fetchLiveOrchestrationThreadSnapshot = (
  origin: string,
  bearerToken: string,
  threadId: import("@t3tools/contracts").ThreadId,
) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(
      `${origin}/api/orchestration/threads/${encodeURIComponent(threadId)}/snapshot`,
    ).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(bearerToken));
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliRpcError({
        message: `Failed to fetch thread snapshot: HTTP ${response.status}.`,
      });
    }
    return yield* decodeThreadSnapshot(response).pipe(
      Effect.mapError(
        (cause) =>
          new CliRpcError({
            message: cliCompatibilityMessage("thread snapshot"),
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_REQUEST_TIMEOUT,
      orElse: () =>
        new CliRpcError({
          message: `Timed out fetching thread snapshot after ${Duration.toSeconds(
            LIVE_REQUEST_TIMEOUT,
          )}s. Is the T3 server responsive?`,
        }),
    }),
  );

const isImplicitLocalReadTarget = (
  target: ResolvedCliLiveTarget,
): target is Extract<ResolvedCliLiveTarget, { readonly kind: "bearer" }> & {
  readonly baseDir: string;
  readonly token?: undefined;
} =>
  target.kind === "bearer" &&
  target.token === undefined &&
  target.baseDir !== undefined &&
  (target.source === "implicit-local" || target.source === "explicit-base-dir");

const withLocalProjectionSnapshotQuery = <A, E, R>(
  baseDir: string,
  origin: string,
  run: (query: ProjectionSnapshotQueryShape) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const localTarget = yield* resolveLocalRuntimeTarget(baseDir, {
      source: "explicit-base-dir",
      selectionReason: "--base-dir",
    });
    if (localTarget.origin !== origin) {
      return yield* new CliLiveTargetError({
        message:
          `Refusing to read from '${baseDir}' because its live server origin changed from ` +
          `'${origin}' to '${localTarget.origin}'.`,
      });
    }
    const paths = yield* deriveServerPaths(baseDir, undefined);
    const sqliteLayer = makeRuntimeSqliteLayer({
      filename: paths.dbPath,
      readonly: true,
      disableWAL: true,
      spanAttributes: {
        "db.name": "t3.db",
        "service.name": "t3-cli-read",
      },
    });
    const queryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryDependenciesLive),
      Layer.provideMerge(sqliteLayer),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* run(yield* ProjectionSnapshotQuery);
      }).pipe(Effect.provide(queryLayer)),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodePath.layer)));

const mapLocalProjectionReadError = (cause: unknown, subject: string): CliRpcError =>
  new CliRpcError({
    message: `Failed to read local ${subject}.`,
    cause,
  });

const getLocalShellSnapshot = (baseDir: string, origin: string) =>
  withLocalProjectionSnapshotQuery(baseDir, origin, (query) =>
    query
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => mapLocalProjectionReadError(cause, "shell snapshot"))),
  );

const getLocalThreadSnapshot = (
  baseDir: string,
  origin: string,
  threadId: import("@t3tools/contracts").ThreadId,
) =>
  withLocalProjectionSnapshotQuery(baseDir, origin, (query) =>
    query.getThreadDetailSnapshotById(threadId).pipe(
      Effect.flatMap((snapshot) =>
        Option.isSome(snapshot)
          ? Effect.succeed(projectThreadDetailSnapshot(snapshot.value))
          : Effect.fail(new CliRpcError({ message: `Thread ${threadId} was not found.` })),
      ),
      Effect.mapError((cause) =>
        isCliRpcError(cause) ? cause : mapLocalProjectionReadError(cause, "thread snapshot"),
      ),
    ),
  );

const readLocalThread = (baseDir: string, origin: string, input: OrchestrationReadThreadInput) =>
  withLocalProjectionSnapshotQuery(baseDir, origin, (query) =>
    query
      .readThread(input)
      .pipe(
        Effect.mapError((cause) =>
          isOrchestrationReadThreadInputError(cause)
            ? new CliRpcError({ message: cause.message })
            : isCliRpcError(cause)
              ? cause
              : mapLocalProjectionReadError(cause, "thread history"),
        ),
      ),
  );

const dispatchCommand = (
  origin: string,
  bearerToken: string,
  command: ClientOrchestrationCommand,
) =>
  HttpClientRequest.post(`${origin}/api/orchestration/dispatch`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(bearerToken),
    HttpClientRequest.bodyJson(command),
    Effect.flatMap((request) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const response = yield* httpClient.execute(request);
        if (response.status < 200 || response.status >= 300) {
          const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          const responseDetail = responseBody.trim().slice(0, 1_000);
          const definitiveCommandRejection = isDefinitiveCommandRejectionResponse(responseBody);
          const rejectionMarker = definitiveCommandRejection
            ? "ORCHESTRATION_COMMAND_REJECTED: "
            : "";
          return yield* new CliRpcError({
            message: `${rejectionMarker}Failed to dispatch orchestration command: HTTP ${response.status}.${responseDetail.length > 0 ? ` ${responseDetail}` : ""}`,
            definitiveCommandRejection,
          });
        }
        return yield* decodeDispatchResult(response).pipe(
          Effect.mapError(
            (cause) =>
              new CliRpcError({
                message: "Failed to decode orchestration dispatch result.",
                cause,
              }),
          ),
        );
      }),
    ),
    Effect.timeoutOrElse({
      duration: LIVE_REQUEST_TIMEOUT,
      orElse: () =>
        new CliRpcError({
          message: `Timed out dispatching orchestration command after ${Duration.toSeconds(
            LIVE_REQUEST_TIMEOUT,
          )}s. Is the T3 server responsive?`,
        }),
    }),
  );

export const wsRpcProtocolLayer = (url: string | Effect.Effect<string, unknown>) => {
  // Socket resolves this effect for each connection, never replaying a single-use ticket.
  // Failed authorization terminates the protocol and fails its pending calls.
  const socketLayer = Socket.layerWebSocket(
    typeof url === "string" ? url : url.pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socketLayer),
    Layer.provide(RpcSerialization.layerJson),
  );
};

export const withBorrowedBearerToken = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (input: { readonly origin: string; readonly bearerToken: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.kind === "account") {
      return yield* new CliLiveTargetError({
        message: "This operation does not support account environment authentication.",
      });
    }
    return yield* withBorrowedBearerTokenForTarget(target, run);
  });

export const withResolvedLiveRpcClient = <A, E, R>(
  target: ResolvedCliLiveTarget,
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (target.kind === "account") {
      return yield* withAccountEnvironment(
        target.baseDir,
        {
          accountId: target.accountId,
          environmentId: target.environmentId,
        },
        (accountTarget) => withRpcClientForSocketUrl(accountTarget.nextSocketUrl, run),
      );
    }
    return yield* withBorrowedBearerTokenForTarget(target, ({ origin, bearerToken }) =>
      withRpcClientForBearerToken(origin, bearerToken, run),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveRpcClient = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  resolveLiveTarget(flags).pipe(Effect.flatMap((target) => withResolvedLiveRpcClient(target, run)));

const withBorrowedBearerTokenForTarget = <A, E, R>(
  target: Extract<ResolvedCliLiveTarget, { readonly kind: "bearer" }>,
  run: (input: { readonly origin: string; readonly bearerToken: string }) => Effect.Effect<A, E, R>,
) => {
  if (target.token !== undefined) {
    return run({ origin: target.origin, bearerToken: target.token });
  }
  if (target.baseDir === undefined) {
    return Effect.fail(
      new CliLiveTargetError({
        message: "Missing --token for remote --url or manual environment target.",
      }),
    );
  }
  return withBorrowedLocalBearerToken(target.baseDir, target.origin, run);
};

const withBorrowedLocalBearerToken = <A, E, R>(
  baseDir: string,
  origin: string,
  run: (input: { readonly origin: string; readonly bearerToken: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const localTarget = yield* resolveLocalRuntimeTarget(baseDir, {
      source: "explicit-base-dir",
      selectionReason: "--base-dir",
    });
    if (localTarget.origin !== origin) {
      return yield* new CliLiveTargetError({
        message:
          `Refusing to send a credential borrowed from '${baseDir}' to '${origin}'. ` +
          `That base directory belongs to the live server at '${localTarget.origin}'. ` +
          "Configure an explicit --token for a different target.",
      });
    }

    const paths = yield* deriveServerPaths(baseDir, undefined);
    const config = {
      logLevel: "Error",
      traceMinLevel: "Error",
      traceTimingEnabled: false,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-cli",
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      ...paths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "headless",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    } satisfies ServerConfigShape;

    const authLayer = AuthControlPlaneRuntimeLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;
      const retryLockedSqlite = <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) =>
        effect.pipe(
          Effect.retry({
            schedule: Schedule.spaced(Duration.millis(100)),
            times: 20,
            while: isSqliteDatabaseLocked,
          }),
        );

      return yield* Effect.acquireUseRelease(
        retryLockedSqlite(
          authControlPlane.issueSession({
            ttl: Duration.minutes(5),
            role: "owner",
            label: "t3 cli",
          }),
        ),
        (issued) => run({ origin, bearerToken: issued.token }),
        (issued) =>
          retryLockedSqlite(authControlPlane.revokeSession(issued.sessionId)).pipe(Effect.ignore),
      );
    }).pipe(Effect.provide(authLayer));
  });

export const withRpcClientForBearerToken = <A, E, R>(
  origin: string,
  bearerToken: string,
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const wsToken = yield* requestWebSocketToken(origin, bearerToken);
    const wsUrl = originToWsUrl(origin, wsToken.token);
    return yield* withRpcClientForSocketUrl(wsUrl, run);
  });

const withRpcClientForSocketUrl = <A, E, R>(
  socketUrl: string | Effect.Effect<string, unknown>,
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  makeWsRpcClient.pipe(
    Effect.flatMap(run),
    Effect.provide(wsRpcProtocolLayer(socketUrl)),
    Effect.scoped,
  );

export const getLiveOrchestrationShellSnapshot = (flags: CliLiveTargetFlags) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.kind === "account") {
      return yield* withAccountEnvironment(
        target.baseDir,
        {
          accountId: target.accountId,
          environmentId: target.environmentId,
        },
        (accountTarget) =>
          withRpcClientForSocketUrl(accountTarget.nextSocketUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.getShellSnapshot]({}),
          ),
      );
    }
    if (isImplicitLocalReadTarget(target)) {
      return yield* getLocalShellSnapshot(target.baseDir, target.origin);
    }
    return yield* withBorrowedBearerTokenForTarget(target, ({ origin, bearerToken }) =>
      fetchLiveOrchestrationShellSnapshot(origin, bearerToken),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const readLiveThread = (flags: CliLiveTargetFlags, input: OrchestrationReadThreadInput) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.kind === "account") {
      return yield* withResolvedLiveRpcClient(target, (client) =>
        client[ORCHESTRATION_WS_METHODS.readThread](input),
      );
    }
    if (isImplicitLocalReadTarget(target)) {
      return yield* readLocalThread(target.baseDir, target.origin, input);
    }
    return yield* withBorrowedBearerTokenForTarget(target, ({ origin, bearerToken }) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const request = yield* HttpClientRequest.post(
          `${origin}/api/orchestration/thread-read`,
        ).pipe(HttpClientRequest.bearerToken(bearerToken), HttpClientRequest.bodyJson(input));
        const response = yield* http.execute(request);
        if (response.status === 404) {
          return yield* new CliRpcError({
            message:
              "CLI_SERVER_INCOMPATIBLE: This server does not support targeted thread reads. Update the server and CLI together; --full retains the legacy detail read.",
          });
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.json;
          const detail =
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
              ? body.error
              : `HTTP ${response.status}`;
          return yield* new CliRpcError({ message: `Thread read failed: ${detail}` });
        }
        return yield* HttpClientResponse.schemaBodyJson(OrchestrationReadThreadResult)(
          response,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CliRpcError({ message: cliCompatibilityMessage("thread history"), cause }),
          ),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: LIVE_REQUEST_TIMEOUT,
          orElse: () => new CliRpcError({ message: "Timed out reading thread after 10s." }),
        }),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveOrchestrationClient = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: CliLiveOrchestrationClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.kind === "account") {
      return yield* withAccountEnvironment(
        target.baseDir,
        {
          accountId: target.accountId,
          environmentId: target.environmentId,
        },
        (accountTarget) =>
          withRpcClientForSocketUrl(accountTarget.nextSocketUrl, (client) =>
            run({
              getSnapshot: client[ORCHESTRATION_WS_METHODS.getShellSnapshot]({}),
              dispatch: (command) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
            }),
          ),
      );
    }
    return yield* withBorrowedBearerTokenForTarget(target, ({ origin, bearerToken }) =>
      run({
        getSnapshot: fetchLiveOrchestrationShellSnapshot(origin, bearerToken),
        dispatch: (command) => dispatchCommand(origin, bearerToken, command),
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveSnapshotClient = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: CliLiveSnapshotClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.kind === "account") {
      return yield* withAccountEnvironment(
        target.baseDir,
        {
          accountId: target.accountId,
          environmentId: target.environmentId,
        },
        (accountTarget) =>
          withRpcClientForSocketUrl(accountTarget.nextSocketUrl, (client) =>
            run({
              getSnapshot: client[ORCHESTRATION_WS_METHODS.getShellSnapshot]({}),
              getThreadSnapshot: (threadId) =>
                client[ORCHESTRATION_WS_METHODS.getThreadSnapshot]({ threadId }),
            }),
          ),
      );
    }
    if (isImplicitLocalReadTarget(target)) {
      return yield* run({
        getSnapshot: getLocalShellSnapshot(target.baseDir, target.origin),
        getThreadSnapshot: (threadId) =>
          getLocalThreadSnapshot(target.baseDir, target.origin, threadId),
      });
    }
    return yield* withBorrowedBearerTokenForTarget(target, ({ origin, bearerToken }) =>
      run({
        getSnapshot: fetchLiveOrchestrationShellSnapshot(origin, bearerToken),
        getThreadSnapshot: (threadId) =>
          fetchLiveOrchestrationThreadSnapshot(origin, bearerToken, threadId),
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveSnapshotAndRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: CliLiveSnapshotRpcClient) => Effect.Effect<A, E, R>,
) =>
  withLiveRpcClient(flags, (client) =>
    run({
      getSnapshot: client[ORCHESTRATION_WS_METHODS.getShellSnapshot]({}),
      getThreadSnapshot: (threadId) =>
        client[ORCHESTRATION_WS_METHODS.getThreadSnapshot]({ threadId }),
      client,
    }),
  );

export const decodeRpcPayload = (payload: unknown) =>
  decodeJsonRecord(payload).pipe(
    Effect.mapError(
      (cause) =>
        new CliPayloadError({
          message: "RPC payload must be a JSON object.",
          cause,
        }),
    ),
  );

export const decodeRawOrchestrationCommand = (payload: unknown) =>
  decodeClientOrchestrationCommand(payload).pipe(
    Effect.mapError(
      (cause) =>
        new CliPayloadError({
          message: "Payload is not a valid client orchestration command.",
          cause,
        }),
    ),
  );

export const callRawRpc = (input: {
  readonly flags: CliLiveTargetFlags;
  readonly method: string;
  readonly payload: Record<string, unknown>;
}) =>
  withLiveRpcClient(input.flags, (client) => {
    const methods = client as unknown as Record<
      string,
      (payload: Record<string, unknown>) => unknown
    >;
    const call = methods[input.method];
    if (call === undefined) {
      return Effect.fail(new CliRpcError({ message: `Unknown RPC method: ${input.method}` }));
    }
    const result = call(input.payload);
    if (isStreamLike(result)) {
      return Effect.fail(
        new CliRpcError({
          message:
            "Streaming RPC methods are not supported by `t3 rpc call`; use a dedicated watch command.",
        }),
      );
    }
    return result as Effect.Effect<unknown, Error, never>;
  }).pipe(
    Effect.mapError((cause) =>
      isCliRpcError(cause) || isCliLiveTargetError(cause) || isCliPayloadError(cause)
        ? cause
        : new CliRpcError({ message: `RPC call failed: ${String(cause)}`, cause }),
    ),
  );

function isStreamLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "~effect/Stream" in value;
}

function isSqliteDatabaseLocked(cause: unknown): boolean {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const message =
      "message" in current && typeof current.message === "string" ? current.message : undefined;
    if (message?.includes("database is locked") === true) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return typeof current === "string" && current.includes("database is locked");
}

export const dispatchRawOrchestrationCommand = (input: {
  readonly flags: CliLiveTargetFlags;
  readonly command: ClientOrchestrationCommand;
}) => withLiveOrchestrationClient(input.flags, (client) => client.dispatch(input.command));

const STREAM_RECONNECT_INITIAL_DELAY = Duration.seconds(1);
const STREAM_RECONNECT_MAX_DELAY = Duration.seconds(30);
// A connection that stayed up at least this long is considered healthy, so the
// next drop restarts backoff from the initial delay instead of compounding.
const STREAM_RECONNECT_HEALTHY_AFTER = Duration.seconds(30);

const describeStreamError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

/**
 * Run a long-lived streaming effect, transparently reconnecting with capped
 * exponential backoff when the underlying socket drops or the server closes the
 * stream. Notices are written to stderr so stdout stays a clean event log.
 *
 * `open` is expected to (re)establish the whole live session each attempt — for
 * snapshot-backed streams this means the latest snapshot is fetched again before
 * resubscribing. Interruptions (Ctrl-C) and defects propagate and stop the loop.
 */
export const runReconnectingStream = <E, R>(
  label: string,
  open: Effect.Effect<unknown, E, R>,
): Effect.Effect<never, E, R> => {
  const nextDelay = (delay: Duration.Duration) =>
    Duration.min(Duration.times(delay, 2), STREAM_RECONNECT_MAX_DELAY);

  const attempt = (delay: Duration.Duration): Effect.Effect<never, E, R> =>
    Effect.flatMap(Effect.timed(Effect.result(open)), ([elapsed, result]) =>
      Effect.gen(function* () {
        const wasHealthy =
          Duration.toMillis(elapsed) >= Duration.toMillis(STREAM_RECONNECT_HEALTHY_AFTER);
        const reason =
          result._tag === "Failure"
            ? `stream error: ${describeStreamError(result.failure)}`
            : "stream closed by server";
        const waitFor = wasHealthy ? STREAM_RECONNECT_INITIAL_DELAY : delay;
        yield* Console.error(
          `[${label}] ${reason}; reconnecting in ${Math.round(
            Duration.toMillis(waitFor) / 1000,
          )}s…`,
        );
        yield* Effect.sleep(waitFor);
        return yield* attempt(wasHealthy ? STREAM_RECONNECT_INITIAL_DELAY : nextDelay(delay));
      }),
    );

  return attempt(STREAM_RECONNECT_INITIAL_DELAY);
};

export const watchShell = (flags: CliLiveTargetFlags) =>
  runReconnectingStream(
    "orchestration watch",
    withLiveRpcClient(flags, (client) =>
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
        Stream.map((item: OrchestrationShellStreamItem) => formatJson(item)),
        Stream.runForEach((line) => Console.log(line)),
      ),
    ),
  );
