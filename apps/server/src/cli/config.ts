import * as NetService from "@t3tools/shared/Net";
import {
  OtlpHeadersFromString,
  OtlpProtocol,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { parseCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

const modeFlag = Flag.Literals("mode", ServerConfig.RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.Int("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription(
    "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
  ),
  Flag.optional,
);
const devUrlFlag = Flag.String("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.Boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.Int("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.Boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const tailscaleServeFlag = Flag.Boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
const tailscaleServePortFlag = Flag.Int("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);
const validateConfigFlag = Flag.Boolean("validate-config").pipe(
  Flag.withDescription(
    "Validate server environment variables and exit without starting the server.",
  ),
  Flag.optional,
);

const decodeUrlFromString = Schema.decodeExit(Schema.URLFromString);

const ValidUrlStringFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) =>
        Exit.isSuccess(decodeUrlFromString(value))
          ? Effect.succeed(value)
          : Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `expected a valid URL, received "${value}"`,
              }),
            ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);

const SecureHttpUrlStringFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
            throw new Error("invalid secure URL");
          }
          return Effect.succeed(value);
        } catch {
          return Effect.fail(
            new SchemaIssue.InvalidValue({
              message: `expected a secure URL, received "${value}"`,
            }),
          );
        }
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
);

const HostedAppUrlStringFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        try {
          const url = new URL(value);
          const isLoopbackHttp =
            url.protocol === "http:" &&
            (url.hostname === "localhost" ||
              url.hostname === "127.0.0.1" ||
              url.hostname === "[::1]");
          if (
            (url.protocol !== "https:" && !isLoopbackHttp) ||
            url.pathname !== "/" ||
            url.search !== "" ||
            url.hash !== ""
          ) {
            throw new Error("invalid hosted app origin");
          }
          return Effect.succeed(value);
        } catch {
          return Effect.fail(
            new SchemaIssue.InvalidValue({
              message: `expected a hosted app origin, received "${value}"`,
            }),
          );
        }
      },
      encode: (value) => Effect.succeed(value),
    }),
  ),
);

const decodeHostedAppUrlFromString = Schema.decodeExit(HostedAppUrlStringFromString);

export const makePublicValueConfig = (name: string, fallback = "") => {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
};

export const makeRelayUrlConfig = (fallback = "") => {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect((value) => {
      const normalized = normalizeSecureRelayUrl(value);
      return normalized === null
        ? Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(
                new SchemaIssue.InvalidValue({
                  message: "Relay URL must be a secure absolute HTTPS origin.",
                }),
              ),
            ),
          )
        : Effect.succeed(normalized);
    }),
  );
};

export const makeHostedAppUrlConfig = (fallback = "") => {
  const runtimeConfig = Config.NonEmptyString("T3CODE_HOSTED_APP_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect((value) => {
      const result = decodeHostedAppUrlFromString(value);
      return Exit.isSuccess(result)
        ? Effect.succeed(new URL(value).origin)
        : Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(
                new SchemaIssue.InvalidValue({
                  message:
                    "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
                }),
              ),
            ),
          );
    }),
  );
};

const DevAuthTokenConfig = Config.Redacted("T3CODE_DEV_AUTH_TOKEN").pipe(
  Config.map((token) => Redacted.make(Redacted.value(token).trim())),
  Config.mapEffect((token) =>
    Redacted.value(token).length === 0 || Redacted.value(token).length >= 32
      ? Effect.succeed(token)
      : Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: "T3CODE_DEV_AUTH_TOKEN must contain at least 32 characters.",
              }),
            ),
          ),
        ),
  ),
  Config.option,
  Config.map(Option.filter((token) => Redacted.value(token).length > 0)),
  Config.map(Option.getOrUndefined),
);

const invalidEnvironmentValue = (message: string) =>
  Effect.fail(
    new Config.ConfigError(
      new Schema.SchemaError(
        new SchemaIssue.InvalidValue({
          message,
        }),
      ),
    ),
  );

