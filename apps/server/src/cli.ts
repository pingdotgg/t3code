import { NetService } from "@t3tools/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { buildReviewChangesPrompt } from "@t3tools/shared/workflows/reviewChanges";
import {
  ApprovalRequestId,
  AuthSessionId,
  CommandId,
  EditorId,
  DEFAULT_REVIEW_CHANGES_SCOPE,
  KeybindingRule,
  MessageId,
  ModelSelection,
  OrchestrationReadModel,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  TurnId,
  WS_METHODS,
  type GitStackedAction,
  type ReviewChangesScope,
  type ProviderApprovalDecision,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettingsPatch,
  type ServerProcessSignal,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlRepositoryVisibility,
  type VcsDriverKind,
  type ClientOrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  Config,
  Console,
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  LogLevel,
  Option,
  Path,
  References,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Stream,
} from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "./config.ts";
import { readBootstrapEnvelope } from "./bootstrap.ts";
import { expandHomePath, resolveBaseDir } from "./os-jank.ts";
import { AuthControlPlaneRuntimeLive } from "./auth/Layers/AuthControlPlane.ts";
import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "./cliAuthFormat.ts";
import { AuthControlPlane } from "./auth/Services/AuthControlPlane.ts";
import type { AuthControlPlaneShape } from "./auth/Services/AuthControlPlane.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { getAutoBootstrapDefaultModelSelection } from "./serverRuntimeStartup.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { WorkspacePaths } from "./workspace/Services/WorkspacePaths.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import {
  callRawRpc,
  decodeRawOrchestrationCommand,
  decodeRpcPayload,
  dispatchRawOrchestrationCommand,
  getLiveOrchestrationSnapshot,
  printJson,
  readJsonPayload,
  runReconnectingStream,
  withLiveOrchestrationClient,
  withLiveRpcClient,
  withLiveSnapshotAndRpc,
  watchShell,
  CliPayloadError,
  type CliLiveTargetFlags,
} from "./cli/client.ts";
import {
  activeProjectsOf,
  activeThreadsOf,
  findProjectForCli,
  findThreadForCli,
  normalizeWorkspaceRootForProjectCommand,
  projectSummary,
  resolveThreadForCli,
  threadSummary,
  withProjectRpc,
  withTerminalRpc,
  withThreadDispatch,
  withThreadRpc,
  type ActiveProject,
  type CliThread,
} from "./cli/liveContext.ts";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  t3Home: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  desktopBootstrapToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const mcpCwdFlag = Flag.string("cwd").pipe(
  Flag.withDescription("Workspace root exposed to MCP tools."),
  Flag.withDefault(process.cwd()),
);
const mcpToolsetsFlag = Flag.string("toolsets").pipe(
  Flag.withDescription("Comma-separated MCP toolsets to expose."),
  Flag.withDefault("read_file,search_files,skills_list"),
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const liveUrlFlag = Flag.string("url").pipe(
  Flag.withDescription(
    "HTTP(S) origin for a running T3 server. Defaults to persisted local runtime state.",
  ),
  Flag.optional,
);
const liveTokenFlag = Flag.string("token").pipe(
  Flag.withDescription("Bearer session token for the target T3 server."),
  Flag.optional,
);
const payloadFlag = Flag.string("payload").pipe(
  Flag.withDescription("JSON payload string. Defaults to `{}` when omitted."),
  Flag.optional,
);
const payloadFileFlag = Flag.string("payload-file").pipe(
  Flag.withDescription("Path to a JSON payload file."),
  Flag.optional,
);
const yesFlag = Flag.boolean("yes").pipe(
  Flag.withDescription("Confirm a destructive or high-risk operation."),
  Flag.withDefault(false),
);
const offlineFlag = Flag.boolean("offline").pipe(
  Flag.withDescription(
    "Mutate local project state directly, bypassing a running server. Unsafe while a server is running.",
  ),
  Flag.withDefault(false),
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.string("T3CODE_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: Config.int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: Config.int("T3CODE_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
  traceBatchWindowMs: Config.int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  otlpTracesUrl: Config.string("T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.string("T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: Config.string("T3CODE_OTLP_SERVICE_NAME").pipe(Config.withDefault("t3-server")),
  mode: Config.schema(RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.fromUndefinedOr(bootstrap?.devUrl),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.t3Home),
          Option.fromUndefinedOr(bootstrap?.t3Home),
        ),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
        Option.fromUndefinedOr(bootstrap?.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
        Option.fromUndefinedOr(bootstrap?.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);

const runWithAuthControlPlane = <A, E>(
  flags: CliAuthLocationFlags,
  run: (authControlPlane: AuthControlPlaneShape) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;
      return yield* run(authControlPlane);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AuthControlPlaneRuntimeLive).pipe(
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "project.create" | "project.meta.update" | "project.delete" }
>;

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePathsLive,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);
const OrchestrationHttpErrorResponse = Schema.Struct({
  error: Schema.String,
});

const withProjectCliSessionToken = <A, E, R>(
  authControlPlane: AuthControlPlaneShape,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    authControlPlane.issueSession({
      role: "owner",
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => authControlPlane.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT));

const runLiveServerRequest = <A, E extends Error, R>(
  request: HttpClientRequest.HttpClientRequest,
  handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    return yield* handle(response);
  }).pipe(withProjectCliLiveServerTimeout);

const decodeOrchestrationReadModelResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationReadModel)(response);

const readErrorMessageFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationHttpErrorResponse)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((body) => {
      if (typeof body === "string" && body.trim().length > 0) {
        return body;
      }
      return `Server request failed with status ${response.status}.`;
    }),
  );

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* Effect.fail(new Error("Project title cannot be empty."));
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* Effect.fail(new Error("Project identifier cannot be empty."));
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.exit(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot = Exit.isSuccess(normalizedWorkspaceRootResult)
    ? normalizedWorkspaceRootResult.value
    : null;

  const exactWorkspaceMatch =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot);

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* Effect.fail(new Error(`No active project found for '${trimmedIdentifier}'.`));
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/orchestration/snapshot`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": decodeOrchestrationReadModelResponse,
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  HttpClientRequest.post(`${origin}/api/orchestration/dispatch`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(bearerToken),
    HttpClientRequest.bodyJson(command),
    Effect.flatMap((request) =>
      runLiveServerRequest(
        request,
        HttpClientResponse.matchStatus({
          "2xx": () => Effect.void,
          orElse: (response) =>
            readErrorMessageFromResponse(response).pipe(
              Effect.flatMap((message) => Effect.fail(new Error(message))),
            ),
        }),
      ),
    ),
  );

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

type ProjectExecutionPlan =
  | { readonly mode: "live"; readonly origin: string }
  | { readonly mode: "offline" };

const resolveProjectExecutionPlan = Effect.fn("resolveProjectExecutionPlan")(function* (
  authControlPlane: AuthControlPlaneShape,
  config: ServerConfigShape,
  forceOffline: boolean,
) {
  if (forceOffline) {
    return { mode: "offline" } as const satisfies ProjectExecutionPlan;
  }

  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    // No server is registered, so the local store has no live owner: mutate it directly.
    return { mode: "offline" } as const satisfies ProjectExecutionPlan;
  }

  const origin = runtimeState.value.origin;
  const probe = withProjectCliSessionToken(authControlPlane, (token) =>
    fetchLiveOrchestrationSnapshot(origin, token),
  );
  const probed = yield* Effect.exit(probe);
  if (Exit.isSuccess(probed)) {
    return { mode: "live", origin } as const satisfies ProjectExecutionPlan;
  }

  // A server is registered but did not respond. It may still be running and own the
  // store, so refuse to mutate it directly and do not clear the (possibly valid)
  // runtime state on a transient failure.
  return yield* Effect.fail(
    new Error(
      `A T3 server is registered at ${origin} but did not respond within ` +
        `${Duration.toSeconds(PROJECT_CLI_LIVE_SERVER_TIMEOUT)}s. Refusing to modify project ` +
        `state directly while it may still be running. Retry when the server is responsive, ` +
        `stop it, or re-run with --offline to force a direct local write.`,
    ),
  );
});

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | WorkspacePaths
  >,
  options?: {
    readonly forceOffline?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const authControlPlane = yield* AuthControlPlane;
    const plan = yield* resolveProjectExecutionPlan(
      authControlPlane,
      config,
      options?.forceOffline ?? false,
    );

    if (plan.mode === "live") {
      return yield* withProjectCliSessionToken(authControlPlane, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(plan.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) => dispatchLiveOrchestrationCommand(plan.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AuthControlPlaneRuntimeLive, WorkspacePathsLive).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

const liveTargetFlags = {
  url: liveUrlFlag,
  token: liveTokenFlag,
  baseDir: baseDirFlag,
} as const;

const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const authLocationFlags = sharedServerLocationFlags;

const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const sessionRoleFlag = Flag.choice("role", ["owner", "client"]).pipe(
  Flag.withDescription("Role for the issued bearer session."),
  Flag.withDefault("owner"),
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.string("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.createPairingLink({
            role: "client",
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
          });
          yield* Console.log(output);
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const pairingLinks = yield* authControlPlane.listPairingLinks({ role: "client" });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.string("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  ttl: ttlFlag,
  role: sessionRoleFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a bearer session token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.issueSession({
            role: flags.role,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const sessions = yield* authControlPlane.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.string("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeProjectScripts = Schema.decodeUnknownEffect(Schema.Array(ProjectScript));
const decodeEditorId = Schema.decodeUnknownEffect(EditorId);
const decodeKeybindingRule = Schema.decodeUnknownEffect(KeybindingRule);

const readModelSelectionPayload = (input: {
  readonly payload: Option.Option<string>;
  readonly file: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const raw = yield* readJsonPayload(input);
    return yield* decodeModelSelection(raw).pipe(
      Effect.mapError(
        (cause) =>
          new Error(`Invalid model selection payload. Expected { instanceId, model, options? }.`, {
            cause,
          }),
      ),
    );
  });

const readProjectScriptsPayload = (input: {
  readonly payload: Option.Option<string>;
  readonly file: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const raw = yield* readJsonPayload(input);
    return yield* decodeProjectScripts(raw).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            "Invalid scripts payload. Expected an array of { id, name, command, icon, runOnWorktreeCreate }.",
            { cause },
          ),
      ),
    );
  });

const requireYes = (confirmed: boolean, message: string) =>
  confirmed ? Effect.void : Effect.fail(new Error(`${message} Re-run with --yes to confirm.`));

const readWriteFileContents = (input: {
  readonly content: Option.Option<string>;
  readonly file: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    if (Option.isSome(input.content) && Option.isSome(input.file)) {
      return yield* Effect.fail(new Error("Use either --content or --file, not both."));
    }
    const content = Option.getOrUndefined(input.content);
    if (content !== undefined) return content;
    const file = Option.getOrUndefined(input.file);
    if (file === undefined) {
      return yield* Effect.fail(new Error("Provide --content or --file."));
    }
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

const modelProviderFlag = Flag.string("provider").pipe(
  Flag.withDescription("Provider instance id for model selection."),
  Flag.optional,
);
const modelFlag = Flag.string("model").pipe(Flag.withDescription("Model slug."), Flag.optional);
const modelPayloadFlag = Flag.string("model-payload").pipe(
  Flag.withDescription("Full modelSelection JSON payload."),
  Flag.optional,
);
const modelPayloadFileFlag = Flag.string("model-payload-file").pipe(
  Flag.withDescription("Path to a full modelSelection JSON payload."),
  Flag.optional,
);
const reasoningFlag = Flag.string("reasoning").pipe(
  Flag.withDescription("Provider reasoning option value."),
  Flag.optional,
);
const thinkingFlag = Flag.boolean("thinking").pipe(
  Flag.withDescription("Enable provider thinking option."),
  Flag.optional,
);
const effortFlag = Flag.string("effort").pipe(
  Flag.withDescription("Provider effort option value."),
  Flag.optional,
);
const fastModeFlag = Flag.boolean("fast-mode").pipe(
  Flag.withDescription("Enable provider fast mode option."),
  Flag.optional,
);

const runtimeModeFlag = Flag.choice("runtime-mode", [
  "approval-required",
  "auto-accept-edits",
  "full-access",
]).pipe(Flag.withDefault("full-access"));
const interactionModeFlag = Flag.choice("interaction-mode", ["default", "plan"]).pipe(
  Flag.withDefault("default"),
);

type ModelSelectionFlags = {
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly modelPayload: Option.Option<string>;
  readonly modelPayloadFile: Option.Option<string>;
  readonly reasoning: Option.Option<string>;
  readonly thinking: Option.Option<boolean>;
  readonly effort: Option.Option<string>;
  readonly fastMode: Option.Option<boolean>;
};

const modelSelectionFlags = {
  provider: modelProviderFlag,
  model: modelFlag,
  modelPayload: modelPayloadFlag,
  modelPayloadFile: modelPayloadFileFlag,
  reasoning: reasoningFlag,
  thinking: thinkingFlag,
  effort: effortFlag,
  fastMode: fastModeFlag,
} as const;

// Resolve the default model for a new chat from the canonical source of truth:
// the project's configured default, falling back to the server bootstrap default.
// Avoids a divergent CLI-only hard-coded model that may not match the project.
const resolveDefaultModelSelectionForProject = (project: ActiveProject): ModelSelection =>
  project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();

const buildModelSelectionFromFlags = (flags: ModelSelectionFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.modelPayload) || Option.isSome(flags.modelPayloadFile)) {
      return Option.some(
        yield* readModelSelectionPayload({
          payload: flags.modelPayload,
          file: flags.modelPayloadFile,
        }),
      );
    }

    const model = Option.getOrUndefined(flags.model);
    if (model === undefined) {
      return Option.none<ModelSelection>();
    }

    const options: Array<NonNullable<ModelSelection["options"]>[number]> = [];
    const reasoning = Option.getOrUndefined(flags.reasoning);
    if (reasoning !== undefined) options.push({ id: "reasoning", value: reasoning });
    const thinking = Option.getOrUndefined(flags.thinking);
    if (thinking === true) options.push({ id: "thinking", value: true });
    const effort = Option.getOrUndefined(flags.effort);
    if (effort !== undefined) options.push({ id: "effort", value: effort });
    const fastMode = Option.getOrUndefined(flags.fastMode);
    if (fastMode === true) options.push({ id: "fastMode", value: true });

    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make(Option.getOrElse(flags.provider, () => "codex")),
      model,
      ...(options.length > 0 ? { options } : {}),
    };
    return Option.some(selection);
  });

const resolveModelSelectionWithDefault = Effect.fn("resolveModelSelectionWithDefault")(function* (
  flags: ModelSelectionFlags,
  fallback: ModelSelection,
) {
  const explicit = yield* buildModelSelectionFromFlags(flags);
  return Option.getOrElse(explicit, () => fallback);
});

const requireExplicitModelSelection = Effect.fn("requireExplicitModelSelection")(function* (
  flags: ModelSelectionFlags,
) {
  const explicit = yield* buildModelSelectionFromFlags(flags);
  if (Option.isNone(explicit)) {
    return yield* Effect.fail(
      new Error(
        "Provide a model with --model (and optional --provider/--reasoning/...) or --model-payload/--model-payload-file.",
      ),
    );
  }
  return explicit.value;
});

const callWsRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  run: Parameters<typeof withLiveRpcClient<A, E, R>>[1],
) => withLiveRpcClient(flags, run);

const nullableFlagValue = (
  value: Option.Option<string>,
  clear: boolean,
): string | null | undefined => {
  if (clear) return null;
  return Option.getOrUndefined(value);
};

const projectListCommand = Command.make("list", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("List active projects."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      yield* printJson(activeProjectsOf(snapshot).map(projectSummary));
    }),
  ),
);

const projectShowCommand = Command.make("show", {
  ...liveTargetFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
}).pipe(
  Command.withDescription("Show a project."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      const project = yield* findProjectForCli(snapshot, flags.project);
      yield* printJson({
        ...project,
        threads: snapshot.threads.filter(
          (thread) => thread.projectId === project.id && thread.deletedAt === null,
        ),
      });
    }),
  ),
);

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  offline: offlineFlag,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* Effect.fail(
            new Error(`An active project already exists for '${workspaceRoot}'.`),
          );
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(crypto.randomUUID());
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          title,
          workspaceRoot,
          defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
          createdAt: new Date().toISOString(),
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
      { forceOffline: flags.offline },
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  offline: offlineFlag,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
      { forceOffline: flags.offline },
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  offline: offlineFlag,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
      { forceOffline: flags.offline },
    ),
  ),
);

const projectSetDefaultModelCommand = Command.make("set-default-model", {
  ...projectLocationFlags,
  offline: offlineFlag,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  clear: Flag.boolean("clear").pipe(Flag.withDefault(false)),
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Set or clear a project's default model selection."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectSetDefaultModelMutation")(function* ({ snapshot, dispatch }) {
        const project = yield* findProjectForCli(snapshot, flags.project);
        const defaultModelSelection = flags.clear
          ? null
          : yield* readModelSelectionPayload({
              payload: flags.payload,
              file: flags.payloadFile,
            });
        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
          defaultModelSelection,
        });
        return `Updated default model for project ${project.id}.`;
      }),
      { forceOffline: flags.offline },
    ),
  ),
);

const projectSetScriptsCommand = Command.make("set-scripts", {
  ...projectLocationFlags,
  offline: offlineFlag,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Replace a project's scripts from a JSON array."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectSetScriptsMutation")(function* ({ snapshot, dispatch }) {
        const project = yield* findProjectForCli(snapshot, flags.project);
        const scripts = yield* readProjectScriptsPayload({
          payload: flags.payload,
          file: flags.payloadFile,
        });
        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
          scripts,
        });
        return `Updated scripts for project ${project.id}.`;
      }),
      { forceOffline: flags.offline },
    ),
  ),
);

const projectSearchCommand = Command.make("search", {
  ...liveTargetFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  query: Argument.string("query").pipe(Argument.withDescription("Entry search query.")),
  limit: Flag.integer("limit").pipe(Flag.withDefault(50)),
}).pipe(
  Command.withDescription("Search project files and directories."),
  Command.withHandler((flags) =>
    withProjectRpc(flags, flags.project, ({ project, client }) =>
      Effect.gen(function* () {
        const result = yield* client[WS_METHODS.projectsSearchEntries]({
          cwd: project.workspaceRoot,
          query: flags.query,
          limit: flags.limit,
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const projectBrowseCommand = Command.make("browse", {
  ...liveTargetFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  path: Argument.string("path").pipe(Argument.optional),
}).pipe(
  Command.withDescription("Browse filesystem entries under a project."),
  Command.withHandler((flags) =>
    withProjectRpc(flags, flags.project, ({ project, client }) =>
      Effect.gen(function* () {
        const result = yield* client[WS_METHODS.filesystemBrowse]({
          cwd: project.workspaceRoot,
          partialPath: Option.getOrElse(flags.path, () => "."),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const projectWriteFileCommand = Command.make("write-file", {
  ...liveTargetFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  path: Argument.string("path").pipe(Argument.withDescription("Relative path to write.")),
  content: Flag.string("content").pipe(Flag.optional),
  file: Flag.string("file").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Write a file in a project workspace."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const contents = yield* readWriteFileContents({
        content: flags.content,
        file: flags.file,
      });
      yield* withProjectRpc(flags, flags.project, ({ project, client }) =>
        Effect.gen(function* () {
          const result = yield* client[WS_METHODS.projectsWriteFile]({
            cwd: project.workspaceRoot,
            relativePath: flags.path,
            contents,
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const projectOpenCommand = Command.make("open", {
  ...liveTargetFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  editor: Flag.string("editor").pipe(Flag.withDefault("cursor")),
}).pipe(
  Command.withDescription("Open a project in an editor."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const editor = yield* decodeEditorId(flags.editor).pipe(
        Effect.mapError((cause) => new Error(`Invalid editor id: ${flags.editor}`, { cause })),
      );
      yield* withProjectRpc(flags, flags.project, ({ project, client }) =>
        Effect.gen(function* () {
          yield* client[WS_METHODS.shellOpenInEditor]({
            cwd: project.workspaceRoot,
            editor,
          });
          yield* printJson({ opened: true, projectId: project.id, editor });
        }),
      );
    }),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectListCommand,
    projectShowCommand,
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectSetDefaultModelCommand,
    projectSetScriptsCommand,
    projectSearchCommand,
    projectBrowseCommand,
    projectWriteFileCommand,
    projectOpenCommand,
  ]),
);

const serverConfigCommand = Command.make("config", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print server configuration."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson(config);
    }),
  ),
);

const serverLifecycleCommand = Command.make("lifecycle", {
  ...liveTargetFlags,
  watch: Flag.boolean("watch").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Print or watch server lifecycle events."),
  Command.withHandler((flags) => {
    const run = withLiveRpcClient(flags, (client) => {
      const stream = client[WS_METHODS.subscribeServerLifecycle]({}).pipe(
        Stream.map((event) => JSON.stringify(event, null, 2)),
        flags.watch ? (self) => self : Stream.take(1),
      );
      return Stream.runForEach(stream, (line) => Console.log(line));
    });
    return flags.watch ? runReconnectingStream("server lifecycle", run) : run;
  }),
);

const serverCommand = Command.make("server").pipe(
  Command.withDescription("Inspect a running T3 server."),
  Command.withSubcommands([serverConfigCommand, serverLifecycleCommand]),
);

const chatListCommand = Command.make("list", {
  ...liveTargetFlags,
  project: Flag.string("project").pipe(Flag.optional),
}).pipe(
  Command.withDescription("List active chats."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      const project = Option.isSome(flags.project)
        ? yield* findProjectForCli(snapshot, flags.project.value)
        : null;
      const threads = activeThreadsOf(snapshot).filter((thread) =>
        project === null ? true : thread.projectId === project.id,
      );
      yield* printJson(threads.map(threadSummary));
    }),
  ),
);

const chatShowCommand = Command.make("show", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  messages: Flag.boolean("messages").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Show a chat."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      const thread = yield* findThreadForCli(snapshot, flags.chat, { includeArchived: true });
      yield* printJson(flags.messages ? thread : threadSummary(thread));
    }),
  ),
);

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonRecordPayload = (input: {
  readonly payload: Option.Option<string>;
  readonly file: Option.Option<string>;
  readonly label: string;
}) =>
  Effect.gen(function* () {
    const raw = yield* readJsonPayload({ payload: input.payload, file: input.file });
    if (!isJsonRecord(raw)) {
      return yield* Effect.fail(new Error(`${input.label} must be a JSON object.`));
    }
    return raw;
  });

const readStringArrayJson = (raw: string, label: string) =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error(`${label} must be a JSON string array.`);
      }
      return parsed as Array<string>;
    },
    catch: (cause) => new CliPayloadError({ message: `Invalid ${label}.`, cause }),
  });

const getPayloadRequestId = (payload: unknown): string | undefined => {
  if (!isJsonRecord(payload)) return undefined;
  const requestId = payload.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
};

const pendingActivitiesFor = (input: {
  readonly thread: CliThread;
  readonly requestedKind: string;
  readonly resolvedKind: string;
}) => {
  const resolvedRequestIds = new Set(
    input.thread.activities
      .filter((activity) => activity.kind === input.resolvedKind)
      .map((activity) => getPayloadRequestId(activity.payload))
      .filter((requestId): requestId is string => requestId !== undefined),
  );
  return input.thread.activities
    .filter((activity) => activity.kind === input.requestedKind)
    .filter((activity) => {
      const requestId = getPayloadRequestId(activity.payload);
      return requestId !== undefined && !resolvedRequestIds.has(requestId);
    })
    .map((activity) => ({
      threadId: input.thread.id,
      threadTitle: input.thread.title,
      requestId: getPayloadRequestId(activity.payload),
      turnId: activity.turnId,
      summary: activity.summary,
      payload: activity.payload,
      createdAt: activity.createdAt,
    }));
};

const updateServerSettings = (flags: CliLiveTargetFlags, patch: ServerSettingsPatch) =>
  callWsRpc(flags, (client) => client[WS_METHODS.serverUpdateSettings]({ patch }));

const getServerSettings = (flags: CliLiveTargetFlags) =>
  callWsRpc(flags, (client) => client[WS_METHODS.serverGetSettings]({}));

const parseEnvironmentAssignments = (
  values: ReadonlyArray<string>,
): Effect.Effect<Array<ProviderInstanceEnvironmentVariable>, Error> =>
  Effect.gen(function* () {
    const parsed: Array<ProviderInstanceEnvironmentVariable> = [];
    for (const entry of values) {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        return yield* Effect.fail(new Error(`Invalid --env '${entry}'. Expected NAME=value.`));
      }
      parsed.push({
        name: entry.slice(0, separatorIndex),
        value: entry.slice(separatorIndex + 1),
        sensitive: false,
      });
    }
    return parsed;
  });

// Merge environment variable groups, normalizing by name so later groups replace
// earlier entries instead of accumulating duplicates. Insertion order is stable:
// re-setting an existing name updates its value in place.
const mergeEnvironmentVariablesByName = (
  ...groups: ReadonlyArray<ReadonlyArray<ProviderInstanceEnvironmentVariable>>
): Array<ProviderInstanceEnvironmentVariable> => {
  const byName = new Map<string, ProviderInstanceEnvironmentVariable>();
  for (const group of groups) {
    for (const variable of group) {
      byName.set(variable.name, variable);
    }
  }
  return [...byName.values()];
};

const chatArchivedCommand = Command.make("archived", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("List archived chats."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* withLiveRpcClient(flags, (client) =>
        client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}),
      );
      yield* printJson(snapshot.threads);
    }),
  ),
);

const chatCreateCommand = Command.make("create", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id, title, or workspace root."),
  ),
  title: Flag.string("title").pipe(Flag.withDefault("New chat")),
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
  branch: Flag.string("branch").pipe(Flag.optional),
  worktree: Flag.string("worktree").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Create a chat."),
  Command.withHandler((flags) =>
    withLiveOrchestrationClient(flags, ({ getSnapshot, dispatch }) =>
      Effect.gen(function* () {
        const snapshot = yield* getSnapshot;
        const project = yield* findProjectForCli(snapshot, flags.project);
        const threadId = ThreadId.make(crypto.randomUUID());
        const modelSelection = yield* resolveModelSelectionWithDefault(
          flags,
          resolveDefaultModelSelectionForProject(project),
        );
        const result = yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          projectId: project.id,
          title: flags.title,
          modelSelection,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          branch: Option.getOrUndefined(flags.branch) ?? null,
          worktreePath: Option.getOrUndefined(flags.worktree) ?? null,
          createdAt: new Date().toISOString(),
        });
        yield* printJson({ threadId, result });
      }),
    ),
  ),
);

const chatRenameCommand = Command.make("rename", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  title: Argument.string("title").pipe(Argument.withDescription("New title.")),
}).pipe(
  Command.withDescription("Rename a chat."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          title: flags.title,
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatDeleteCommand = Command.make("delete", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Delete a chat."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatArchiveCommand = Command.make("archive", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Archive a chat."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.archive",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatUnarchiveCommand = Command.make("unarchive", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Unarchive a chat."),
  Command.withHandler((flags) =>
    withThreadDispatch(
      flags,
      flags.chat,
      ({ thread, dispatch }) =>
        Effect.gen(function* () {
          const result = yield* dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: thread.id,
          });
          yield* printJson(result);
        }),
      { includeArchived: true },
    ),
  ),
);

const chatForkCommand = Command.make("fork", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Source thread id or title.")),
  message: Flag.string("message").pipe(Flag.withDescription("Target message id.")),
}).pipe(
  Command.withDescription("Fork a chat from a message."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(crypto.randomUUID());
        const result = yield* dispatch({
          type: "thread.fork",
          commandId: CommandId.make(crypto.randomUUID()),
          sourceThreadId: thread.id,
          threadId,
          targetMessageId: MessageId.make(flags.message),
          createdAt: new Date().toISOString(),
        });
        yield* printJson({ threadId, result });
      }),
    ),
  ),
);

const chatSetModelCommand = Command.make("set-model", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Set a chat's model selection."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const modelSelection = yield* requireExplicitModelSelection(flags);
        const result = yield* dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          modelSelection,
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatSetRuntimeCommand = Command.make("set-runtime", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  runtimeMode: runtimeModeFlag,
  pending: Flag.boolean("pending").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Set a chat runtime mode."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: flags.pending ? "thread.pending-runtime-mode.set" : "thread.runtime-mode.set",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          runtimeMode: flags.runtimeMode,
          createdAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatSetInteractionCommand = Command.make("set-interaction", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  interactionMode: interactionModeFlag,
}).pipe(
  Command.withDescription("Set a chat interaction mode."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          interactionMode: flags.interactionMode,
          createdAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatSetBranchCommand = Command.make("set-branch", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  branch: Flag.string("branch").pipe(Flag.optional),
  worktree: Flag.string("worktree").pipe(Flag.optional),
  clearBranch: Flag.boolean("clear-branch").pipe(Flag.withDefault(false)),
  clearWorktree: Flag.boolean("clear-worktree").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Set chat branch/worktree metadata."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const branch = nullableFlagValue(flags.branch, flags.clearBranch);
      const worktreePath = nullableFlagValue(flags.worktree, flags.clearWorktree);
      if (branch === undefined && worktreePath === undefined) {
        return yield* Effect.fail(
          new Error("Provide --branch, --worktree, --clear-branch, or --clear-worktree."),
        );
      }
      yield* withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
        Effect.gen(function* () {
          const result = yield* dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: thread.id,
            ...(branch !== undefined ? { branch } : {}),
            ...(worktreePath !== undefined ? { worktreePath } : {}),
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const chatSendCommand = Command.make("send", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  prompt: Argument.string("prompt").pipe(Argument.withDescription("Prompt text.")),
}).pipe(
  Command.withDescription("Send a prompt to an existing chat."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const modelSelection = yield* buildModelSelectionFromFlags(flags);
        const result = yield* dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: flags.prompt,
            attachments: [],
          },
          ...(Option.isSome(modelSelection) ? { modelSelection: modelSelection.value } : {}),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatNewCommand = Command.make("new", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id, title, or workspace root."),
  ),
  title: Flag.string("title").pipe(Flag.withDefault("New chat")),
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
  branch: Flag.string("branch").pipe(Flag.optional),
  worktree: Flag.string("worktree").pipe(Flag.optional),
  prompt: Argument.string("prompt").pipe(Argument.withDescription("Prompt text.")),
}).pipe(
  Command.withDescription("Create a chat and send the first prompt."),
  Command.withHandler((flags) =>
    withLiveOrchestrationClient(flags, ({ getSnapshot, dispatch }) =>
      Effect.gen(function* () {
        const snapshot = yield* getSnapshot;
        const project = yield* findProjectForCli(snapshot, flags.project);
        const threadId = ThreadId.make(crypto.randomUUID());
        const modelSelection = yield* resolveModelSelectionWithDefault(
          flags,
          resolveDefaultModelSelectionForProject(project),
        );
        const createdAt = new Date().toISOString();
        const createResult = yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          projectId: project.id,
          title: flags.title,
          modelSelection,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          branch: Option.getOrUndefined(flags.branch) ?? null,
          worktreePath: Option.getOrUndefined(flags.worktree) ?? null,
          createdAt,
        });
        // Keep `chat new` atomic: if starting the first turn fails, roll back the
        // freshly created (empty) thread so we never leak a half-created chat.
        const turnExit = yield* Effect.exit(
          dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: flags.prompt,
              attachments: [],
            },
            modelSelection,
            titleSeed: flags.title,
            runtimeMode: flags.runtimeMode,
            interactionMode: flags.interactionMode,
            createdAt,
          }),
        );
        if (Exit.isFailure(turnExit)) {
          if (!Cause.hasInterruptsOnly(turnExit.cause)) {
            yield* dispatch({
              type: "thread.delete",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId,
            }).pipe(Effect.ignore);
          }
          return yield* Effect.failCause(turnExit.cause);
        }
        const turnResult = turnExit.value;
        yield* printJson({ threadId, createResult, turnResult });
      }),
    ),
  ),
);

const chatStreamCommand = Command.make("stream", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Stream thread events as JSON."),
  Command.withHandler((flags) =>
    runReconnectingStream(
      "chat stream",
      withThreadRpc(flags, flags.chat, ({ thread, client }) =>
        client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId: thread.id }).pipe(
          Stream.map((event) => JSON.stringify(event, null, 2)),
          Stream.runForEach((line) => Console.log(line)),
        ),
      ),
    ),
  ),
);

const chatInterruptCommand = Command.make("interrupt", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  turn: Flag.string("turn").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Interrupt a running turn."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const turn = Option.getOrUndefined(flags.turn);
        const result = yield* dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          ...(turn !== undefined ? { turnId: TurnId.make(turn) } : {}),
          createdAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatStopCommand = Command.make("stop", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("Stop a chat session."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          createdAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatQueueAddCommand = Command.make("add", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  prompt: Argument.string("prompt").pipe(Argument.withDescription("Queued prompt text.")),
}).pipe(
  Command.withDescription("Add a queued turn."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const modelSelection = yield* buildModelSelectionFromFlags(flags);
        const queuedTurnId = QueuedTurnId.make(crypto.randomUUID());
        const result = yield* dispatch({
          type: "thread.queued-turn.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          queuedTurnId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: flags.prompt,
            attachments: [],
          },
          ...(Option.isSome(modelSelection) ? { modelSelection: modelSelection.value } : {}),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        });
        yield* printJson({ queuedTurnId, result });
      }),
    ),
  ),
);

const chatQueueUpdateCommand = Command.make("update", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  queuedTurn: Argument.string("queued-turn").pipe(Argument.withDescription("Queued turn id.")),
  text: Argument.string("text").pipe(Argument.withDescription("Updated queued prompt text.")),
}).pipe(
  Command.withDescription("Update queued turn text."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.queued-turn.update",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          queuedTurnId: QueuedTurnId.make(flags.queuedTurn),
          text: flags.text,
          updatedAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatQueueDeleteCommand = Command.make("delete", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  queuedTurn: Argument.string("queued-turn").pipe(Argument.withDescription("Queued turn id.")),
}).pipe(
  Command.withDescription("Delete a queued turn."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.queued-turn.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          queuedTurnId: QueuedTurnId.make(flags.queuedTurn),
          deletedAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatQueueDispatchCommand = Command.make("dispatch", {
  ...liveTargetFlags,
  chat: Argument.string("chat").pipe(Argument.withDescription("Thread id or title.")),
  queuedTurn: Argument.string("queued-turn").pipe(Argument.withDescription("Queued turn id.")),
}).pipe(
  Command.withDescription("Dispatch a queued turn."),
  Command.withHandler((flags) =>
    withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
      Effect.gen(function* () {
        const result = yield* dispatch({
          type: "thread.queued-turn.dispatch",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          queuedTurnId: QueuedTurnId.make(flags.queuedTurn),
          dispatchedAt: new Date().toISOString(),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const chatQueueCommand = Command.make("queue").pipe(
  Command.withDescription("Manage queued turns."),
  Command.withSubcommands([
    chatQueueAddCommand,
    chatQueueUpdateCommand,
    chatQueueDeleteCommand,
    chatQueueDispatchCommand,
  ]),
);

const chatCommand = Command.make("chat").pipe(
  Command.withDescription("Manage chats."),
  Command.withSubcommands([
    chatListCommand,
    chatShowCommand,
    chatArchivedCommand,
    chatCreateCommand,
    chatRenameCommand,
    chatDeleteCommand,
    chatArchiveCommand,
    chatUnarchiveCommand,
    chatForkCommand,
    chatSetModelCommand,
    chatSetRuntimeCommand,
    chatSetInteractionCommand,
    chatSetBranchCommand,
    chatSendCommand,
    chatNewCommand,
    chatStreamCommand,
    chatInterruptCommand,
    chatStopCommand,
    chatQueueCommand,
  ]),
);

const approvalListCommand = Command.make("list", {
  ...liveTargetFlags,
  thread: Flag.string("thread").pipe(Flag.optional),
}).pipe(
  Command.withDescription("List pending approval requests."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      const threads = Option.isSome(flags.thread)
        ? [yield* findThreadForCli(snapshot, flags.thread.value)]
        : activeThreadsOf(snapshot);
      yield* printJson(
        threads.flatMap((thread) =>
          pendingActivitiesFor({
            thread,
            requestedKind: "approval.requested",
            resolvedKind: "approval.resolved",
          }),
        ),
      );
    }),
  ),
);

const approvalDecisionFlag = Flag.choice("decision", [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]).pipe(Flag.optional);
const approvalApproveFlag = Flag.boolean("approve").pipe(Flag.withDefault(false));
const approvalDenyFlag = Flag.boolean("deny").pipe(Flag.withDefault(false));

const resolveApprovalDecision = (flags: {
  readonly decision: Option.Option<ProviderApprovalDecision>;
  readonly approve: boolean;
  readonly deny: boolean;
}) => {
  if (Option.isSome(flags.decision)) {
    if (flags.approve || flags.deny) {
      return Effect.fail(new Error("Use --decision or --approve/--deny, not both."));
    }
    return Effect.succeed(flags.decision.value);
  }
  if (flags.approve && flags.deny) {
    return Effect.fail(new Error("Use either --approve or --deny, not both."));
  }
  if (flags.approve) return Effect.succeed("accept" as const);
  if (flags.deny) return Effect.succeed("decline" as const);
  return Effect.fail(new Error("Provide --approve, --deny, or --decision."));
};

const approvalRespondCommand = Command.make("respond", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  request: Argument.string("request-id").pipe(Argument.withDescription("Approval request id.")),
  decision: approvalDecisionFlag,
  approve: approvalApproveFlag,
  deny: approvalDenyFlag,
}).pipe(
  Command.withDescription("Respond to an approval request."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const decision = yield* resolveApprovalDecision(flags);
      yield* withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
        Effect.gen(function* () {
          const result = yield* dispatch({
            type: "thread.approval.respond",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: thread.id,
            requestId: ApprovalRequestId.make(flags.request),
            decision,
            createdAt: new Date().toISOString(),
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const approvalCommand = Command.make("approval").pipe(
  Command.withDescription("Manage pending approvals."),
  Command.withSubcommands([approvalListCommand, approvalRespondCommand]),
);

const inputListCommand = Command.make("list", {
  ...liveTargetFlags,
  thread: Flag.string("thread").pipe(Flag.optional),
}).pipe(
  Command.withDescription("List pending user-input requests."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      const threads = Option.isSome(flags.thread)
        ? [yield* findThreadForCli(snapshot, flags.thread.value)]
        : activeThreadsOf(snapshot);
      yield* printJson(
        threads.flatMap((thread) =>
          pendingActivitiesFor({
            thread,
            requestedKind: "user-input.requested",
            resolvedKind: "user-input.resolved",
          }),
        ),
      );
    }),
  ),
);

const inputRespondCommand = Command.make("respond", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  request: Argument.string("request-id").pipe(Argument.withDescription("User-input request id.")),
  answers: Flag.string("answers").pipe(Flag.withDescription("JSON object of answers.")),
  answersFile: Flag.string("answers-file").pipe(
    Flag.withDescription("Path to a JSON object of answers."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Respond to a user-input request."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const answers = yield* readJsonRecordPayload({
        payload: Option.some(flags.answers),
        file: flags.answersFile,
        label: "Answers",
      });
      yield* withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
        Effect.gen(function* () {
          const result = yield* dispatch({
            type: "thread.user-input.respond",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: thread.id,
            requestId: ApprovalRequestId.make(flags.request),
            answers,
            createdAt: new Date().toISOString(),
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const inputCommand = Command.make("input").pipe(
  Command.withDescription("Manage provider user-input requests."),
  Command.withSubcommands([inputListCommand, inputRespondCommand]),
);

const providerSelectorFlag = Flag.string("provider").pipe(
  Flag.withDescription("Provider instance id or driver."),
  Flag.optional,
);

const filterProviders = (
  providers: ReadonlyArray<ServerProvider>,
  selector: Option.Option<string>,
) => {
  const raw = Option.getOrUndefined(selector);
  if (raw === undefined) return providers;
  return providers.filter((provider) => provider.instanceId === raw || provider.driver === raw);
};

const modelListCommand = Command.make("list", {
  ...liveTargetFlags,
  provider: providerSelectorFlag,
}).pipe(
  Command.withDescription("List available models."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* callWsRpc(flags, (client) => client[WS_METHODS.serverGetConfig]({}));
      yield* printJson(
        filterProviders(config.providers, flags.provider).flatMap((provider) =>
          provider.models.map((model) => ({
            provider: provider.instanceId,
            driver: provider.driver,
            ...model,
          })),
        ),
      );
    }),
  ),
);

const modelOptionsCommand = Command.make("options", {
  ...liveTargetFlags,
  provider: Argument.string("provider").pipe(
    Argument.withDescription("Provider instance id or driver."),
  ),
  model: Argument.string("model").pipe(Argument.withDescription("Model slug.")),
}).pipe(
  Command.withDescription("List model option descriptors."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* callWsRpc(flags, (client) => client[WS_METHODS.serverGetConfig]({}));
      const provider = filterProviders(config.providers, Option.some(flags.provider))[0];
      if (!provider) {
        return yield* Effect.fail(new Error(`No provider found for '${flags.provider}'.`));
      }
      const model = provider.models.find((candidate) => candidate.slug === flags.model);
      if (!model) {
        return yield* Effect.fail(
          new Error(`No model '${flags.model}' found for provider '${flags.provider}'.`),
        );
      }
      yield* printJson(model.capabilities?.optionDescriptors ?? []);
    }),
  ),
);

const modelDefaultGetCommand = Command.make("get", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print the default text-generation model selection."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* getServerSettings(flags);
      yield* printJson(settings.textGenerationModelSelection);
    }),
  ),
);

const modelDefaultSetCommand = Command.make("set", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
}).pipe(
  Command.withDescription("Set the default text-generation model selection."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const modelSelection = yield* requireExplicitModelSelection(flags);
      const settings = yield* updateServerSettings(flags, {
        textGenerationModelSelection: modelSelection,
      });
      yield* printJson(settings.textGenerationModelSelection);
    }),
  ),
);

const modelDefaultCommand = Command.make("default").pipe(
  Command.withDescription("Manage default model selection."),
  Command.withSubcommands([modelDefaultGetCommand, modelDefaultSetCommand]),
);

const modelCommand = Command.make("model").pipe(
  Command.withDescription("Inspect and configure models."),
  Command.withSubcommands([modelListCommand, modelOptionsCommand, modelDefaultCommand]),
);

const turnCountArgument = Argument.integer("turn").pipe(
  Argument.withDescription("1-based turn count."),
);
const turnCountFlag = Flag.integer("turn").pipe(Flag.optional);
const ignoreWhitespaceFlag = Flag.boolean("ignore-whitespace").pipe(Flag.withDefault(false));

// The diff RPCs interpret `toTurnCount` as a checkpoint turn count, matched
// server-side against `checkpoint.checkpointTurnCount`. Derive the latest turn
// count from the maximum checkpoint turn count (mirroring the server) rather
// than `checkpoints.length`, which diverges whenever turn counts are
// non-contiguous (e.g. after a revert prunes later checkpoints).
const latestCheckpointTurnCount = (thread: CliThread): number =>
  thread.checkpoints.reduce((max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount), 0);

const diffTurnCommand = Command.make("turn", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  turn: turnCountArgument,
  scope: Flag.choice("scope", ["turn", "snapshot"]).pipe(Flag.withDefault("snapshot")),
  ignoreWhitespace: ignoreWhitespaceFlag,
}).pipe(
  Command.withDescription("Get a turn diff."),
  Command.withHandler((flags) =>
    withThreadRpc(flags, flags.chat, ({ thread, client }) =>
      Effect.gen(function* () {
        const result = yield* client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
          threadId: thread.id,
          fromTurnCount: Math.max(0, flags.turn - 1),
          toTurnCount: flags.turn,
          scope: flags.scope,
          ...(flags.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const diffThreadCommand = Command.make("thread", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  toTurn: Flag.integer("to-turn").pipe(Flag.optional),
  ignoreWhitespace: ignoreWhitespaceFlag,
}).pipe(
  Command.withDescription("Get the full thread diff."),
  Command.withHandler((flags) =>
    withThreadRpc(flags, flags.chat, ({ thread, client }) =>
      Effect.gen(function* () {
        const toTurnCount =
          Option.getOrUndefined(flags.toTurn) ?? latestCheckpointTurnCount(thread);
        const result = yield* client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
          threadId: thread.id,
          toTurnCount,
          ...(flags.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const diffStateCommand = Command.make("state", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  turn: turnCountFlag,
  scope: Flag.choice("scope", ["turn", "snapshot"]).pipe(Flag.withDefault("snapshot")),
  ignoreWhitespace: ignoreWhitespaceFlag,
}).pipe(
  Command.withDescription("Get diff loading/error/state metadata."),
  Command.withHandler((flags) =>
    withThreadRpc(flags, flags.chat, ({ thread, client }) =>
      Effect.gen(function* () {
        const turn = Option.getOrUndefined(flags.turn);
        const result =
          turn === undefined
            ? yield* client[ORCHESTRATION_WS_METHODS.getFullThreadDiffState]({
                threadId: thread.id,
                toTurnCount: latestCheckpointTurnCount(thread),
                ...(flags.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
              })
            : yield* client[ORCHESTRATION_WS_METHODS.getTurnDiffState]({
                threadId: thread.id,
                fromTurnCount: Math.max(0, turn - 1),
                toTurnCount: turn,
                scope: flags.scope,
                ...(flags.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
              });
        yield* printJson(result);
      }),
    ),
  ),
);

const diffCommand = Command.make("diff").pipe(
  Command.withDescription("Inspect thread diffs."),
  Command.withSubcommands([diffTurnCommand, diffThreadCommand, diffStateCommand]),
);

const checkpointListCommand = Command.make("list", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
}).pipe(
  Command.withDescription("List thread checkpoints."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadForCli(flags, flags.chat);
      yield* printJson(thread.checkpoints);
    }),
  ),
);

const checkpointRevertCommand = Command.make("revert", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  turnCount: Flag.integer("turn-count").pipe(Flag.withDescription("Checkpoint turn count.")),
  yes: yesFlag,
}).pipe(
  Command.withDescription("Request checkpoint revert."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireYes(flags.yes, "Checkpoint revert can discard later work.");
      yield* withThreadDispatch(flags, flags.chat, ({ thread, dispatch }) =>
        Effect.gen(function* () {
          const result = yield* dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId: thread.id,
            turnCount: flags.turnCount,
            createdAt: new Date().toISOString(),
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const checkpointCommand = Command.make("checkpoint").pipe(
  Command.withDescription("Manage checkpoints."),
  Command.withSubcommands([checkpointListCommand, checkpointRevertCommand]),
);

const exportMarkdownCommand = Command.make("markdown", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  editor: Flag.string("editor").pipe(Flag.withDefault("cursor")),
}).pipe(
  Command.withDescription("Export a thread as markdown."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const editor = yield* decodeEditorId(flags.editor).pipe(
        Effect.mapError((cause) => new Error(`Invalid editor id: ${flags.editor}`, { cause })),
      );
      yield* withThreadRpc(flags, flags.chat, ({ thread, client }) =>
        Effect.gen(function* () {
          const result = yield* client[WS_METHODS.serverExportThreadMarkdown]({
            threadId: thread.id,
            editor,
          });
          yield* printJson(result);
        }),
      );
    }),
  ),
);

const exportCommand = Command.make("export").pipe(
  Command.withDescription("Export chat artifacts."),
  Command.withSubcommands([exportMarkdownCommand]),
);

const providerListCommand = Command.make("list", {
  ...liveTargetFlags,
  provider: providerSelectorFlag,
}).pipe(
  Command.withDescription("List provider instances."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson(filterProviders(config.providers, flags.provider));
    }),
  ),
);

const providerStatusCommand = Command.make("status", {
  ...liveTargetFlags,
  provider: providerSelectorFlag,
}).pipe(
  Command.withDescription("Print provider status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson(
        filterProviders(config.providers, flags.provider).map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName,
          enabled: provider.enabled,
          installed: provider.installed,
          status: provider.status,
          auth: provider.auth,
          version: provider.version,
          message: provider.message,
          checkedAt: provider.checkedAt,
        })),
      );
    }),
  ),
);

const providerModelsCommand = Command.make("models", {
  ...liveTargetFlags,
  provider: providerSelectorFlag,
}).pipe(
  Command.withDescription("List provider models."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson(
        filterProviders(config.providers, flags.provider).map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          models: provider.models,
        })),
      );
    }),
  ),
);

const providerOptionsCommand = Command.make("options", {
  ...liveTargetFlags,
  provider: Argument.string("provider").pipe(
    Argument.withDescription("Provider instance id or driver."),
  ),
  model: Argument.string("model").pipe(Argument.withDescription("Model slug.")),
}).pipe(
  Command.withDescription("List model option descriptors."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      const provider = filterProviders(config.providers, Option.some(flags.provider))[0];
      if (!provider) {
        return yield* Effect.fail(new Error(`No provider found for '${flags.provider}'.`));
      }
      const model = provider.models.find((candidate) => candidate.slug === flags.model);
      if (!model) {
        return yield* Effect.fail(
          new Error(`No model '${flags.model}' found for provider '${flags.provider}'.`),
        );
      }
      yield* printJson(model.capabilities?.optionDescriptors ?? []);
    }),
  ),
);

const providerRefreshCommand = Command.make("refresh", {
  ...liveTargetFlags,
  provider: Flag.string("provider").pipe(
    Flag.withDescription("Provider instance id to refresh. Omit to refresh all."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Refresh provider status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverRefreshProviders]({
          ...(Option.isSome(flags.provider)
            ? { instanceId: ProviderInstanceId.make(flags.provider.value) }
            : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const providerCommandsCommand = Command.make("commands", {
  ...liveTargetFlags,
  provider: Argument.string("provider").pipe(Argument.withDescription("Provider driver.")),
  cwd: Flag.string("cwd").pipe(Flag.withDefault(process.cwd())),
}).pipe(
  Command.withDescription("List provider slash commands for a workspace."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverListProviderCommands]({
          provider: ProviderDriverKind.make(flags.provider),
          cwd: flags.cwd,
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const updateProviderInstance = (input: {
  readonly flags: CliLiveTargetFlags;
  readonly instanceId: string;
  readonly update: (current: ProviderInstanceConfig | undefined) => ProviderInstanceConfig | null;
}) =>
  withLiveRpcClient(input.flags, (client) =>
    Effect.gen(function* () {
      const settings = yield* client[WS_METHODS.serverGetSettings]({});
      const instanceId = ProviderInstanceId.make(input.instanceId);
      const current = settings.providerInstances[instanceId];
      const next = input.update(current);
      // Send a targeted upsert/remove (not a whole-map replace) so the server
      // applies it atomically against the freshest settings under its write
      // lock; this prevents clobbering concurrent edits to other instances.
      return yield* client[WS_METHODS.serverUpdateSettings]({
        patch: { providerInstanceMutations: [{ instanceId, config: next }] },
      });
    }),
  );

const providerEnableCommand = Command.make("enable", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
}).pipe(
  Command.withDescription("Enable a provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: (current) => ({
          ...(current ?? { driver: ProviderDriverKind.make(flags.instance) }),
          enabled: true,
        }),
      });
      yield* printJson(settings.providerInstances);
    }),
  ),
);

const providerDisableCommand = Command.make("disable", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
}).pipe(
  Command.withDescription("Disable a provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: (current) => ({
          ...(current ?? { driver: ProviderDriverKind.make(flags.instance) }),
          enabled: false,
        }),
      });
      yield* printJson(settings.providerInstances);
    }),
  ),
);

const providerSetCommand = Command.make("set", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
  driver: Flag.string("driver").pipe(Flag.withDescription("Provider driver."), Flag.optional),
  displayName: Flag.string("display-name").pipe(Flag.optional),
  accentColor: Flag.string("accent-color").pipe(Flag.optional),
  binaryPath: Flag.string("binary-path").pipe(Flag.optional),
  customModels: Flag.string("custom-models").pipe(
    Flag.withDescription("JSON string array of custom model slugs."),
    Flag.optional,
  ),
  env: Flag.string("env").pipe(
    Flag.withDescription(
      "Environment assignment NAME=value. Repeatable; later values replace earlier ones by name.",
    ),
    Flag.atLeast(0),
  ),
  envJson: Flag.string("env-json").pipe(
    Flag.withDescription("JSON object of environment variables."),
    Flag.optional,
  ),
  config: Flag.string("config").pipe(
    Flag.withDescription("Provider-specific config JSON object."),
    Flag.optional,
  ),
  enabled: Flag.boolean("enabled").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Create or update a provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const customModels = Option.isSome(flags.customModels)
        ? yield* readStringArrayJson(flags.customModels.value, "--custom-models")
        : undefined;
      const envFromJson = Option.isSome(flags.envJson)
        ? yield* readJsonRecordPayload({
            payload: flags.envJson,
            file: Option.none(),
            label: "--env-json",
          })
        : undefined;
      const envFromAssignment = yield* parseEnvironmentAssignments(flags.env);
      const environmentFromJson =
        envFromJson === undefined
          ? []
          : Object.entries(envFromJson).map(([name, value]) => ({
              name,
              value: typeof value === "string" ? value : JSON.stringify(value),
              sensitive: false,
            }));
      const config = Option.isSome(flags.config)
        ? yield* readJsonRecordPayload({
            payload: flags.config,
            file: Option.none(),
            label: "--config",
          })
        : undefined;
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: (current) => {
          const mergedConfig = {
            ...(isJsonRecord(current?.config) ? current.config : {}),
            ...(config ?? {}),
            ...(Option.isSome(flags.binaryPath) ? { binaryPath: flags.binaryPath.value } : {}),
            ...(customModels !== undefined ? { customModels } : {}),
          };
          return {
            ...(current ?? {
              driver: ProviderDriverKind.make(Option.getOrElse(flags.driver, () => flags.instance)),
            }),
            ...(Option.isSome(flags.driver)
              ? { driver: ProviderDriverKind.make(flags.driver.value) }
              : {}),
            ...(Option.isSome(flags.displayName) ? { displayName: flags.displayName.value } : {}),
            ...(Option.isSome(flags.accentColor) ? { accentColor: flags.accentColor.value } : {}),
            ...(Option.isSome(flags.enabled) ? { enabled: flags.enabled.value } : {}),
            ...(envFromAssignment.length + environmentFromJson.length > 0
              ? {
                  environment: mergeEnvironmentVariablesByName(
                    current?.environment ?? [],
                    environmentFromJson,
                    envFromAssignment,
                  ),
                }
              : {}),
            ...(Object.keys(mergedConfig).length > 0 ? { config: mergedConfig } : {}),
          };
        },
      });
      yield* printJson(settings.providerInstances[ProviderInstanceId.make(flags.instance)]);
    }),
  ),
);

const providerInstanceListCommand = Command.make("list", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("List configured provider instances."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* getServerSettings(flags);
      yield* printJson(settings.providerInstances);
    }),
  ),
);

const providerInstanceAddCommand = Command.make("add", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
  driver: Flag.string("driver").pipe(Flag.withDescription("Provider driver.")),
  displayName: Flag.string("display-name").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Add a provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: (current) => {
          if (current !== undefined) {
            throw new Error(`Provider instance '${flags.instance}' already exists.`);
          }
          return {
            driver: ProviderDriverKind.make(flags.driver),
            ...(Option.isSome(flags.displayName) ? { displayName: flags.displayName.value } : {}),
            enabled: true,
          };
        },
      });
      yield* printJson(settings.providerInstances[ProviderInstanceId.make(flags.instance)]);
    }),
  ),
);

const providerInstanceUpdateCommand = Command.make("update", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Replace a provider instance from a JSON object."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const payload = yield* readJsonRecordPayload({
        payload: flags.payload,
        file: flags.payloadFile,
        label: "Provider instance",
      });
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: () => ({
          ...payload,
          driver:
            typeof payload.driver === "string"
              ? ProviderDriverKind.make(payload.driver)
              : ProviderDriverKind.make(flags.instance),
        }),
      });
      yield* printJson(settings.providerInstances[ProviderInstanceId.make(flags.instance)]);
    }),
  ),
);

const providerInstanceRemoveCommand = Command.make("remove", {
  ...liveTargetFlags,
  instance: Argument.string("instance").pipe(Argument.withDescription("Provider instance id.")),
  yes: yesFlag,
}).pipe(
  Command.withDescription("Remove a provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireYes(
        flags.yes,
        "Removing a provider instance may break saved model selections.",
      );
      const settings = yield* updateProviderInstance({
        flags,
        instanceId: flags.instance,
        update: () => null,
      });
      yield* printJson(settings.providerInstances);
    }),
  ),
);

const providerInstanceCommand = Command.make("instance").pipe(
  Command.withDescription("Manage provider instances."),
  Command.withSubcommands([
    providerInstanceListCommand,
    providerInstanceAddCommand,
    providerInstanceUpdateCommand,
    providerInstanceRemoveCommand,
  ]),
);

const providerCommand = Command.make("provider").pipe(
  Command.withDescription("Inspect and configure providers."),
  Command.withSubcommands([
    providerListCommand,
    providerStatusCommand,
    providerModelsCommand,
    providerOptionsCommand,
    providerRefreshCommand,
    providerCommandsCommand,
    providerEnableCommand,
    providerDisableCommand,
    providerSetCommand,
    providerInstanceCommand,
  ]),
);

const cwdFlag = Flag.string("cwd").pipe(Flag.withDefault(process.cwd()));
const queryFlag = Flag.string("query").pipe(Flag.optional);
const limitFlag = Flag.integer("limit").pipe(Flag.optional);
const forceFlag = Flag.boolean("force").pipe(Flag.withDefault(false));
const reviewScopeFlag = Flag.choice("scope", ["uncommitted", "against-base"]).pipe(Flag.optional);

const gitStatusCommand = Command.make("status", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Print Git status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitRefreshStatus]({ cwd: flags.cwd }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitWatchCommand = Command.make("watch", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Watch Git status events."),
  Command.withHandler((flags) =>
    runReconnectingStream(
      "git watch",
      callWsRpc(flags, (client) =>
        client[WS_METHODS.subscribeGitStatus]({ cwd: flags.cwd }).pipe(
          Stream.map((event) => JSON.stringify(event, null, 2)),
          Stream.runForEach((line) => Console.log(line)),
        ),
      ),
    ),
  ),
);

const gitPullCommand = Command.make("pull", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Run git pull."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitPull]({ cwd: flags.cwd }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitBranchesCommand = Command.make("branches", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  query: queryFlag,
  limit: limitFlag,
}).pipe(
  Command.withDescription("List Git branches."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitListBranches]({
          cwd: flags.cwd,
          ...(Option.isSome(flags.query) ? { query: flags.query.value } : {}),
          ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitCreateBranchCommand = Command.make("create-branch", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  branch: Argument.string("branch").pipe(Argument.withDescription("Branch name.")),
  checkout: Flag.boolean("checkout").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Create a Git branch."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitCreateBranch]({
          cwd: flags.cwd,
          branch: flags.branch,
          ...(flags.checkout ? { checkout: true } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitCheckoutCommand = Command.make("checkout", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  branch: Argument.string("branch").pipe(Argument.withDescription("Branch name.")),
}).pipe(
  Command.withDescription("Checkout a Git branch."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitCheckout]({ cwd: flags.cwd, branch: flags.branch }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitInitCommand = Command.make("init", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Initialize a Git repository."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitInit]({ cwd: flags.cwd }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitWorktreeCreateCommand = Command.make("create", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  branch: Argument.string("branch").pipe(Argument.withDescription("Base branch.")),
  newBranch: Flag.string("new-branch").pipe(Flag.optional),
  path: Flag.string("path").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Create a Git worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitCreateWorktree]({
          cwd: flags.cwd,
          branch: flags.branch,
          ...(Option.isSome(flags.newBranch) ? { newBranch: flags.newBranch.value } : {}),
          path: Option.getOrUndefined(flags.path) ?? null,
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitWorktreeRemoveCommand = Command.make("remove", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  path: Argument.string("path").pipe(Argument.withDescription("Worktree path.")),
  force: forceFlag,
}).pipe(
  Command.withDescription("Remove a Git worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitRemoveWorktree]({
          cwd: flags.cwd,
          path: flags.path,
          ...(flags.force ? { force: true } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitWorktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("Manage Git worktrees."),
  Command.withSubcommands([gitWorktreeCreateCommand, gitWorktreeRemoveCommand]),
);

const gitPrResolveCommand = Command.make("resolve", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  reference: Argument.string("reference").pipe(Argument.withDescription("Pull request reference.")),
}).pipe(
  Command.withDescription("Resolve a pull request reference."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitResolvePullRequest]({ cwd: flags.cwd, reference: flags.reference }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitPrPrepareThreadCommand = Command.make("prepare-thread", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  reference: Argument.string("reference").pipe(Argument.withDescription("Pull request reference.")),
  mode: Flag.choice("mode", ["local", "worktree"]).pipe(Flag.withDefault("local")),
  thread: Flag.string("thread").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Prepare a thread for a pull request."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitPreparePullRequestThread]({
          cwd: flags.cwd,
          reference: flags.reference,
          mode: flags.mode,
          ...(Option.isSome(flags.thread) ? { threadId: ThreadId.make(flags.thread.value) } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const gitPrCommand = Command.make("pr").pipe(
  Command.withDescription("Manage Git pull-request helpers."),
  Command.withSubcommands([gitPrResolveCommand, gitPrPrepareThreadCommand]),
);

const gitStackedActionCommand = Command.make("stacked-action", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  action: Argument.choice("action", [
    "commit",
    "push",
    "create_pr",
    "commit_push",
    "commit_push_pr",
  ]),
  message: Flag.string("message").pipe(Flag.optional),
  featureBranch: Flag.boolean("feature-branch").pipe(Flag.withDefault(false)),
  files: Flag.string("files").pipe(
    Flag.withDescription("JSON string array of file paths to include."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Run a stacked Git action and stream progress."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePaths = Option.isSome(flags.files)
        ? yield* readStringArrayJson(flags.files.value, "--files")
        : undefined;
      yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: crypto.randomUUID(),
          cwd: flags.cwd,
          action: flags.action as GitStackedAction,
          ...(Option.isSome(flags.message) ? { commitMessage: flags.message.value } : {}),
          ...(flags.featureBranch ? { featureBranch: true } : {}),
          ...(filePaths !== undefined ? { filePaths } : {}),
        }).pipe(
          Stream.map((event) => JSON.stringify(event, null, 2)),
          Stream.runForEach((line) => Console.log(line)),
        ),
      );
    }),
  ),
);

const gitCommand = Command.make("git").pipe(
  Command.withDescription("Run Git operations through T3."),
  Command.withSubcommands([
    gitStatusCommand,
    gitWatchCommand,
    gitPullCommand,
    gitBranchesCommand,
    gitCreateBranchCommand,
    gitCheckoutCommand,
    gitInitCommand,
    gitWorktreeCommand,
    gitPrCommand,
    gitStackedActionCommand,
  ]),
);

const reviewThreadTitle = (input: {
  readonly scope: ReviewChangesScope;
  readonly baseBranch?: string;
}) =>
  input.scope === "against-base" && input.baseBranch
    ? `Review changes against ${input.baseBranch}`
    : "Review uncommitted changes";

const reviewCommand = Command.make("review", {
  ...liveTargetFlags,
  ...modelSelectionFlags,
  cwd: cwdFlag,
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id, title, or workspace root. Defaults to --cwd."),
    Flag.optional,
  ),
  scope: reviewScopeFlag,
  title: Flag.string("title").pipe(Flag.optional),
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
}).pipe(
  Command.withDescription("Create a new review chat for local code changes."),
  Command.withHandler((flags) =>
    withLiveSnapshotAndRpc(flags, ({ getSnapshot, client }) =>
      Effect.gen(function* () {
        const [snapshot, settings] = yield* Effect.all(
          [getSnapshot, client[WS_METHODS.serverGetSettings]({})],
          { concurrency: "unbounded" },
        );
        const project = yield* findProjectForCli(
          snapshot,
          Option.getOrUndefined(flags.project) ?? flags.cwd,
        );
        const workflowSettings = settings.agentWorkflows.reviewChanges;
        if (!workflowSettings.enabled) {
          return yield* Effect.fail(new Error("Review Code workflow is disabled in settings."));
        }

        const scope =
          Option.getOrUndefined(flags.scope) ??
          workflowSettings.defaultScope ??
          DEFAULT_REVIEW_CHANGES_SCOPE;
        const reviewContext = yield* client[WS_METHODS.gitResolveReviewChangesContext]({
          cwd: flags.cwd,
          scope,
        });
        const prompt = buildReviewChangesPrompt({
          context:
            reviewContext.scope === "against-base"
              ? {
                  scope: "against-base",
                  baseBranch: reviewContext.baseBranch,
                  mergeBaseSha: reviewContext.mergeBaseSha,
                }
              : { scope: "uncommitted" },
          settings: workflowSettings,
        });
        const title =
          Option.getOrUndefined(flags.title) ??
          reviewThreadTitle({
            scope: reviewContext.scope,
            ...(reviewContext.scope === "against-base"
              ? { baseBranch: reviewContext.baseBranch }
              : {}),
          });
        const modelSelection = yield* resolveModelSelectionWithDefault(
          flags,
          resolveDefaultModelSelectionForProject(project),
        );
        const threadId = ThreadId.make(crypto.randomUUID());
        const createdAt = new Date().toISOString();
        const dispatchResult = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.turn.start",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode: flags.runtimeMode,
              interactionMode: flags.interactionMode,
              branch: reviewContext.branch,
              worktreePath: flags.cwd === project.workspaceRoot ? null : flags.cwd,
              createdAt,
            },
          },
          createdAt,
        });

        yield* printJson({
          threadId,
          result: dispatchResult,
          review: reviewContext,
        });
      }),
    ),
  ),
);

const vcsStatusCommand = Command.make("status", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Print VCS status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsRefreshStatus]({ cwd: flags.cwd }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsWatchCommand = Command.make("watch", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Watch VCS status events."),
  Command.withHandler((flags) =>
    runReconnectingStream(
      "vcs watch",
      callWsRpc(flags, (client) =>
        client[WS_METHODS.subscribeVcsStatus]({ cwd: flags.cwd }).pipe(
          Stream.map((event) => JSON.stringify(event, null, 2)),
          Stream.runForEach((line) => Console.log(line)),
        ),
      ),
    ),
  ),
);

const vcsPullCommand = Command.make("pull", {
  ...liveTargetFlags,
  cwd: cwdFlag,
}).pipe(
  Command.withDescription("Run VCS pull."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsPull]({ cwd: flags.cwd }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsRefsCommand = Command.make("refs", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  query: queryFlag,
  limit: limitFlag,
}).pipe(
  Command.withDescription("List VCS refs."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsListRefs]({
          cwd: flags.cwd,
          ...(Option.isSome(flags.query) ? { query: flags.query.value } : {}),
          ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsCreateRefCommand = Command.make("create-ref", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  refName: Argument.string("ref").pipe(Argument.withDescription("Ref name.")),
  switchRef: Flag.boolean("switch").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Create a VCS ref."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsCreateRef]({
          cwd: flags.cwd,
          refName: flags.refName,
          ...(flags.switchRef ? { switchRef: true } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsSwitchRefCommand = Command.make("switch-ref", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  refName: Argument.string("ref").pipe(Argument.withDescription("Ref name.")),
}).pipe(
  Command.withDescription("Switch VCS ref."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsSwitchRef]({ cwd: flags.cwd, refName: flags.refName }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsWorktreeCreateCommand = Command.make("create", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  refName: Argument.string("ref").pipe(Argument.withDescription("Base ref.")),
  newRefName: Flag.string("new-ref").pipe(Flag.optional),
  path: Flag.string("path").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Create a VCS worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsCreateWorktree]({
          cwd: flags.cwd,
          refName: flags.refName,
          ...(Option.isSome(flags.newRefName) ? { newRefName: flags.newRefName.value } : {}),
          path: Option.getOrUndefined(flags.path) ?? null,
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsWorktreeRemoveCommand = Command.make("remove", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  path: Argument.string("path").pipe(Argument.withDescription("Worktree path.")),
  force: forceFlag,
}).pipe(
  Command.withDescription("Remove a VCS worktree."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsRemoveWorktree]({
          cwd: flags.cwd,
          path: flags.path,
          ...(flags.force ? { force: true } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsWorktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("Manage VCS worktrees."),
  Command.withSubcommands([vcsWorktreeCreateCommand, vcsWorktreeRemoveCommand]),
);

const vcsInitCommand = Command.make("init", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  kind: Flag.choice("kind", ["git", "jj", "unknown"]).pipe(Flag.optional),
}).pipe(
  Command.withDescription("Initialize a VCS repository."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.vcsInit]({
          cwd: flags.cwd,
          ...(Option.isSome(flags.kind) ? { kind: flags.kind.value as VcsDriverKind } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const vcsCommand = Command.make("vcs").pipe(
  Command.withDescription("Run VCS operations through T3."),
  Command.withSubcommands([
    vcsStatusCommand,
    vcsWatchCommand,
    vcsPullCommand,
    vcsRefsCommand,
    vcsCreateRefCommand,
    vcsSwitchRefCommand,
    vcsWorktreeCommand,
    vcsInitCommand,
  ]),
);

const sourceControlDiscoverCommand = Command.make("discover", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Discover source-control providers."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverDiscoverSourceControl]({}),
      );
      yield* printJson(result);
    }),
  ),
);

const sourceControlLookupCommand = Command.make("lookup", {
  ...liveTargetFlags,
  provider: Flag.choice("provider", ["github", "gitlab", "azure-devops", "bitbucket", "unknown"]),
  repository: Argument.string("repository").pipe(
    Argument.withDescription("Repository name, e.g. owner/name."),
  ),
  cwd: Flag.string("cwd").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Look up a source-control repository."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.sourceControlLookupRepository]({
          provider: flags.provider as SourceControlProviderKind,
          repository: flags.repository,
          ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const cloneProtocolFlag = Flag.choice("protocol", ["auto", "ssh", "https"]).pipe(Flag.optional);

const sourceControlCloneCommand = Command.make("clone", {
  ...liveTargetFlags,
  destination: Argument.string("destination").pipe(
    Argument.withDescription("Destination path for the clone."),
  ),
  provider: Flag.choice("provider", [
    "github",
    "gitlab",
    "azure-devops",
    "bitbucket",
    "unknown",
  ]).pipe(Flag.optional),
  repository: Flag.string("repository").pipe(Flag.optional),
  remoteUrl: Flag.string("remote-url").pipe(Flag.optional),
  protocol: cloneProtocolFlag,
}).pipe(
  Command.withDescription("Clone a source-control repository."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.sourceControlCloneRepository]({
          destinationPath: flags.destination,
          ...(Option.isSome(flags.provider)
            ? { provider: flags.provider.value as SourceControlProviderKind }
            : {}),
          ...(Option.isSome(flags.repository) ? { repository: flags.repository.value } : {}),
          ...(Option.isSome(flags.remoteUrl) ? { remoteUrl: flags.remoteUrl.value } : {}),
          ...(Option.isSome(flags.protocol)
            ? { protocol: flags.protocol.value as SourceControlCloneProtocol }
            : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const sourceControlPublishCommand = Command.make("publish", {
  ...liveTargetFlags,
  cwd: cwdFlag,
  provider: Flag.choice("provider", ["github", "gitlab", "azure-devops", "bitbucket", "unknown"]),
  repository: Argument.string("repository").pipe(
    Argument.withDescription("Repository name, e.g. owner/name."),
  ),
  visibility: Flag.choice("visibility", ["private", "public"]).pipe(Flag.withDefault("private")),
  remoteName: Flag.string("remote").pipe(Flag.optional),
  protocol: cloneProtocolFlag,
}).pipe(
  Command.withDescription("Publish a local repository."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.sourceControlPublishRepository]({
          cwd: flags.cwd,
          provider: flags.provider as SourceControlProviderKind,
          repository: flags.repository,
          visibility: flags.visibility as SourceControlRepositoryVisibility,
          ...(Option.isSome(flags.remoteName) ? { remoteName: flags.remoteName.value } : {}),
          ...(Option.isSome(flags.protocol)
            ? { protocol: flags.protocol.value as SourceControlCloneProtocol }
            : {}),
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const sourceControlCommand = Command.make("source-control").pipe(
  Command.withDescription("Discover and operate source-control providers."),
  Command.withSubcommands([
    sourceControlDiscoverCommand,
    sourceControlLookupCommand,
    sourceControlCloneCommand,
    sourceControlPublishCommand,
  ]),
);

const terminalIdFlag = Flag.string("terminal").pipe(Flag.withDefault("default"));
const optionalCwdFlag = Flag.string("cwd").pipe(Flag.optional);
const colsFlag = Flag.integer("cols").pipe(Flag.optional);
const rowsFlag = Flag.integer("rows").pipe(Flag.optional);
const terminalEnvFlag = Flag.string("env-json").pipe(
  Flag.withDescription("JSON object of terminal environment variables."),
  Flag.optional,
);

const readTerminalEnv = (envJson: Option.Option<string>) =>
  Option.isSome(envJson)
    ? readJsonRecordPayload({ payload: envJson, file: Option.none(), label: "--env-json" }).pipe(
        Effect.map((record) =>
          Object.fromEntries(
            Object.entries(record).map(([key, value]) => [
              key,
              typeof value === "string" ? value : JSON.stringify(value),
            ]),
          ),
        ),
      )
    : Effect.void;

const terminalOpenCommand = Command.make("open", {
  ...liveTargetFlags,
  chat: Flag.string("thread").pipe(Flag.withDescription("Thread id or title.")),
  terminal: terminalIdFlag,
  cwd: optionalCwdFlag,
  worktree: Flag.string("worktree").pipe(Flag.optional),
  cols: colsFlag,
  rows: rowsFlag,
  env: terminalEnvFlag,
}).pipe(
  Command.withDescription("Open a terminal for a thread."),
  Command.withHandler((flags) =>
    withTerminalRpc(flags, flags.chat, ({ thread, project, client }) =>
      Effect.gen(function* () {
        const env = yield* readTerminalEnv(flags.env);
        const cwd =
          Option.getOrUndefined(flags.cwd) ?? thread.worktreePath ?? project.workspaceRoot;
        const result = yield* client[WS_METHODS.terminalOpen]({
          threadId: thread.id,
          terminalId: flags.terminal,
          cwd,
          worktreePath: Option.getOrUndefined(flags.worktree) ?? thread.worktreePath,
          ...(Option.isSome(flags.cols) ? { cols: flags.cols.value } : {}),
          ...(Option.isSome(flags.rows) ? { rows: flags.rows.value } : {}),
          ...(env !== undefined ? { env } : {}),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const terminalAttachCommand = Command.make("attach", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  terminal: terminalIdFlag,
  cwd: optionalCwdFlag,
  worktree: Flag.string("worktree").pipe(Flag.optional),
  cols: colsFlag,
  rows: rowsFlag,
  env: terminalEnvFlag,
  restartIfNotRunning: Flag.boolean("restart-if-not-running").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Stream terminal events as JSON."),
  Command.withHandler((flags) =>
    runReconnectingStream(
      "terminal stream",
      withTerminalRpc(flags, flags.chat, ({ thread, client }) =>
        Effect.gen(function* () {
          const env = yield* readTerminalEnv(flags.env);
          yield* client[WS_METHODS.terminalAttach]({
            threadId: thread.id,
            terminalId: flags.terminal,
            ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
            ...(Option.isSome(flags.worktree) ? { worktreePath: flags.worktree.value } : {}),
            ...(Option.isSome(flags.cols) ? { cols: flags.cols.value } : {}),
            ...(Option.isSome(flags.rows) ? { rows: flags.rows.value } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(flags.restartIfNotRunning ? { restartIfNotRunning: true } : {}),
          }).pipe(
            Stream.map((event) => JSON.stringify(event, null, 2)),
            Stream.runForEach((line) => Console.log(line)),
          );
        }),
      ),
    ),
  ),
);

const terminalWriteCommand = Command.make("write", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  data: Argument.string("input").pipe(Argument.withDescription("Input to write.")),
  terminal: terminalIdFlag,
}).pipe(
  Command.withDescription("Write input to a terminal."),
  Command.withHandler((flags) =>
    withTerminalRpc(flags, flags.chat, ({ thread, client }) =>
      Effect.gen(function* () {
        const result = yield* client[WS_METHODS.terminalWrite]({
          threadId: thread.id,
          terminalId: flags.terminal,
          data: flags.data,
        });
        yield* printJson(result ?? { written: true });
      }),
    ),
  ),
);

const terminalClearCommand = Command.make("clear", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  terminal: terminalIdFlag,
}).pipe(
  Command.withDescription("Clear terminal history."),
  Command.withHandler((flags) =>
    withTerminalRpc(flags, flags.chat, ({ thread, client }) =>
      Effect.gen(function* () {
        const result = yield* client[WS_METHODS.terminalClear]({
          threadId: thread.id,
          terminalId: flags.terminal,
        });
        yield* printJson(result ?? { cleared: true });
      }),
    ),
  ),
);

const terminalRestartCommand = Command.make("restart", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  terminal: terminalIdFlag,
  cwd: optionalCwdFlag,
  worktree: Flag.string("worktree").pipe(Flag.optional),
  cols: Flag.integer("cols").pipe(Flag.withDefault(80)),
  rows: Flag.integer("rows").pipe(Flag.withDefault(24)),
  env: terminalEnvFlag,
}).pipe(
  Command.withDescription("Restart a terminal."),
  Command.withHandler((flags) =>
    withTerminalRpc(flags, flags.chat, ({ thread, project, client }) =>
      Effect.gen(function* () {
        const env = yield* readTerminalEnv(flags.env);
        const cwd =
          Option.getOrUndefined(flags.cwd) ?? thread.worktreePath ?? project.workspaceRoot;
        const result = yield* client[WS_METHODS.terminalRestart]({
          threadId: thread.id,
          terminalId: flags.terminal,
          cwd,
          worktreePath: Option.getOrUndefined(flags.worktree) ?? thread.worktreePath,
          cols: flags.cols,
          rows: flags.rows,
          ...(env !== undefined ? { env } : {}),
        });
        yield* printJson(result);
      }),
    ),
  ),
);

const terminalCloseCommand = Command.make("close", {
  ...liveTargetFlags,
  chat: Argument.string("thread").pipe(Argument.withDescription("Thread id or title.")),
  terminal: Flag.string("terminal").pipe(Flag.optional),
  deleteHistory: Flag.boolean("delete-history").pipe(Flag.withDefault(false)),
  yes: yesFlag,
}).pipe(
  Command.withDescription("Close a terminal."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.deleteHistory) {
        yield* requireYes(flags.yes, "Deleting terminal history is irreversible.");
      }
      yield* withTerminalRpc(flags, flags.chat, ({ thread, client }) =>
        Effect.gen(function* () {
          const result = yield* client[WS_METHODS.terminalClose]({
            threadId: thread.id,
            ...(Option.isSome(flags.terminal) ? { terminalId: flags.terminal.value } : {}),
            ...(flags.deleteHistory ? { deleteHistory: true } : {}),
          });
          yield* printJson(result ?? { closed: true });
        }),
      );
    }),
  ),
);

const terminalMetadataCommand = Command.make("metadata", {
  ...liveTargetFlags,
  watch: Flag.boolean("watch").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Stream terminal metadata events."),
  Command.withHandler((flags) =>
    flags.watch
      ? runReconnectingStream(
          "terminal metadata",
          callWsRpc(flags, (client) =>
            client[WS_METHODS.subscribeTerminalMetadata]({}).pipe(
              Stream.map((event) => JSON.stringify(event, null, 2)),
              Stream.runForEach((line) => Console.log(line)),
            ),
          ),
        )
      : Effect.fail(new Error("Specify --watch. Snapshot-only metadata is not exposed yet.")),
  ),
);

const terminalCommand = Command.make("terminal").pipe(
  Command.withDescription("Manage thread terminals."),
  Command.withSubcommands([
    terminalOpenCommand,
    terminalAttachCommand,
    terminalWriteCommand,
    terminalClearCommand,
    terminalRestartCommand,
    terminalCloseCommand,
    terminalMetadataCommand,
  ]),
);

const settingsGetCommand = Command.make("get", {
  ...liveTargetFlags,
  path: Flag.string("path").pipe(
    Flag.withDescription("Optional dot path to extract from settings."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Print server settings."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settings = yield* getServerSettings(flags);
      const path = Option.getOrUndefined(flags.path);
      if (path === undefined) {
        yield* printJson(settings);
        return;
      }
      let current: unknown = settings;
      for (const segment of path.split(".")) {
        if (!isJsonRecord(current) || !(segment in current)) {
          return yield* Effect.fail(new Error(`Settings path '${path}' was not found.`));
        }
        current = current[segment];
      }
      yield* printJson(current);
    }),
  ),
);

const settingsUpdateCommand = Command.make("update", {
  ...liveTargetFlags,
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Patch server settings from JSON."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const patch = (yield* readJsonRecordPayload({
        payload: flags.payload,
        file: flags.payloadFile,
        label: "Settings patch",
      })) as ServerSettingsPatch;
      const settings = yield* updateServerSettings(flags, patch);
      yield* printJson(settings);
    }),
  ),
);

const observabilityGetCommand = Command.make("get", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print observability settings and runtime paths."),
  Command.withHandler((flags) =>
    withLiveRpcClient(flags, (client) =>
      Effect.gen(function* () {
        const [settings, config] = yield* Effect.all([
          client[WS_METHODS.serverGetSettings]({}),
          client[WS_METHODS.serverGetConfig]({}),
        ]);
        yield* printJson({ settings: settings.observability, runtime: config.observability });
      }),
    ),
  ),
);

const observabilitySetCommand = Command.make("set", {
  ...liveTargetFlags,
  otlpTracesUrl: Flag.string("otlp-traces-url").pipe(Flag.optional),
  otlpMetricsUrl: Flag.string("otlp-metrics-url").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Update observability settings."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isNone(flags.otlpTracesUrl) && Option.isNone(flags.otlpMetricsUrl)) {
        return yield* Effect.fail(new Error("Provide --otlp-traces-url or --otlp-metrics-url."));
      }
      const settings = yield* updateServerSettings(flags, {
        observability: {
          ...(Option.isSome(flags.otlpTracesUrl)
            ? { otlpTracesUrl: flags.otlpTracesUrl.value }
            : {}),
          ...(Option.isSome(flags.otlpMetricsUrl)
            ? { otlpMetricsUrl: flags.otlpMetricsUrl.value }
            : {}),
        },
      });
      yield* printJson(settings.observability);
    }),
  ),
);

const observabilityCommand = Command.make("observability").pipe(
  Command.withDescription("Manage observability settings."),
  Command.withSubcommands([observabilityGetCommand, observabilitySetCommand]),
);

const settingsCommand = Command.make("settings").pipe(
  Command.withDescription("Manage server settings."),
  Command.withSubcommands([settingsGetCommand, settingsUpdateCommand, observabilityCommand]),
);

const keybindingListCommand = Command.make("list", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("List resolved keybindings."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* callWsRpc(flags, (client) => client[WS_METHODS.serverGetConfig]({}));
      yield* printJson(config.keybindings);
    }),
  ),
);

const keybindingRuleFromFlags = (flags: {
  readonly key: string;
  readonly command: string;
  readonly when: Option.Option<string>;
}) =>
  decodeKeybindingRule({
    key: flags.key,
    command: flags.command,
    ...(Option.isSome(flags.when) ? { when: flags.when.value } : {}),
  }).pipe(
    Effect.mapError(
      (cause) => new Error(`Invalid keybinding rule for '${flags.command}'.`, { cause }),
    ),
  );

const keybindingAddCommand = Command.make("add", {
  ...liveTargetFlags,
  key: Argument.string("key").pipe(Argument.withDescription("Keybinding, e.g. mod+k.")),
  commandName: Argument.string("command").pipe(Argument.withDescription("Command id.")),
  when: Flag.string("when").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Add or update a keybinding."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rule = yield* keybindingRuleFromFlags({
        key: flags.key,
        command: flags.commandName,
        when: flags.when,
      });
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverUpsertKeybinding](rule),
      );
      yield* printJson(result);
    }),
  ),
);

const keybindingRemoveCommand = Command.make("remove", {
  ...liveTargetFlags,
  key: Argument.string("key").pipe(Argument.withDescription("Keybinding, e.g. mod+k.")),
  commandName: Argument.string("command").pipe(Argument.withDescription("Command id.")),
  when: Flag.string("when").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Remove a keybinding."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rule = yield* keybindingRuleFromFlags({
        key: flags.key,
        command: flags.commandName,
        when: flags.when,
      });
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverRemoveKeybinding](rule),
      );
      yield* printJson(result);
    }),
  ),
);

const keybindingCommand = Command.make("keybinding").pipe(
  Command.withDescription("Manage keybindings."),
  Command.withSubcommands([keybindingListCommand, keybindingAddCommand, keybindingRemoveCommand]),
);

const diagnosticsTraceCommand = Command.make("trace", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print trace diagnostics."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverGetTraceDiagnostics]({}),
      );
      yield* printJson(result);
    }),
  ),
);

const diagnosticsProcessCommand = Command.make("process", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print process diagnostics."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverGetProcessDiagnostics]({}),
      );
      yield* printJson(result);
    }),
  ),
);

const diagnosticsResourcesCommand = Command.make("resources", {
  ...liveTargetFlags,
  windowMs: Flag.integer("window-ms").pipe(Flag.withDefault(5 * 60 * 1000)),
  bucketMs: Flag.integer("bucket-ms").pipe(Flag.withDefault(10_000)),
}).pipe(
  Command.withDescription("Print process resource history."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverGetProcessResourceHistory]({
          windowMs: flags.windowMs,
          bucketMs: flags.bucketMs,
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const diagnosticsSignalCommand = Command.make("signal", {
  ...liveTargetFlags,
  pid: Argument.integer("pid").pipe(Argument.withDescription("Process id.")),
  signal: Argument.choice("signal", ["SIGINT", "SIGKILL"]).pipe(
    Argument.withDescription("Signal to send."),
  ),
  yes: yesFlag,
}).pipe(
  Command.withDescription("Signal a process managed by the server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.signal === "SIGKILL") {
        yield* requireYes(flags.yes, "SIGKILL forcefully terminates a process.");
      }
      const result = yield* callWsRpc(flags, (client) =>
        client[WS_METHODS.serverSignalProcess]({
          pid: flags.pid,
          signal: flags.signal as ServerProcessSignal,
        }),
      );
      yield* printJson(result);
    }),
  ),
);

const diagnosticsCommand = Command.make("diagnostics").pipe(
  Command.withDescription("Inspect server diagnostics."),
  Command.withSubcommands([
    diagnosticsTraceCommand,
    diagnosticsProcessCommand,
    diagnosticsResourcesCommand,
    diagnosticsSignalCommand,
  ]),
);

type CliEnvironmentEntry = {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly token?: string;
  readonly environmentId?: string;
  readonly secrets?: Record<string, string>;
};

type CliEnvironmentRegistry = {
  readonly current?: string;
  readonly environments: Record<string, CliEnvironmentEntry>;
};

const emptyEnvironmentRegistry = (): CliEnvironmentRegistry => ({ environments: {} });

const environmentRegistryPath = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const resolvedBaseDir = yield* resolveBaseDir(Option.getOrUndefined(baseDir));
    const path = yield* Path.Path;
    return path.join(resolvedBaseDir, "cli-environments.json");
  });

const readEnvironmentRegistry = (baseDir: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryPath = yield* environmentRegistryPath(baseDir);
    const exists = yield* fs.exists(registryPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return emptyEnvironmentRegistry();
    const raw = yield* fs.readFileString(registryPath);
    return yield* Effect.try({
      try: () => JSON.parse(raw) as CliEnvironmentRegistry,
      catch: (cause) =>
        new CliPayloadError({
          message: `Invalid environment registry: ${registryPath}`,
          cause,
        }),
    });
  });

const ENVIRONMENT_REGISTRY_FILE_MODE = 0o600;

const writeEnvironmentRegistry = (
  baseDir: Option.Option<string>,
  registry: CliEnvironmentRegistry,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registryPath = yield* environmentRegistryPath(baseDir);
    yield* fs.makeDirectory(path.dirname(registryPath), { recursive: true });
    yield* fs.writeFileString(registryPath, JSON.stringify(registry, null, 2), {
      mode: ENVIRONMENT_REGISTRY_FILE_MODE,
    });
    // writeFileString's mode only applies on creation; enforce it so a
    // pre-existing world-readable file holding tokens/secrets is tightened.
    yield* fs.chmod(registryPath, ENVIRONMENT_REGISTRY_FILE_MODE);
  });

const redactEnvironmentEntry = (entry: CliEnvironmentEntry) => ({
  ...entry,
  ...(entry.token !== undefined ? { token: "<redacted>" } : {}),
  ...(entry.secrets !== undefined
    ? { secrets: Object.fromEntries(Object.keys(entry.secrets).map((key) => [key, "<redacted>"])) }
    : {}),
});

const envListCommand = Command.make("list", {
  baseDir: baseDirFlag,
  reveal: Flag.boolean("reveal").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("List configured CLI environments."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      yield* printJson({
        current: registry.current ?? null,
        environments: Object.fromEntries(
          Object.entries(registry.environments).map(([id, entry]) => [
            id,
            flags.reveal ? entry : redactEnvironmentEntry(entry),
          ]),
        ),
      });
    }),
  ),
);

const envAddCommand = Command.make("add", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
  url: Flag.string("url").pipe(Flag.withDescription("Server HTTP(S) origin.")),
  label: Flag.string("label").pipe(Flag.optional),
  token: Flag.string("token").pipe(Flag.optional),
  environmentId: Flag.string("environment-id").pipe(Flag.optional),
  use: Flag.boolean("use").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Add or replace a CLI environment profile."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      const entry: CliEnvironmentEntry = {
        id: flags.id,
        label: Option.getOrElse(flags.label, () => flags.id),
        url: flags.url,
        ...(Option.isSome(flags.token) ? { token: flags.token.value } : {}),
        ...(Option.isSome(flags.environmentId) ? { environmentId: flags.environmentId.value } : {}),
        secrets: registry.environments[flags.id]?.secrets ?? {},
      };
      const next = {
        ...(flags.use
          ? { current: flags.id }
          : registry.current !== undefined
            ? { current: registry.current }
            : {}),
        environments: { ...registry.environments, [flags.id]: entry },
      };
      yield* writeEnvironmentRegistry(flags.baseDir, next);
      yield* printJson(redactEnvironmentEntry(entry));
    }),
  ),
);

const envRemoveCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
}).pipe(
  Command.withDescription("Remove a CLI environment profile."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      const environments = { ...registry.environments };
      delete environments[flags.id];
      const next = {
        ...(registry.current !== undefined && registry.current !== flags.id
          ? { current: registry.current }
          : {}),
        environments,
      };
      yield* writeEnvironmentRegistry(flags.baseDir, next);
      yield* printJson({ removed: flags.id });
    }),
  ),
);

const envRenameCommand = Command.make("rename", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
  label: Argument.string("label").pipe(Argument.withDescription("New display label.")),
}).pipe(
  Command.withDescription("Rename a CLI environment profile label."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      const current = registry.environments[flags.id];
      if (current === undefined) {
        return yield* Effect.fail(new Error(`Environment '${flags.id}' not found.`));
      }
      const entry = { ...current, label: flags.label };
      const next = {
        ...registry,
        environments: { ...registry.environments, [flags.id]: entry },
      };
      yield* writeEnvironmentRegistry(flags.baseDir, next);
      yield* printJson(redactEnvironmentEntry(entry));
    }),
  ),
);

const envUseCommand = Command.make("use", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
}).pipe(
  Command.withDescription("Set the current CLI environment profile."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      if (registry.environments[flags.id] === undefined) {
        return yield* Effect.fail(new Error(`Environment '${flags.id}' not found.`));
      }
      const next = { ...registry, current: flags.id };
      yield* writeEnvironmentRegistry(flags.baseDir, next);
      yield* printJson({ current: flags.id });
    }),
  ),
);

const envSecretSetCommand = Command.make("set", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
  name: Argument.string("name").pipe(Argument.withDescription("Secret name.")),
  value: Argument.string("value").pipe(Argument.withDescription("Secret value.")),
}).pipe(
  Command.withDescription("Set a local CLI environment secret."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      const current = registry.environments[flags.id];
      if (current === undefined) {
        return yield* Effect.fail(new Error(`Environment '${flags.id}' not found.`));
      }
      const entry = {
        ...current,
        secrets: { ...(current.secrets ?? {}), [flags.name]: flags.value },
      };
      yield* writeEnvironmentRegistry(flags.baseDir, {
        ...registry,
        environments: { ...registry.environments, [flags.id]: entry },
      });
      yield* printJson({ environment: flags.id, secret: flags.name, set: true });
    }),
  ),
);

const envSecretRemoveCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  id: Argument.string("id").pipe(Argument.withDescription("Environment profile id.")),
  name: Argument.string("name").pipe(Argument.withDescription("Secret name.")),
}).pipe(
  Command.withDescription("Remove a local CLI environment secret."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const registry = yield* readEnvironmentRegistry(flags.baseDir);
      const current = registry.environments[flags.id];
      if (current === undefined) {
        return yield* Effect.fail(new Error(`Environment '${flags.id}' not found.`));
      }
      const secrets = { ...(current.secrets ?? {}) };
      delete secrets[flags.name];
      const entry = { ...current, secrets };
      yield* writeEnvironmentRegistry(flags.baseDir, {
        ...registry,
        environments: { ...registry.environments, [flags.id]: entry },
      });
      yield* printJson({ environment: flags.id, secret: flags.name, removed: true });
    }),
  ),
);

const envSecretCommand = Command.make("secret").pipe(
  Command.withDescription("Manage local CLI environment secrets."),
  Command.withSubcommands([envSecretSetCommand, envSecretRemoveCommand]),
);

const resolveEnvironmentTarget = (baseDir: Option.Option<string>, id: Option.Option<string>) =>
  Effect.gen(function* () {
    const registry = yield* readEnvironmentRegistry(baseDir);
    const selected = Option.getOrUndefined(id) ?? registry.current;
    if (selected === undefined) {
      return yield* Effect.fail(new Error("No environment selected. Use --id or `t3 env use`."));
    }
    const entry = registry.environments[selected];
    if (entry === undefined) {
      return yield* Effect.fail(new Error(`Environment '${selected}' not found.`));
    }
    return entry;
  });

const envTestCommand = Command.make("test", {
  baseDir: baseDirFlag,
  id: Flag.string("id").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Test a CLI environment connection."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const entry = yield* resolveEnvironmentTarget(flags.baseDir, flags.id);
      const config = yield* callWsRpc(
        {
          url: Option.some(entry.url),
          token: Option.fromUndefinedOr(entry.token),
          baseDir: flags.baseDir,
        },
        (client) => client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson({
        id: entry.id,
        connected: true,
        environment: config.environment,
      });
    }),
  ),
);

const envConnectCommand = Command.make("connect", {
  baseDir: baseDirFlag,
  id: Flag.string("id").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Connect to a CLI environment and print its server config."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const entry = yield* resolveEnvironmentTarget(flags.baseDir, flags.id);
      const config = yield* callWsRpc(
        {
          url: Option.some(entry.url),
          token: Option.fromUndefinedOr(entry.token),
          baseDir: flags.baseDir,
        },
        (client) => client[WS_METHODS.serverGetConfig]({}),
      );
      yield* printJson(config);
    }),
  ),
);

const envCurrentCommand = Command.make("current", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print the current server environment descriptor."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* callWsRpc(flags, (client) => client[WS_METHODS.serverGetConfig]({}));
      yield* printJson(config.environment);
    }),
  ),
);

const envCommand = Command.make("env").pipe(
  Command.withDescription("Manage CLI environments."),
  Command.withSubcommands([
    envListCommand,
    envAddCommand,
    envRemoveCommand,
    envRenameCommand,
    envUseCommand,
    envSecretCommand,
    envConnectCommand,
    envTestCommand,
    envCurrentCommand,
  ]),
);

const skillsListCommand = Command.make("list", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("List server skills."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* withLiveRpcClient(flags, (client) =>
        client[WS_METHODS.serverListSkills]({}),
      );
      yield* printJson(result);
    }),
  ),
);

const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("Inspect skills."),
  Command.withSubcommands([skillsListCommand]),
);

const mcpServeCommand = Command.make("serve", {
  cwd: mcpCwdFlag,
  toolsets: mcpToolsetsFlag,
}).pipe(
  Command.withDescription("Run the T3 Code MCP stdio server."),
  Command.withHandler(({ cwd, toolsets }) =>
    Effect.promise(() => import("./mcpServer.ts")).pipe(
      Effect.flatMap(({ runMcpServer }) => runMcpServer({ cwd, toolsets })),
    ),
  ),
);

const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Expose selected T3 Code tools over MCP."),
  Command.withSubcommands([mcpServeCommand]),
);

const rpcCallCommand = Command.make("call", {
  ...liveTargetFlags,
  method: Argument.string("method").pipe(Argument.withDescription("WebSocket RPC method name.")),
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Call a unary WebSocket RPC method and print the JSON result."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rawPayload = yield* readJsonPayload({
        payload: flags.payload,
        file: flags.payloadFile,
      });
      const payload = yield* decodeRpcPayload(rawPayload);
      const result = yield* callRawRpc({
        flags: flags satisfies CliLiveTargetFlags,
        method: flags.method,
        payload,
      });
      yield* printJson(result);
    }),
  ),
);

const rpcCommand = Command.make("rpc").pipe(
  Command.withDescription("Low-level WebSocket RPC escape hatch."),
  Command.withSubcommands([rpcCallCommand]),
);

const orchestrationDispatchCommand = Command.make("dispatch", {
  ...liveTargetFlags,
  payload: payloadFlag,
  payloadFile: payloadFileFlag,
}).pipe(
  Command.withDescription("Dispatch a raw client orchestration command."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const rawPayload = yield* readJsonPayload({
        payload: flags.payload,
        file: flags.payloadFile,
      });
      const command = yield* decodeRawOrchestrationCommand(rawPayload);
      const result = yield* dispatchRawOrchestrationCommand({
        flags: flags satisfies CliLiveTargetFlags,
        command,
      });
      yield* printJson(result);
    }),
  ),
);

const orchestrationSnapshotCommand = Command.make("snapshot", {
  ...liveTargetFlags,
}).pipe(
  Command.withDescription("Print the current orchestration read-model snapshot."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const snapshot = yield* getLiveOrchestrationSnapshot(flags);
      yield* printJson(snapshot);
    }),
  ),
);

const shellWatchFlag = Flag.boolean("shell").pipe(
  Flag.withDescription("Watch the orchestration shell stream."),
  Flag.withDefault(false),
);

const orchestrationWatchCommand = Command.make("watch", {
  ...liveTargetFlags,
  shell: shellWatchFlag,
}).pipe(
  Command.withDescription("Watch orchestration stream events."),
  Command.withHandler((flags) =>
    flags.shell
      ? watchShell(flags)
      : Effect.fail(new Error("Specify --shell. Additional watch targets will be added later.")),
  ),
);

const orchestrationCommand = Command.make("orchestration").pipe(
  Command.withDescription("Low-level orchestration escape hatch."),
  Command.withSubcommands([
    orchestrationDispatchCommand,
    orchestrationSnapshotCommand,
    orchestrationWatchCommand,
  ]),
);

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const { runServer } = yield* Effect.promise(() => import("./server.ts"));
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

export const cli = Command.make("t3", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "T3 Code CLI. With no subcommand, 't3' runs the T3 Code server (equivalent to 't3 start'). " +
      "Use 't3 serve' for a headless server, or run 't3 --help' to list all management subcommands.",
  ),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    serverCommand,
    authCommand,
    projectCommand,
    chatCommand,
    reviewCommand,
    approvalCommand,
    inputCommand,
    modelCommand,
    diffCommand,
    checkpointCommand,
    exportCommand,
    providerCommand,
    gitCommand,
    vcsCommand,
    sourceControlCommand,
    terminalCommand,
    settingsCommand,
    keybindingCommand,
    diagnosticsCommand,
    envCommand,
    skillsCommand,
    mcpCommand,
    rpcCommand,
    orchestrationCommand,
  ]),
);
