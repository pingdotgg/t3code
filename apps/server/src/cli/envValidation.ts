import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { OtlpHeadersFromString, OtlpProtocol } from "@t3tools/shared/observability";
import { PortSchema } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as CliError from "effect/unstable/cli/CliError";

/**
 * Startup environment validation.
 *
 * The live server config reads `T3CODE_*` variables through `Config.option`
 * pipelines that silently fall back to defaults, so an invalid value (a port
 * spelled wrong, a malformed URL) only surfaces later as a cryptic runtime
 * failure. This module re-checks every variable against the same Effect
 * Schema rules up front, renders a table of anything missing or invalid, and
 * backs both the `t3 --validate-config` flag and the `t3 validate-config`
 * subcommand.
 */

export interface ServerEnvVariableRow {
  readonly variable: string;
  readonly expected: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: "ok" | "missing" | "invalid";
  readonly received: string | undefined;
}

export class ServerEnvValidationError extends Schema.TaggedError<ServerEnvValidationError>()(
  "ServerEnvValidationError",
  {
    rows: Schema.Array(
      Schema.Struct({
        variable: Schema.String,
        expected: Schema.String,
        description: Schema.String,
        required: Schema.Boolean,
        status: Schema.Literals(["missing", "invalid"]),
        received: Schema.optionalKey(Schema.String),
      }),
    ),
  },
) {
  get summary() {
    const missing = this.rows.filter((row) => row.status === "missing").length;
    const invalid = this.rows.filter((row) => row.status === "invalid").length;
    return `${missing} missing, ${invalid} invalid`;
  }
}

/**
 * Accepts exactly the values Effect's own `Config.Boolean` accepts
 * (`Schema.BooleanLiterals`): true/yes/on/1/y and false/no/off/0/n.
 */
const BooleanFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformEffect({
      decode: (value: string) => {
        switch (value) {
          case "true":
          case "yes":
          case "on":
          case "1":
          case "y":
            return Effect.succeed(true);
          case "false":
          case "no":
          case "off":
          case "0":
          case "n":
            return Effect.succeed(false);
          default:
            return Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `expected a boolean flag (true/yes/on/1/y or false/no/off/0/n), received "${value}"`,
              }),
            );
        }
      },
      encode: (value: boolean) => Effect.succeed(value ? "true" : "false"),
    }),
  ),
);

/**
 * Accepts exactly the literals Effect's own `Config.LogLevel` accepts
 * (`Schema.Literals(LogLevel.values)`).
 */
const LOG_LEVEL_VALUES = [
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
] as const;
const LogLevelFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(LOG_LEVEL_VALUES),
    SchemaTransformation.transformEffect({
      decode: (value: string) =>
        (LOG_LEVEL_VALUES as readonly string[]).includes(value)
          ? Effect.succeed(value as (typeof LOG_LEVEL_VALUES)[number])
          : Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `expected one of ${LOG_LEVEL_VALUES.join(", ")}, received "${value}"`,
              }),
            ),
      encode: (value: (typeof LOG_LEVEL_VALUES)[number]) => Effect.succeed(value),
    }),
  ),
);

const IntFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: (value: string) => {
        const parsed = Number(value);
        return Number.isInteger(parsed)
          ? Effect.succeed(parsed)
          : Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `expected an integer, received "${value}"`,
              }),
            );
      },
      encode: (value: number) => Effect.succeed(String(value)),
    }),
  ),
);

const PortFromString = Schema.String.pipe(
  Schema.decodeTo(
    PortSchema,
    SchemaTransformation.transformEffect({
      decode: (value: string) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({
              message: `expected a port between 1 and 65535, received "${value}"`,
            }),
          );
        }
        return Effect.succeed(parsed);
      },
      encode: (value: number) => Effect.succeed(String(value)),
    }),
  ),
);

const DevAuthTokenFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value: string) =>
        value.trim().length >= 32
          ? Effect.succeed(value)
          : Effect.fail(
              new SchemaIssue.InvalidValue({
                message: "T3CODE_DEV_AUTH_TOKEN must contain at least 32 characters.",
              }),
            ),
      encode: (value: string) => Effect.succeed(value),
    }),
  ),
);

const ServerModeFromString = Schema.Literals(["web", "desktop"]);

interface ServerEnvVarSpec {
  readonly variable: string;
  readonly expected: string;
  readonly description: string;
  readonly schema: Schema.ConstraintDecoder<unknown>;
  readonly required: boolean;
  readonly secret?: boolean;
  readonly defaultText?: string;
}

const stringSpec = (
  variable: string,
  expected: string,
  description: string,
  options: Partial<ServerEnvVarSpec> = {},
): ServerEnvVarSpec => ({
  variable,
  expected,
  description,
  schema: Schema.String,
  required: false,
  ...options,
});