const codexLaunchArgsConfig = Config.String("T3CODE_CODEX_LAUNCH_ARGS").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  Config.mapEffect((value) => {
    if (value === undefined || value.trim().length === 0) return Effect.succeed(undefined);
    try {
      return Effect.succeed(parseCodexLaunchArgs(value));
    } catch {
      return invalidEnvironmentValue("T3CODE_CODEX_LAUNCH_ARGS contains invalid quoting.");
    }
  }),
);

const isAbsolutePathSyntax = (value: string) =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

const resourceMonitorPathConfig = Config.String("T3CODE_RESOURCE_MONITOR_PATH").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
  Config.mapEffect((value) => {
    if (value === undefined) return Effect.succeed(undefined);
    const normalized = value.trim();
    if (normalized.length === 0) return Effect.succeed(undefined);
    if (
      normalized.length > 4096 ||
      normalized.includes("\0") ||
      normalized.includes("\r") ||
      normalized.includes("\n") ||
      !isAbsolutePathSyntax(normalized)
    ) {
      return invalidEnvironmentValue(
        "T3CODE_RESOURCE_MONITOR_PATH must be an absolute executable path.",
      );
    }
    return Effect.succeed(normalized);
  }),
);

// Trace file location, shared by the server and `t3 trace summary`.
export const traceFileConfig = Config.String("T3CODE_TRACE_FILE").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);
export const traceMaxFilesConfig = Config.Int("T3CODE_TRACE_MAX_FILES").pipe(
  Config.withDefault(10),
);

