import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { formatEnvValidationTable, validateServerEnvironment } from "./envValidation.ts";

const runValidation = (env: Record<string, string>) =>
  validateServerEnvironment.pipe(Effect.provide(Layer.succeed(HostProcessEnvironment, env)));

const rowFor = <Row extends { variable: string }>(
  rows: ReadonlyArray<Row>,
  variable: string,
): Row | undefined => rows.find((row) => row.variable === variable);

describe("server environment validation", () => {
  it.effect("documents defaults for every optional variable on a clean environment", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({});
      assert.ok(rows.length >= 20, `expected many rows, got ${rows.length}`);
      assert.equal(rows.filter((row) => row.status === "invalid").length, 0);
      assert.equal(rows.filter((row) => row.status === "missing").length, 0);
      const port = rowFor(rows, "T3CODE_PORT");
      assert.ok(port);
      assert.include(port.received ?? "", "(unset)");
      const protocol = rowFor(rows, "T3CODE_OTLP_PROTOCOL");
      assert.ok(protocol);
      assert.include(protocol.received ?? "", "(default: http/json)");
    }),
  );

  it.effect("flags an invalid T3CODE_PORT with the received value", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_PORT: "not-a-port" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ServerEnvValidationError");
      const row = rowFor(error.rows, "T3CODE_PORT");
      assert.ok(row, "expected a T3CODE_PORT failure row");
      assert.strictEqual(row.status, "invalid");
      assert.include(row.received ?? "", "not-a-port");
      assert.include(row.expected, "1-65535");
    }),
  );

  it.effect("flags an out-of-range port", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_PORT: "99999" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_PORT");
      assert.ok(row);
      assert.strictEqual(row.status, "invalid");
    }),
  );

  it.effect("flags a present-but-empty value as invalid, matching live config", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_PORT: "" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_PORT");
      assert.ok(row);
      assert.strictEqual(row.status, "invalid");
    }),
  );

  it.effect("flags an unknown log level literal, matching live config", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_LOG_LEVEL: "Verbose" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_LOG_LEVEL");
      assert.ok(row);
      assert.strictEqual(row.status, "invalid");
      assert.include(row.expected, "Warn");
    }),
  );

  it.effect("flags an invalid T3CODE_MODE literal", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_MODE: "space-shuttle" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_MODE");
      assert.ok(row, "expected a T3CODE_MODE failure row");
      assert.strictEqual(row.status, "invalid");
      assert.strictEqual(row.expected, "web | desktop");
    }),
  );

  it.effect("flags a malformed OTLP traces URL", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_OTLP_TRACES_URL: "not a url" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_OTLP_TRACES_URL");
      assert.ok(row);
      assert.strictEqual(row.status, "invalid");
    }),
  );

  it.effect("flags an invalid boolean and an invalid integer", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({
        T3CODE_NO_BROWSER: "maybe",
        T3CODE_TRACE_MAX_FILES: "ten",
      }).pipe(Effect.flip);
      const noBrowser = rowFor(error.rows, "T3CODE_NO_BROWSER");
      assert.ok(noBrowser);
      assert.strictEqual(noBrowser.status, "invalid");
      const traceMaxFiles = rowFor(error.rows, "T3CODE_TRACE_MAX_FILES");
      assert.ok(traceMaxFiles);
      assert.strictEqual(traceMaxFiles.status, "invalid");
    }),
  );

  it.effect("accepts valid web mode settings with received values", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({
        T3CODE_MODE: "web",
        T3CODE_PORT: "3773",
        T3CODE_HOST: "127.0.0.1",
        T3CODE_LOG_LEVEL: "Debug",
        T3CODE_NO_BROWSER: "1",
      });
      assert.equal(rows.filter((row) => row.status !== "ok").length, 0);
      const port = rowFor(rows, "T3CODE_PORT");
      assert.ok(port);
      assert.strictEqual(port.received, "3773");
    }),
  );

  it.effect("flags a too-short dev auth token as invalid", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_DEV_AUTH_TOKEN: "short" }).pipe(Effect.flip);
      const row = rowFor(error.rows, "T3CODE_DEV_AUTH_TOKEN");
      assert.ok(row, "expected a T3CODE_DEV_AUTH_TOKEN failure row");
      assert.strictEqual(row.status, "invalid");
      assert.include(row.expected, "32");
    }),
  );

  it.effect("redacts secret-looking variables in the received column", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({
        T3CODE_DEV_AUTH_TOKEN: "short",
        // Valid pairs plus one malformed pair -> row surfaces as invalid, and
        // the raw secret-bearing value must never reach the rendered table.
        T3CODE_OTLP_HEADERS: "authorization=super-secret-value, bad-pair-no-equals",
      }).pipe(Effect.flip);
      const tokenRow = rowFor(error.rows, "T3CODE_DEV_AUTH_TOKEN");
      assert.ok(tokenRow);
      assert.ok((tokenRow.received ?? "").includes("<redacted>"));
      assert.ok(!(tokenRow.received ?? "").includes("short"));
      const headersRow = rowFor(error.rows, "T3CODE_OTLP_HEADERS");
      assert.ok(headersRow);
      assert.ok(!(headersRow.received ?? "").includes("super-secret-value"));
    }),
  );

  it.effect("renders a table with header, rule and status lines for failures", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({ T3CODE_PORT: "70000" }).pipe(Effect.flip);
      const table = formatEnvValidationTable(
        error.rows.map((row) => ({ ...row, received: row.received ?? "" })),
      );
      assert.include(table, "VARIABLE");
      assert.include(table, "STATUS");
      assert.include(table, "EXPECTED");
      assert.include(table, "RECEIVED");
      assert.include(table, "DESCRIPTION");
      assert.include(table, "T3CODE_PORT");
      assert.include(table, "INVALID");
      assert.include(table, "+--");
    }),
  );

  it.effect("validation error carries only failing rows and a summary", () =>
    Effect.gen(function* () {
      const error = yield* runValidation({
        T3CODE_MODE: "nope",
        T3CODE_PORT: "abc",
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ServerEnvValidationError");
      assert.equal(error.rows.length, 2);
      assert.ok(error.rows.every((row) => row.status === "missing" || row.status === "invalid"));
      assert.include(error.summary, "0 missing");
      assert.include(error.summary, "2 invalid");
    }),
  );

  it.effect("success path exits cleanly, failure path exits non-zero", () =>
    Effect.gen(function* () {
      const ok = Exit.isFailure(yield* Effect.exit(runValidation({})));
      assert.equal(ok, false);
      const failed = Exit.isFailure(
        yield* Effect.exit(runValidation({ T3CODE_PORT: "not-a-port" })),
      );
      assert.equal(failed, true);
    }),
  );
});
