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
  OrchestrationReadModel,
  OrchestrationShellStreamItem,
  ORCHESTRATION_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";

import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

export interface CliLiveTargetFlags {
  readonly url: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
}

export const makeCommandId = (tag: string): CommandId =>
  CommandId.make(`cli:${tag}:${crypto.randomUUID()}`);

export const nowIso = (): string => new Date().toISOString();

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
}) {}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const DispatchResult = Schema.Struct({ sequence: Schema.Number });
const decodeJsonRecord = Schema.decodeUnknownEffect(JsonRecord);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeReadModel = HttpClientResponse.schemaBodyJson(OrchestrationReadModel);
const decodeDispatchResult = HttpClientResponse.schemaBodyJson(DispatchResult);
const decodeWsToken = HttpClientResponse.schemaBodyJson(AuthWebSocketTokenResult);
const makeWsRpcClient = RpcClient.make(WsRpcGroup);
const isCliRpcError = Schema.is(CliRpcError);
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
  readonly getSnapshot: ReturnType<typeof fetchSnapshot>;
  readonly dispatch: (command: ClientOrchestrationCommand) => ReturnType<typeof dispatchCommand>;
}

export interface CliLiveSnapshotRpcClient {
  readonly getSnapshot: ReturnType<typeof fetchSnapshot>;
  readonly client: WsRpcClient;
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
  resolveBaseDir(Option.getOrUndefined(baseDir));

export const resolveLiveTarget = (flags: CliLiveTargetFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.url)) {
      return {
        origin: yield* normalizeHttpOrigin(flags.url.value),
        token: Option.getOrUndefined(flags.token),
        baseDir: Option.getOrUndefined(flags.baseDir),
      };
    }

    const baseDir = yield* resolveCliBaseDir(flags.baseDir);
    const paths = yield* deriveServerPaths(baseDir, undefined);
    const runtimeState = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new CliLiveTargetError({
        message:
          "No running T3 server found. Start one with `t3 serve`, or pass --url and --token.",
      });
    }

    return {
      origin: yield* normalizeHttpOrigin(runtimeState.value.origin),
      token: Option.getOrUndefined(flags.token),
      baseDir,
    };
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

const fetchSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${origin}/api/orchestration/snapshot`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    );
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliRpcError({
        message: `Failed to fetch orchestration snapshot: HTTP ${response.status}.`,
      });
    }
    return yield* decodeReadModel(response).pipe(
      Effect.mapError(
        (cause) =>
          new CliRpcError({
            message: "Failed to decode orchestration snapshot.",
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIVE_REQUEST_TIMEOUT,
      orElse: () =>
        new CliRpcError({
          message: `Timed out fetching orchestration snapshot after ${Duration.toSeconds(
            LIVE_REQUEST_TIMEOUT,
          )}s. Is the T3 server responsive?`,
        }),
    }),
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
          return yield* new CliRpcError({
            message: `Failed to dispatch orchestration command: HTTP ${response.status}.`,
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

const wsRpcProtocolLayer = (url: string) => {
  const socketLayer = Socket.layerWebSocket(url);
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socketLayer),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const withBorrowedBearerToken = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (input: { readonly origin: string; readonly bearerToken: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const target = yield* resolveLiveTarget(flags);
    if (target.token !== undefined) {
      return yield* run({ origin: target.origin, bearerToken: target.token });
    }
    if (target.baseDir === undefined) {
      return yield* new CliLiveTargetError({
        message: "Missing --token for remote --url target.",
      });
    }

    const paths = yield* deriveServerPaths(target.baseDir, undefined);
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
      baseDir: target.baseDir,
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
            role: "owner",
            label: "t3 cli",
          }),
        ),
        (issued) => run({ origin: target.origin, bearerToken: issued.token }),
        (issued) =>
          retryLockedSqlite(authControlPlane.revokeSession(issued.sessionId)).pipe(Effect.ignore),
      );
    }).pipe(Effect.provide(authLayer));
  });

export const withLiveRpcClient = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  withBorrowedBearerToken(flags, ({ origin, bearerToken }) =>
    Effect.gen(function* () {
      const wsToken = yield* requestWebSocketToken(origin, bearerToken);
      const wsUrl = originToWsUrl(origin, wsToken.token);
      return yield* makeWsRpcClient.pipe(
        Effect.flatMap(run),
        Effect.provide(wsRpcProtocolLayer(wsUrl)),
        Effect.scoped,
      );
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer));

export const getLiveOrchestrationSnapshot = (flags: CliLiveTargetFlags) =>
  withBorrowedBearerToken(flags, ({ origin, bearerToken }) =>
    fetchSnapshot(origin, bearerToken),
  ).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveOrchestrationClient = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: CliLiveOrchestrationClient) => Effect.Effect<A, E, R>,
) =>
  withBorrowedBearerToken(flags, ({ origin, bearerToken }) =>
    run({
      getSnapshot: fetchSnapshot(origin, bearerToken),
      dispatch: (command) => dispatchCommand(origin, bearerToken, command),
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer));

export const withLiveSnapshotAndRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: (client: CliLiveSnapshotRpcClient) => Effect.Effect<A, E, R>,
) =>
  withBorrowedBearerToken(flags, ({ origin, bearerToken }) =>
    Effect.gen(function* () {
      const wsToken = yield* requestWebSocketToken(origin, bearerToken);
      const wsUrl = originToWsUrl(origin, wsToken.token);
      return yield* makeWsRpcClient.pipe(
        Effect.flatMap((client) =>
          run({ getSnapshot: fetchSnapshot(origin, bearerToken), client }),
        ),
        Effect.provide(wsRpcProtocolLayer(wsUrl)),
        Effect.scoped,
      );
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer));

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
}) =>
  withBorrowedBearerToken(input.flags, ({ origin, bearerToken }) =>
    dispatchCommand(origin, bearerToken, input.command),
  ).pipe(Effect.provide(FetchHttpClient.layer));

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
