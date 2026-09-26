import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeCli } from "../bin.ts";
import { type CliServerFlags, serverEnvSpecs, serverEnvironmentConfig } from "./config.ts";
import {
  type ServerEnvVariableRow,
  ServerEnvValidationError,
  runServerEnvironmentValidation,
  runValidateConfig,
  validateServerEnvironment,
} from "./envValidation.ts";
import { runServerCommand } from "./server.ts";

const configLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

const runValidation = (env: Record<string, string>) =>
  validateServerEnvironment.pipe(
    Effect.provide(Layer.mergeAll(configLayer(env), NodeServices.layer)),
  );

const rowFor = (
  rows: ReadonlyArray<ServerEnvVariableRow>,
  variable: string,
): ServerEnvVariableRow | undefined => rows.find((row) => row.variable === variable);

const isUserError = Schema.is(CliError.UserError);
const isServerEnvValidationError = Schema.is(ServerEnvValidationError);

const expectUserError = (error: unknown): CliError.UserError => {
  if (!isUserError(error)) {
    throw new Error("Expected UserError");
  }
  return error;
};

const expectValidationError = (error: unknown): ServerEnvValidationError => {
  if (!isServerEnvValidationError(error)) {
    throw new Error("Expected ServerEnvValidationError");
  }
  return error;
};

const serverFlags = (validateConfig = false): CliServerFlags => ({
  validateConfig: Option.some(validateConfig),
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
});

const runValidationFlag = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Command.runWith(makeCli({ cloudEnabled: false }), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NetService.layer, configLayer(env), TestConsole.layer),
    ),
  );

const invalidStartupEnvironment: ReadonlyArray<readonly [string, string]> = [
  ["T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD", "maybe"],
  ["T3CODE_CODEX_LAUNCH_ARGS", '"unterminated'],
  ["T3CODE_RESOURCE_MONITOR_PATH", "relative/resource-monitor"],
  ["T3CODE_TELEMETRY_ENABLED", "maybe"],
  ["T3CODE_TELEMETRY_FLUSH_BATCH_SIZE", "many"],
  ["T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS", "many"],
  ["T3CODE_POSTHOG_HOST", "not a url"],
  ["T3CODE_BITBUCKET_API_BASE_URL", "not a url"],
  ["T3CODE_RELAY_URL", "http://relay.example.test"],
  ["T3CODE_HOSTED_APP_URL", "not a url"],
  ["T3CODE_RELAY_CLIENT_OTLP_TRACES_URL", "not a url"],
  ["T3CODE_RELEASE_BASE_URL", "not a url"],
];

const runNormalStartup = (env: Record<string, string>) =>
  runServerCommand(serverFlags()).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        Layer.succeed(GlobalFlag.LogLevel, Option.none()),
        configLayer(env),
      ),
    ),
    Effect.flip,
  );

