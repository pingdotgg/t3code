import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { type ServerEnvVarSpec, serverEnvSpecs } from "./config.ts";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";

export interface ServerEnvVariableRow {
  readonly variable: string;
  readonly expected: string;
  readonly description: string;
  readonly required: boolean;
  readonly status: "ok" | "missing" | "invalid";
  readonly received?: string;
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
        status: Schema.Literals(["ok", "missing", "invalid"]),
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

const secretVariableNamePattern = /TOKEN|SECRET|KEY|PASSWORD/i;

const redact = (spec: ServerEnvVarSpec, value: string) =>
  spec.secret || secretVariableNamePattern.test(spec.variable) ? "<redacted>" : value;

const renderReceived = (row: ServerEnvVariableRow) => {
  if (row.received === undefined) return "—";
  return row.received.length > 48 ? `${row.received.slice(0, 45)}…` : row.received;
};

export const formatEnvValidationTable = (
  rows: ReadonlyArray<ServerEnvVariableRow>,
  outcome: "succeeded" | "failed",
) => {
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
  const rule = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
  const formatLine = (cells: readonly string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;

  lines.push(`Server environment validation ${outcome}:`);
  lines.push(rule);
  lines.push(formatLine([...header]));
  lines.push(rule);
  for (const cells of tableRows) {
    lines.push(formatLine(cells));
  }
  lines.push(rule);
  lines.push(
    outcome === "succeeded"
      ? "All documented server environment variables are valid."
      : "Fix the invalid variables above and start the server again.",
  );
  return lines.join("\n");
};

const defaultReceived = (spec: ServerEnvVarSpec) =>
  spec.defaultText === undefined ? "(unset)" : `(default: ${spec.defaultText})`;

export const validateServerEnvironment = Effect.gen(function* () {
  const provider = yield* ConfigProvider.ConfigProvider;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const rows: Array<ServerEnvVariableRow> = [];

  for (const spec of serverEnvSpecs) {
    const raw = (yield* provider.load([spec.variable]))?.value;
    const decoded = yield* Effect.result(spec.config);
    let valid = Result.isSuccess(decoded);
    if (
      valid &&
      raw !== undefined &&
      spec.variable === "T3CODE_RESOURCE_MONITOR_PATH" &&
      Result.isSuccess(decoded)
    ) {
      const value = Result.getOrThrow(decoded);
      if (typeof value !== "string" || value.length === 0) {
        valid = false;
      } else {
        valid = Result.isSuccess(
          yield* Effect.result(
            ResourceMonitorBinary.validateResourceMonitorOverride(value, platform, architecture),
          ),
        );
      }
    }
    rows.push({
      variable: spec.variable,
      expected: spec.expected,
      description: spec.description,
      required: spec.required,
      status: valid ? "ok" : raw === undefined && spec.required ? "missing" : "invalid",
      ...(raw === undefined
        ? { received: defaultReceived(spec) }
        : { received: redact(spec, raw) }),
    });
  }

  if (rows.some((row) => row.status !== "ok")) {
    return yield* new ServerEnvValidationError({ rows });
  }
  return rows;
});

const validateServerEnvironmentOrUserError = validateServerEnvironment.pipe(
  Effect.catchTags({
    ServerEnvValidationError: (error) =>
      Effect.fail(
        new CliError.UserError({
          cause: error,
          userMessage: formatEnvValidationTable(error.rows, "failed"),
        }),
      ),
  }),
);

export const runServerEnvironmentValidation = Effect.asVoid(validateServerEnvironmentOrUserError);

export const runValidateConfig = Effect.gen(function* () {
  const rows = yield* validateServerEnvironmentOrUserError;
  yield* Console.log(formatEnvValidationTable(rows, "succeeded"));
  yield* Console.log("Environment validation completed without starting the server.");
});