export const serverEnvSpecs: ReadonlyArray<ServerEnvVarSpec> = [
  stringSpec(
    "T3CODE_LOG_LEVEL",
    "log level (All, Fatal, Error, Warn, Info, Debug, Trace, None)",
    "Server log verbosity.",
    { schema: LogLevelFromString, defaultText: "Info" },
  ),
  stringSpec(
    "T3CODE_TRACE_MIN_LEVEL",
    "log level (All, Fatal, Error, Warn, Info, Debug, Trace, None)",
    "Minimum level for trace output.",
    { schema: LogLevelFromString, defaultText: "Info" },
  ),
  stringSpec("T3CODE_TRACE_TIMING_ENABLED", "boolean", "Include timing data in traces.", {
    schema: BooleanFromString,
    defaultText: "true",
  }),
  stringSpec(
    "T3CODE_TRACE_MAX_BYTES",
    "integer (bytes)",
    "Maximum trace file size before rotation.",
    { schema: IntFromString, defaultText: "10485760" },
  ),
  stringSpec("T3CODE_TRACE_MAX_FILES", "integer", "Number of rotated trace files to keep.", {
    schema: IntFromString,
    defaultText: "10",
  }),
  stringSpec(
    "T3CODE_TRACE_BATCH_WINDOW_MS",
    "integer (milliseconds)",
    "Window for batching trace events.",
    { schema: IntFromString, defaultText: "1000" },
  ),
  stringSpec(
    "T3CODE_TRACE_FILE",
    "file path",
    "Explicit trace output file; defaults to the server log directory.",
  ),
  {
    variable: "T3CODE_OTLP_TRACES_URL",
    expected: "URL",
    description: "OTLP endpoint for trace export.",
    schema: Schema.URLFromString,
    required: false,
  },
  {
    variable: "T3CODE_OTLP_METRICS_URL",
    expected: "URL",
    description: "OTLP endpoint for metrics export.",
    schema: Schema.URLFromString,
    required: false,
  },
  {
    variable: "T3CODE_OTLP_LOGS_URL",
    expected: "URL",
    description: "OTLP endpoint for log export.",
    schema: Schema.URLFromString,
    required: false,
  },
  stringSpec("T3CODE_OTLP_EXPORT_INTERVAL_MS", "integer (milliseconds)", "OTLP export interval.", {
    schema: IntFromString,
    defaultText: "10000",
  }),
  stringSpec("T3CODE_OTLP_SERVICE_NAME", "string", "Service name attached to OTLP resources.", {
    defaultText: "t3-server",
  }),
  {
    variable: "T3CODE_OTLP_HEADERS",
    expected: "comma-separated key=value pairs",
    description: "Headers attached to OTLP export requests. Values are redacted in this table.",
    schema: OtlpHeadersFromString,
    required: false,
    secret: true,
  },
  {
    variable: "T3CODE_OTLP_PROTOCOL",
    expected: "http/json | http/protobuf",
    description: "Wire protocol for OTLP exporters.",
    schema: OtlpProtocol,
    required: false,
    defaultText: "http/json",
  },
  {
    variable: "T3CODE_MODE",
    expected: "web | desktop",
    description: "Runtime mode. `desktop` keeps loopback defaults unless overridden.",
    schema: ServerModeFromString,
    required: false,
    defaultText: "web",
  },
  {
    variable: "T3CODE_PORT",
    expected: "port (1-65535)",
    description: "Port for the HTTP/WebSocket server. Defaults to an auto-assigned free port.",
    schema: PortFromString,
    required: false,
  },
  stringSpec(
    "T3CODE_HOST",
    "host or IP address",
    "Network interface to bind (for example 127.0.0.1 or a Tailnet IP).",
  ),
  stringSpec(
    "T3CODE_HOME",
    "directory path",
    "T3 Code data directory; runtime state is stored under userdata.",
  ),
  {
    variable: "VITE_DEV_SERVER_URL",
    expected: "URL",
    description: "Dev web URL to proxy/redirect to in development.",
    schema: Schema.URLFromString,
    required: false,
  },
  stringSpec(
    "T3CODE_DEV_ALLOWED_ORIGINS",
    "comma-separated origins",
    "Additional origins allowed to talk to the dev server.",
    { defaultText: "(empty)" },
  ),
  stringSpec("T3CODE_NO_BROWSER", "boolean", "Disable automatic browser opening on startup.", {
    schema: BooleanFromString,
  }),
  stringSpec(
    "T3CODE_BOOTSTRAP_FD",
    "integer (file descriptor)",
    "Read one-time bootstrap secrets from the given file descriptor.",
    { schema: IntFromString },
  ),
  stringSpec(
    "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
    "boolean",
    "Create a project for the working directory on startup when missing.",
    { schema: BooleanFromString },
  ),
  stringSpec(
    "T3CODE_LOG_WS_EVENTS",
    "boolean",
    "Emit server-side logs for outbound WebSocket push traffic.",
    { schema: BooleanFromString },
  ),
  stringSpec(
    "T3CODE_TAILSCALE_SERVE",
    "boolean",
    "Expose this backend over Tailscale Serve on the Tailnet.",
    { schema: BooleanFromString },
  ),
  stringSpec(
    "T3CODE_TAILSCALE_SERVE_PORT",
    "port (1-65535)",
    "HTTPS port for Tailscale Serve when enabled.",
    { schema: PortFromString, defaultText: "443" },
  ),
  {
    variable: "T3CODE_DEV_AUTH_TOKEN",
    expected: "string with at least 32 characters",
    description: "Reusable dev auth token for web dev mode. Values are redacted in this table.",
    schema: DevAuthTokenFromString,
    required: false,
    secret: true,
  },
];