describe("server environment validation", () => {
  it.effect("prints every optional and default row on success", () =>
    Effect.gen(function* () {
      yield* runValidateConfig.pipe(
        Effect.provide(Layer.mergeAll(configLayer({}), NodeServices.layer, TestConsole.layer)),
      );
      const output = (yield* TestConsole.logLines)
        .filter((line): line is string => typeof line === "string")
        .join("\n");

      assert.include(output, "Server environment validation succeeded:");
      assert.include(output, "T3CODE_OTLP_PROTOCOL");
      assert.include(output, "(default: http/json)");
      assert.include(output, "T3CODE_PORT");
      assert.include(output, "(unset)");
      for (const spec of serverEnvSpecs) {
        assert.include(output, spec.variable);
      }
    }),
  );

  it.effect("prints defaults alongside failures", () =>
    Effect.gen(function* () {
      const error = yield* runServerEnvironmentValidation.pipe(
        Effect.provide(
          Layer.mergeAll(
            configLayer({ T3CODE_PORT: "70000" }),
            NodeServices.layer,
            TestConsole.layer,
          ),
        ),
        Effect.flip,
      );

      const userError = expectUserError(error);
      assert.include(userError.userMessage ?? "", "Server environment validation failed:");
      assert.include(userError.userMessage ?? "", "T3CODE_PORT");
      assert.include(userError.userMessage ?? "", "INVALID");
      assert.include(userError.userMessage ?? "", "(default: http/json)");
      assert.include(userError.userMessage ?? "", "(unset)");
    }),
  );

  it.effect("rejects invalid startup before config resolution or service initialization", () =>
    Effect.gen(function* () {
      const error = yield* runServerCommand(serverFlags()).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NetService.layer,
            Layer.succeed(GlobalFlag.LogLevel, Option.none()),
            configLayer({ T3CODE_PORT: "not-a-port" }),
          ),
        ),
        Effect.flip,
      );

      const userError = expectUserError(error);
      assert.include(userError.userMessage ?? "", "T3CODE_PORT");
      assert.include(userError.userMessage ?? "", "not-a-port");
    }),
  );

  it.effect("keeps --validate-config exit behavior identical on root, start, and serve", () =>
    Effect.gen(function* () {
      for (const args of [
        ["--validate-config"],
        ["start", "--validate-config"],
        ["serve", "--validate-config"],
      ]) {
        const result = yield* runValidationFlag(args, {}).pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(result));
      }

      for (const args of [
        ["--validate-config"],
        ["start", "--validate-config"],
        ["serve", "--validate-config"],
      ]) {
        const valid = yield* runValidationFlag(args, {
          T3CODE_CODEX_LAUNCH_ARGS: '--enable "feature flag"',
          T3CODE_RESOURCE_MONITOR_PATH: process.execPath,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(valid));
      }

      for (const args of [
        ["--validate-config"],
        ["start", "--validate-config"],
        ["serve", "--validate-config"],
      ]) {
        const error = yield* runValidationFlag(args, { T3CODE_MODE: "invalid" }).pipe(Effect.flip);
        expectUserError(error);
      }
    }),
  );

  it.effect("rejects every discovered startup value in both startup paths", () =>
    Effect.gen(function* () {
      for (const [variable, value] of invalidStartupEnvironment) {
        const env = { [variable]: value };
        const validationError = expectValidationError(yield* runValidation(env).pipe(Effect.flip));
        assert.strictEqual(rowFor(validationError.rows, variable)?.status, "invalid");

        const normalError = expectUserError(yield* runNormalStartup(env));
        const flagError = expectUserError(
          yield* runValidationFlag(["--validate-config"], env).pipe(Effect.flip),
        );
        assert.include(normalError.userMessage ?? "", variable);
        assert.include(flagError.userMessage ?? "", variable);
      }
    }),
  );

  it.effect("rejects values through the same Config decoders used by startup", () =>
    Effect.gen(function* () {
      const validationError = yield* runValidation({
        T3CODE_LOG_LEVEL: "Verbose",
        T3CODE_MODE: "space-shuttle",
        T3CODE_NO_BROWSER: "maybe",
        T3CODE_OTLP_TRACES_URL: "not a url",
        T3CODE_PORT: "70000",
        T3CODE_TRACE_MAX_FILES: "ten",
      }).pipe(Effect.flip);
      const error = expectValidationError(validationError);
      const port = rowFor(error.rows, "T3CODE_PORT");
      const logLevel = rowFor(error.rows, "T3CODE_LOG_LEVEL");
      const mode = rowFor(error.rows, "T3CODE_MODE");
      const noBrowser = rowFor(error.rows, "T3CODE_NO_BROWSER");
      const tracesUrl = rowFor(error.rows, "T3CODE_OTLP_TRACES_URL");
      const maxFiles = rowFor(error.rows, "T3CODE_TRACE_MAX_FILES");

      assert.strictEqual(error._tag, "ServerEnvValidationError");
      assert.equal(error.rows.length, serverEnvSpecs.length);
      assert.strictEqual(port?.status, "invalid");
      assert.strictEqual(logLevel?.status, "invalid");
      assert.strictEqual(mode?.status, "invalid");
      assert.strictEqual(noBrowser?.status, "invalid");
      assert.strictEqual(tracesUrl?.status, "invalid");
      assert.strictEqual(maxFiles?.status, "invalid");
    }),
  );

  it.effect("matches ConfigProvider handling of present empty values", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({ T3CODE_PORT: "" });
      const port = rowFor(rows, "T3CODE_PORT");

      assert.strictEqual(port?.status, "ok");
      assert.strictEqual(port?.received, "(unset)");
    }),
  );

  it.effect("accepts the canonical boolean and log-level literals", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({
        T3CODE_LOG_LEVEL: "Debug",
        T3CODE_NO_BROWSER: "yes",
        T3CODE_TRACE_TIMING_ENABLED: "0",
      });

      assert.equal(rows.filter((row) => row.status !== "ok").length, 0);
    }),
  );

  it.effect("accepts strict lifecycle guard boolean aliases", () =>
    Effect.gen(function* () {
      for (const value of ["false", "0", "off", "no"]) {
        const rows = yield* runValidation({
          T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD: value,
        });
        assert.equal(
          rows.find((row) => row.variable === "T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD")?.status,
          "ok",
        );
      }
    }),
  );

  it.effect("parses validated Codex launch arguments and preserves the default", () =>
    Effect.gen(function* () {
      const value = '--enable "feature flag" --config model="gpt 5"';
      const rows = yield* runValidation({ T3CODE_CODEX_LAUNCH_ARGS: value });
      assert.equal(rows.find((row) => row.variable === "T3CODE_CODEX_LAUNCH_ARGS")?.status, "ok");
      const args = yield* serverEnvironmentConfig.codexLaunchArgs.pipe(
        Effect.provide(configLayer({ T3CODE_CODEX_LAUNCH_ARGS: value })),
      );
      assert.deepEqual(args, ["--enable", "feature flag", "--config", "model=gpt 5"]);

      const defaultRows = yield* runValidation({});
      assert.equal(
        defaultRows.find((row) => row.variable === "T3CODE_CODEX_LAUNCH_ARGS")?.received,
        "(unset)",
      );
      const defaultArgs = yield* serverEnvironmentConfig.codexLaunchArgs.pipe(
        Effect.provide(configLayer({})),
      );
      assert.isUndefined(defaultArgs);
    }),
  );

  it.effect("validates a present resource monitor executable and allows its default", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({ T3CODE_RESOURCE_MONITOR_PATH: process.execPath });
      assert.equal(
        rows.find((row) => row.variable === "T3CODE_RESOURCE_MONITOR_PATH")?.status,
        "ok",
      );
      const defaultRows = yield* runValidation({});
      assert.equal(
        defaultRows.find((row) => row.variable === "T3CODE_RESOURCE_MONITOR_PATH")?.received,
        "(unset)",
      );
    }),
  );

  it.effect("rejects a missing resource monitor override in validation and startup", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingPath =
        platform === "win32"
          ? "C:\\missing-t3-resource-monitor.exe"
          : "/missing-t3-resource-monitor";
      const env = { T3CODE_RESOURCE_MONITOR_PATH: missingPath };
      const validationError = expectValidationError(yield* runValidation(env).pipe(Effect.flip));
      assert.strictEqual(
        rowFor(validationError.rows, "T3CODE_RESOURCE_MONITOR_PATH")?.status,
        "invalid",
      );
      const normalError = expectUserError(yield* runNormalStartup(env));
      const flagError = expectUserError(
        yield* runValidationFlag(["--validate-config"], env).pipe(Effect.flip),
      );
      assert.include(normalError.userMessage ?? "", "T3CODE_RESOURCE_MONITOR_PATH");
      assert.include(flagError.userMessage ?? "", "T3CODE_RESOURCE_MONITOR_PATH");
    }),
  );

  it.effect("accepts secure relay trace endpoints with paths", () =>
    Effect.gen(function* () {
      const rows = yield* runValidation({
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://relay.example.test/v1/traces",
      });
      assert.equal(
        rows.find((row) => row.variable === "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL")?.status,
        "ok",
      );
    }),
  );

  it.effect("redacts complete secret values from failure output", () =>
    Effect.gen(function* () {
      const devToken = "short-development-secret";
      const headerSecret = "super-secret-header-value";
      const posthogSecret = "posthog-secret-value";
      const bitbucketSecret = "bitbucket-secret-value";
      const relayTraceSecret = "relay-trace-secret-value";
      const codexArgsSecret = "codex-args-secret-value";
      const resourceMonitorSecret = "resource-monitor-secret-value";
      const error = yield* runServerEnvironmentValidation.pipe(
        Effect.provide(
          Layer.mergeAll(
            configLayer({
              T3CODE_DEV_AUTH_TOKEN: devToken,
              T3CODE_OTLP_HEADERS: `authorization=${headerSecret}, malformed`,
              T3CODE_POSTHOG_KEY: posthogSecret,
              T3CODE_BITBUCKET_ACCESS_TOKEN: bitbucketSecret,
              T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: relayTraceSecret,
              T3CODE_CODEX_LAUNCH_ARGS: `--config token=${codexArgsSecret}`,
              T3CODE_RESOURCE_MONITOR_PATH: `relative/${resourceMonitorSecret}`,
            }),
            NodeServices.layer,
            TestConsole.layer,
          ),
        ),
        Effect.flip,
      );

      const userError = expectUserError(error);
      for (const secret of [
        devToken,
        headerSecret,
        posthogSecret,
        bitbucketSecret,
        relayTraceSecret,
        codexArgsSecret,
        resourceMonitorSecret,
      ]) {
        assert.notInclude(userError.userMessage ?? "", secret);
      }
      assert.include(userError.userMessage ?? "", "T3CODE_DEV_AUTH_TOKEN");
      assert.include(userError.userMessage ?? "", "T3CODE_OTLP_HEADERS");
      assert.include(userError.userMessage ?? "", "T3CODE_POSTHOG_KEY");
      assert.include(userError.userMessage ?? "", "T3CODE_BITBUCKET_ACCESS_TOKEN");
      assert.include(userError.userMessage ?? "", "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN");
      assert.include(userError.userMessage ?? "", "T3CODE_CODEX_LAUNCH_ARGS");
      assert.include(userError.userMessage ?? "", "T3CODE_RESOURCE_MONITOR_PATH");
      assert.include(userError.userMessage ?? "", "<redacted>");
    }),
  );

  it.effect("returns every row and the failure summary", () =>
    Effect.gen(function* () {
      const validationError = yield* runValidation({
        T3CODE_MODE: "nope",
        T3CODE_PORT: "abc",
      }).pipe(Effect.flip);
      const error = expectValidationError(validationError);

      assert.strictEqual(error._tag, "ServerEnvValidationError");
      assert.equal(error.rows.length, serverEnvSpecs.length);
      assert.include(error.summary, "0 missing");
      assert.include(error.summary, "2 invalid");
    }),
  );
});