export const serverEnvironmentConfig = {
  logLevel: Config.LogLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.LogLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.Boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: traceFileConfig,
  traceMaxBytes: Config.Int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: traceMaxFilesConfig,
  traceBatchWindowMs: Config.Int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(1_000)),
  otlpTracesUrl: Config.schema(ValidUrlStringFromString, "T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.schema(ValidUrlStringFromString, "T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpLogsUrl: Config.schema(ValidUrlStringFromString, "T3CODE_OTLP_LOGS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  mode: Config.schema(ServerConfig.RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.Port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.String("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devAllowedOrigins: Config.String("T3CODE_DEV_ALLOWED_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ),
  noBrowser: Config.Boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.Int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.Boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.Boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServeEnabled: Config.Boolean("T3CODE_TAILSCALE_SERVE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServePort: Config.Port("T3CODE_TAILSCALE_SERVE_PORT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  strictProviderLifecycleGuard: Config.Boolean("T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD").pipe(
    Config.withDefault(true),
  ),
  codexLaunchArgs: codexLaunchArgsConfig,
  resourceMonitorPath: resourceMonitorPathConfig,
  telemetryEnabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  telemetryFlushBatchSize: Config.Number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(
    Config.withDefault(20),
  ),
  telemetryMaxBufferedEvents: Config.Number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"),
  ),
  posthogHost: Config.schema(ValidUrlStringFromString, "T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
  bitbucketApiBaseUrl: Config.schema(
    ValidUrlStringFromString,
    "T3CODE_BITBUCKET_API_BASE_URL",
  ).pipe(Config.withDefault("https://api.bitbucket.org/2.0")),
  bitbucketAccessToken: Config.String("T3CODE_BITBUCKET_ACCESS_TOKEN").pipe(Config.option),
  bitbucketEmail: Config.String("T3CODE_BITBUCKET_EMAIL").pipe(Config.option),
  bitbucketApiToken: Config.String("T3CODE_BITBUCKET_API_TOKEN").pipe(Config.option),
  cloudflaredPath: makePublicValueConfig("T3CODE_CLOUDFLARED_PATH").pipe(Config.option),
  relayUrl: makeRelayUrlConfig().pipe(Config.option),
  hostedAppUrl: makeHostedAppUrlConfig().pipe(Config.option),
  clerkPublishableKey: makePublicValueConfig("T3CODE_CLERK_PUBLISHABLE_KEY").pipe(Config.option),
  clerkCliOAuthClientId: makePublicValueConfig("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID").pipe(
    Config.option,
  ),
  relayClientTracesUrl: Config.schema(
    SecureHttpUrlStringFromString,
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  ).pipe(Config.option),
  relayClientTracesDataset: makePublicValueConfig("T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET").pipe(
    Config.option,
  ),
  relayClientTracesToken: makePublicValueConfig("T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN").pipe(
    Config.option,
  ),
  releaseBaseUrl: Config.schema(ValidUrlStringFromString, "T3CODE_RELEASE_BASE_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
} as const;

const EnvServerConfig = Config.all(serverEnvironmentConfig);

export interface ServerEnvVarSpec {
  readonly variable: string;
  readonly expected: string;
  readonly description: string;
  readonly config: Config.Config<unknown>;
  readonly required: boolean;
  readonly secret: boolean;
  readonly defaultText: string | undefined;
}

const envSpec = <Value>(
  variable: string,
  expected: string,
  description: string,
  config: Config.Config<Value>,
  options: Partial<Omit<ServerEnvVarSpec, "variable" | "expected" | "description" | "config">> = {},
): ServerEnvVarSpec => ({
  variable,
  expected,
  description,
  config,
  required: false,
  secret: false,
  defaultText: undefined,
  ...options,
});

export const serverEnvSpecs: ReadonlyArray<ServerEnvVarSpec> = [
  envSpec(
    "T3CODE_LOG_LEVEL",
    "log level (All, Fatal, Error, Warn, Info, Debug, Trace, None)",
    "Server log verbosity.",
    serverEnvironmentConfig.logLevel,
    { defaultText: "Info" },
  ),
  envSpec(
    "T3CODE_TRACE_MIN_LEVEL",
    "log level (All, Fatal, Error, Warn, Info, Debug, Trace, None)",
    "Minimum level for trace output.",
    serverEnvironmentConfig.traceMinLevel,
    { defaultText: "Info" },
  ),
  envSpec(
    "T3CODE_TRACE_TIMING_ENABLED",
    "boolean",
    "Include timing data in traces.",
    serverEnvironmentConfig.traceTimingEnabled,
    { defaultText: "true" },
  ),
  envSpec(
    "T3CODE_TRACE_MAX_BYTES",
    "integer (bytes)",
    "Maximum trace file size before rotation.",
    serverEnvironmentConfig.traceMaxBytes,
    { defaultText: "10485760" },
  ),
  envSpec(
    "T3CODE_TRACE_MAX_FILES",
    "integer",
    "Number of rotated trace files to keep.",
    serverEnvironmentConfig.traceMaxFiles,
    { defaultText: "10" },
  ),
  envSpec(
    "T3CODE_TRACE_BATCH_WINDOW_MS",
    "integer (milliseconds)",
    "Window for batching trace events.",
    serverEnvironmentConfig.traceBatchWindowMs,
    { defaultText: "1000" },
  ),
  envSpec(
    "T3CODE_TRACE_FILE",
    "file path",
    "Explicit trace output file; defaults to the server log directory.",
    serverEnvironmentConfig.traceFile,
  ),
  envSpec(
    "T3CODE_OTLP_TRACES_URL",
    "URL",
    "OTLP endpoint for trace export.",
    serverEnvironmentConfig.otlpTracesUrl,
  ),
  envSpec(
    "T3CODE_OTLP_METRICS_URL",
    "URL",
    "OTLP endpoint for metrics export.",
    serverEnvironmentConfig.otlpMetricsUrl,
  ),
  envSpec(
    "T3CODE_OTLP_LOGS_URL",
    "URL",
    "OTLP endpoint for log export.",
    serverEnvironmentConfig.otlpLogsUrl,
  ),
  envSpec(
    "T3CODE_OTLP_EXPORT_INTERVAL_MS",
    "integer (milliseconds)",
    "OTLP export interval.",
    serverEnvironmentConfig.otlpExportIntervalMs,
    { defaultText: "10000" },
  ),
  envSpec(
    "T3CODE_OTLP_HEADERS",
    "comma-separated key=value pairs",
    "Headers attached to OTLP export requests. Values are redacted in this table.",
    serverEnvironmentConfig.otlpHeaders,
    { secret: true },
  ),
  envSpec(
    "T3CODE_OTLP_PROTOCOL",
    "http/json | http/protobuf",
    "Wire protocol for OTLP exporters.",
    serverEnvironmentConfig.otlpProtocol,
    { defaultText: "http/json" },
  ),
  envSpec(
    "T3CODE_MODE",
    "web | desktop",
    "Runtime mode. `desktop` keeps loopback defaults unless overridden.",
    serverEnvironmentConfig.mode,
    { defaultText: "web" },
  ),
  envSpec(
    "T3CODE_PORT",
    "port (1-65535)",
    "Port for the HTTP/WebSocket server. Defaults to an auto-assigned free port.",
    serverEnvironmentConfig.port,
  ),
  envSpec(
    "T3CODE_HOST",
    "host or IP address",
    "Network interface to bind (for example 127.0.0.1 or a Tailnet IP).",
    serverEnvironmentConfig.host,
  ),
  envSpec(
    "T3CODE_HOME",
    "directory path",
    "T3 Code data directory; runtime state is stored under userdata.",
    serverEnvironmentConfig.t3Home,
  ),
  envSpec(
    "VITE_DEV_SERVER_URL",
    "URL",
    "Dev web URL to proxy/redirect to in development.",
    serverEnvironmentConfig.devUrl,
  ),
  envSpec(
    "T3CODE_DEV_ALLOWED_ORIGINS",
    "comma-separated origins",
    "Additional origins allowed to talk to the dev server.",
    serverEnvironmentConfig.devAllowedOrigins,
    { defaultText: "(empty)" },
  ),
  envSpec(
    "T3CODE_NO_BROWSER",
    "boolean",
    "Disable automatic browser opening on startup.",
    serverEnvironmentConfig.noBrowser,
  ),
  envSpec(
    "T3CODE_BOOTSTRAP_FD",
    "integer (file descriptor)",
    "Read one-time bootstrap secrets from the given file descriptor.",
    serverEnvironmentConfig.bootstrapFd,
  ),
  envSpec(
    "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
    "boolean",
    "Create a project for the working directory on startup when missing.",
    serverEnvironmentConfig.autoBootstrapProjectFromCwd,
  ),
  envSpec(
    "T3CODE_LOG_WS_EVENTS",
    "boolean",
    "Emit server-side logs for outbound WebSocket push traffic.",
    serverEnvironmentConfig.logWebSocketEvents,
  ),
  envSpec(
    "T3CODE_TAILSCALE_SERVE",
    "boolean",
    "Expose this backend over Tailscale Serve on the Tailnet.",
    serverEnvironmentConfig.tailscaleServeEnabled,
  ),
  envSpec(
    "T3CODE_TAILSCALE_SERVE_PORT",
    "port (1-65535)",
    "HTTPS port for Tailscale Serve when enabled.",
    serverEnvironmentConfig.tailscaleServePort,
    { defaultText: "443" },
  ),
  envSpec(
    "T3CODE_DEV_AUTH_TOKEN",
    "string with at least 32 characters",
    "Reusable dev auth token for web dev mode. Values are redacted in this table.",
    DevAuthTokenConfig,
    { secret: true },
  ),
  envSpec(
    "T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD",
    "boolean",
    "Require provider lifecycle events to match the active turn.",
    serverEnvironmentConfig.strictProviderLifecycleGuard,
    { defaultText: "true" },
  ),
  envSpec(
    "T3CODE_CODEX_LAUNCH_ARGS",
    "quoted argument list",
    "Codex launch arguments. Invalid quoting is rejected. Values are redacted in this table.",
    serverEnvironmentConfig.codexLaunchArgs,
    { secret: true },
  ),
  envSpec(
    "T3CODE_RESOURCE_MONITOR_PATH",
    "absolute executable path",
    "Optional resource monitor executable override. Values are redacted in this table.",
    serverEnvironmentConfig.resourceMonitorPath,
    { secret: true },
  ),
  envSpec(
    "T3CODE_TELEMETRY_ENABLED",
    "boolean",
    "Enable anonymous product telemetry.",
    serverEnvironmentConfig.telemetryEnabled,
    { defaultText: "true" },
  ),
  envSpec(
    "T3CODE_TELEMETRY_FLUSH_BATCH_SIZE",
    "number",
    "Number of telemetry events flushed per batch.",
    serverEnvironmentConfig.telemetryFlushBatchSize,
    { defaultText: "20" },
  ),
  envSpec(
    "T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS",
    "number",
    "Maximum number of buffered telemetry events.",
    serverEnvironmentConfig.telemetryMaxBufferedEvents,
    { defaultText: "1000" },
  ),
  envSpec(
    "T3CODE_POSTHOG_KEY",
    "string",
    "PostHog project key. Values are redacted in this table.",
    serverEnvironmentConfig.posthogKey,
    { defaultText: "(configured)", secret: true },
  ),
  envSpec(
    "T3CODE_POSTHOG_HOST",
    "URL",
    "PostHog telemetry host.",
    serverEnvironmentConfig.posthogHost,
    { defaultText: "https://us.i.posthog.com" },
  ),
  envSpec(
    "WSL_DISTRO_NAME",
    "string",
    "WSL distribution name included in telemetry metadata.",
    serverEnvironmentConfig.wslDistroName,
  ),
  envSpec(
    "T3CODE_BITBUCKET_API_BASE_URL",
    "URL",
    "Bitbucket API base URL.",
    serverEnvironmentConfig.bitbucketApiBaseUrl,
    { defaultText: "https://api.bitbucket.org/2.0" },
  ),
  envSpec(
    "T3CODE_BITBUCKET_ACCESS_TOKEN",
    "string",
    "Bitbucket access token. Values are redacted in this table.",
    serverEnvironmentConfig.bitbucketAccessToken,
    { secret: true },
  ),
  envSpec(
    "T3CODE_BITBUCKET_EMAIL",
    "string",
    "Bitbucket account email.",
    serverEnvironmentConfig.bitbucketEmail,
  ),
  envSpec(
    "T3CODE_BITBUCKET_API_TOKEN",
    "string",
    "Bitbucket API token. Values are redacted in this table.",
    serverEnvironmentConfig.bitbucketApiToken,
    { secret: true },
  ),
  envSpec(
    "T3CODE_CLOUDFLARED_PATH",
    "file path",
    "Optional path to the cloudflared executable.",
    serverEnvironmentConfig.cloudflaredPath,
  ),
  envSpec(
    "T3CODE_RELAY_URL",
    "secure URL",
    "T3 Connect relay URL.",
    serverEnvironmentConfig.relayUrl,
    { defaultText: "(build-time or unset)" },
  ),
  envSpec(
    "T3CODE_HOSTED_APP_URL",
    "URL",
    "Hosted app origin used for T3 Connect OAuth.",
    serverEnvironmentConfig.hostedAppUrl,
  ),
  envSpec(
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "string",
    "Clerk publishable key used for T3 Connect.",
    serverEnvironmentConfig.clerkPublishableKey,
    { defaultText: "(build-time or unset)" },
  ),
  envSpec(
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "string",
    "Public Clerk CLI OAuth client ID.",
    serverEnvironmentConfig.clerkCliOAuthClientId,
    { defaultText: "(build-time or unset)" },
  ),
  envSpec(
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
    "URL",
    "Relay client OTLP trace endpoint.",
    serverEnvironmentConfig.relayClientTracesUrl,
  ),
  envSpec(
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
    "string",
    "Relay client OTLP trace dataset.",
    serverEnvironmentConfig.relayClientTracesDataset,
  ),
  envSpec(
    "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
    "string",
    "Relay client OTLP trace token. Values are redacted in this table.",
    serverEnvironmentConfig.relayClientTracesToken,
    { secret: true },
  ),
  envSpec(
    "T3CODE_RELEASE_BASE_URL",
    "URL",
    "CLI release download base URL override.",
    serverEnvironmentConfig.releaseBaseUrl,
  ),
];

export interface CliServerFlags {
  readonly validateConfig?: Option.Option<boolean> | undefined;
  readonly mode: Option.Option<ServerConfig.RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const authLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  validateConfig: validateConfigFlag,
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.String("cwd").pipe(
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
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
} as const;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      validateConfig: flags.validateConfig ?? Option.none(),
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
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: ServerConfig.RuntimeMode = Option.getOrElse(
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
            return Effect.succeed(ServerConfig.DEFAULT_PORT);
          }
          return findAvailablePort(ServerConfig.DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const devAuthToken =
      mode === "web" && devUrl !== undefined ? yield* DevAuthTokenConfig : undefined;
    const explicitBaseDir = resolveOptionPrecedence(
      normalizedFlags.baseDir,
      Option.fromUndefinedOr(env.t3Home),
    ).pipe(Option.filter((value) => value.trim().length > 0));
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(explicitBaseDir, Option.fromUndefinedOr(bootstrap?.t3Home)),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
      baseDirIsExplicit: Option.isSome(explicitBaseDir),
    });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
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
    const desktopTelemetryFd = bootstrap?.desktopTelemetryFd;
    const desktopTelemetryControlFd = bootstrap?.desktopTelemetryControlFd;
    const resourceMonitorPath = env.resourceMonitorPath ?? bootstrap?.resourceMonitorPath;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
      ),
      () => 443,
    );
    const staticDir = devUrl ? undefined : yield* ServerConfig.resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const otel = yield* OtelEnvironment.load;

    // T3 Code's own OTLP variables name no signal, so the one answer they give
    // is the answer for all three.
    const signalExport: SignalExport = {
      protocol: env.otlpProtocol,
      headers: env.otlpHeaders,
      exportIntervalMs: env.otlpExportIntervalMs,
    };
    const traces = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "traces",
      { url: env.otlpTracesUrl, export: signalExport },
      bootstrap?.otlpTracesUrl,
      persistedObservabilitySettings.otlpTracesUrl,
    );
    const metrics = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "metrics",
      { url: env.otlpMetricsUrl, export: signalExport },
      bootstrap?.otlpMetricsUrl,
      persistedObservabilitySettings.otlpMetricsUrl,
    );
    const logs = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "logs",
      { url: env.otlpLogsUrl, export: signalExport },
      bootstrap?.otlpLogsUrl,
      persistedObservabilitySettings.otlpLogsUrl,
    );

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl: traces?.url,
      otlpMetricsUrl: metrics?.url,
      otlpLogsUrl: logs?.url,
      otlpTracesExport: traces?.export ?? signalExport,
      otlpMetricsExport: metrics?.export ?? signalExport,
      otlpLogsExport: logs?.export ?? signalExport,
      otelEnvironment: otel,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      ...(devAuthToken === undefined ? {} : { devAuthToken }),
      devAllowedOrigins: env.devAllowedOrigins,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      desktopTelemetryFd,
      desktopTelemetryControlFd,
      resourceMonitorPath,
      codexLaunchArgs: env.codexLaunchArgs,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      validateConfig: Option.none(),
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
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
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

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