const redact = (spec: ServerEnvVarSpec, value: string) =>
  spec.secret || /TOKEN|SECRET|KEY|PASSWORD/i.test(spec.variable)
    ? `${value.slice(0, 4)}…<redacted>`
    : value;

const renderReceived = (row: ServerEnvVariableRow) => {
  if (row.received === undefined) return "—";
  return row.received.length > 48 ? `${row.received.slice(0, 45)}…` : row.received;
};

export const formatEnvValidationTable = (rows: ReadonlyArray<ServerEnvVariableRow>) => {
  const lines: Array<string> = [];
  const header = ["VARIABLE", "STATUS", "EXPECTED", "RECEIVED", "DESCRIPTION"] as const;
  const tableRows: Array<Array<string>> = rows.map((row) => [
    row.variable,
    row.status.toUpperCase(),
    row.expected,
    renderReceived(row),
    row.description,
  ]);
  const widths: Array<number> = header.map((column, index) => {
    let width = column.length;
    for (const cells of tableRows) {
      const cell = cells[index] ?? "";
      if (cell.length > width) {
        width = cell.length;
      }
    }
    return width;
  });
  // Row cells join with " | " (3 chars), so rule boundaries join with "-+-"
  // to keep the '+' centered under each '|'.
  const rule = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
  const formatLine = (cells: readonly string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;

  lines.push("Server environment validation failed:");
  lines.push(rule);
  lines.push(formatLine([...header]));
  lines.push(rule);
  for (const cells of tableRows) {
    lines.push(formatLine(cells));
  }
  lines.push(rule);
  lines.push("Fix the variables above and start the server again.");
  return lines.join("\n");
};

const failureRow = (row: ServerEnvVariableRow) => {
  const { variable, expected, description, required, status, received } = row;
  return {
    variable,
    expected,
    description,
    required,
    status: status as "missing" | "invalid",
    ...(received === undefined ? {} : { received }),
  };
};

/**
 * Validates every documented server environment variable against its Effect
 * Schema. Touches nothing but the process environment, so it is safe to run
 * before any database connection or network listener exists.
 */
export const validateServerEnvironment = Effect.gen(function* () {
  const env = yield* HostProcessEnvironment;
  const rows: Array<ServerEnvVariableRow> = [];

  for (const spec of serverEnvSpecs) {
    const raw = env[spec.variable];
    const value = typeof raw === "string" ? raw : undefined;
    // A present-but-empty value must reach schema validation, matching live
    // config behavior where `T3CODE_PORT=` is invalid rather than defaulted.
    if (value === undefined || (spec.required && value.trim().length === 0)) {
      rows.push({
        variable: spec.variable,
        expected: spec.expected,
        description: spec.description,
        required: spec.required,
        status: spec.required ? "missing" : "ok",
        received: spec.required
          ? undefined
          : spec.defaultText !== undefined
            ? `(default: ${spec.defaultText})`
            : "(unset)",
      });
      continue;
    }
    const decoded = Schema.decodeExit(spec.schema)(value);
    rows.push({
      variable: spec.variable,
      expected: spec.expected,
      description: spec.description,
      required: spec.required,
      status: Exit.isSuccess(decoded) ? "ok" : "invalid",
      received: redact(spec, value),
    });
  }

  const failures = rows.filter((row) => row.status !== "ok");
  if (failures.length > 0) {
    return yield* new ServerEnvValidationError({
      rows: failures.map(failureRow),
    });
  }
  return rows;
});

/**
 * Shared implementation for `t3 --validate-config` and `t3 validate-config`:
 * prints a success line, or fails with a CliError.UserError whose rendered
 * message is the formatted validation table (exit code 1).
 */
export const runValidateConfig = Effect.gen(function* () {
  const rows = yield* validateServerEnvironment.pipe(
    // The CLI entry point always validates the real process environment;
    // tests exercise validateServerEnvironment directly with injected envs.
    Effect.provideService(HostProcessEnvironment, process.env),
  );
  yield* Console.log(
    `Server environment OK: ${rows.length} variables validated (no services started).`,
  );
}).pipe(
  Effect.catchTags({
    ServerEnvValidationError: (error) =>
      Effect.fail(
        new CliError.UserError({
          cause: error,
          userMessage: formatEnvValidationTable(
            error.rows.map((row): ServerEnvVariableRow => ({
              variable: row.variable,
              expected: row.expected,
              description: row.description,
              required: row.required,
              status: row.status,
              received: row.received,
            })),
          ),
        }),
      ),
  }),
);
