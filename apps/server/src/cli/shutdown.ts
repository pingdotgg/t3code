import {
  AuthEnvironmentMaintainScope,
  DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  EnvironmentHttpApi,
  type GracefulShutdownInput,
  type GracefulShutdownResult,
  type GracefulShutdownScope,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class ShutdownServerNotRunningError extends Schema.TaggedError<ShutdownServerNotRunningError>()(
  "ShutdownServerNotRunningError",
  { baseDir: Schema.String },
) {
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class ShutdownCliError extends Schema.TaggedError<ShutdownCliError>()("ShutdownCliError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const timeoutSecondsFlag = Flag.Int("timeout").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 60 }))),
  Flag.withDescription(
    "Seconds to wait for in-scope agents to finish after the save prompt (default 120).",
  ),
  Flag.withDefault(Math.floor(DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS / 1000)),
);

const providerFlag = Flag.String("provider").pipe(
  Flag.withDescription("Drain only sessions for this provider instance id."),
  Flag.optional,
);

const sessionFlag = Flag.String("session").pipe(
  Flag.withDescription("Drain only this provider session id."),
  Flag.optional,
);

const noSaveFlag = Flag.Boolean("no-save").pipe(
  Flag.withDescription("Skip the save-work prompt even when the environment setting is on."),
  Flag.withDefault(false),
);

const completeFlag = Flag.Boolean("complete").pipe(
  Flag.withDescription("Clear an active drain and resume queued turns instead of starting one."),
  Flag.withDefault(false),
);

const stopFlag = Flag.Boolean("stop").pipe(
  Flag.withDescription("After a successful drain, send SIGTERM to the server process."),
  Flag.withDefault(false),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const parseScope = (input: {
  readonly provider: Option.Option<string>;
  readonly session: Option.Option<string>;
}): Effect.Effect<GracefulShutdownScope, ShutdownCliError> => {
  if (Option.isSome(input.provider) && Option.isSome(input.session)) {
    return Effect.fail(
      new ShutdownCliError({
        reason: "Pass either --provider or --session, not both.",
      }),
    );
  }
  if (Option.isSome(input.session)) {
    return Effect.succeed({
      type: "session" as const,
      providerSessionId: ProviderSessionId.make(input.session.value),
    });
  }
  if (Option.isSome(input.provider)) {
    return Effect.succeed({
      type: "provider" as const,
      providerInstanceId: ProviderInstanceId.make(input.provider.value),
    });
  }
  return Effect.succeed({ type: "environment" as const });
};

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const withMaintainSession = Effect.fn("cli.shutdown.withMaintainSession")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (input: { readonly origin: string; readonly token: string }) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ShutdownServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      environmentAuth.issueSession({
        scopes: [AuthEnvironmentMaintainScope],
        label: "t3 shutdown cli",
      }),
      (issued) => run({ origin, token: issued.token }),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    ),
  );
});

const formatResult = (result: GracefulShutdownResult) =>
  result.timedOut
    ? `Graceful shutdown timed out after ${result.elapsedMs}ms with ${result.activeRunCount} active run(s) still in scope (${result.shutdownId}).`
    : `Graceful shutdown quiesced in ${result.elapsedMs}ms (${result.shutdownId}).`;

const stopServerProcess = Effect.fn("cli.shutdown.stopServerProcess")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly json: boolean;
}) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return null;
  const pid = runtimeState.value.pid;
  if (typeof pid !== "number" || !isProcessAlive(pid)) return null;
  yield* Effect.try({
    try: () => {
      process.kill(pid, "SIGTERM");
    },
    catch: (cause) =>
      new ShutdownCliError({
        reason:
          cause instanceof Error
            ? `Could not send SIGTERM to server process ${pid}: ${cause.message}`
            : `Could not send SIGTERM to server process ${pid}.`,
      }),
  });
  if (!flags.json) {
    yield* Console.log(`Sent SIGTERM to server process ${pid}.`);
  }
  return pid;
});

export const shutdownCommand = Command.make("shutdown", {
  ...projectLocationFlags,
  timeout: timeoutSecondsFlag,
  provider: providerFlag,
  session: sessionFlag,
  noSave: noSaveFlag,
  complete: completeFlag,
  stop: stopFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Gracefully drain the environment, a provider, or a provider session so updates and other tools can take over.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.complete) {
        yield* withMaintainSession(flags, ({ origin, token }) =>
          Effect.gen(function* () {
            const client = yield* makeLiveServerClient(origin);
            yield* client.maintain.gracefulShutdownComplete({
              headers: { authorization: `Bearer ${token}` },
              payload: {},
            });
          }).pipe(
            Effect.timeout(Duration.seconds(30)),
            Effect.mapError(
              (cause) =>
                new ShutdownCliError({
                  reason:
                    cause instanceof Error
                      ? cause.message
                      : "Could not complete the graceful shutdown.",
                }),
            ),
          ),
        );
        if (flags.json) {
          yield* printJson({ ok: true, completed: true });
        } else {
          yield* Console.log("Cleared graceful shutdown drain; queued turns may start again.");
        }
        return;
      }

      const scope = yield* parseScope(flags);
      if (flags.stop && scope.type !== "environment") {
        return yield* new ShutdownCliError({
          reason: "--stop is only valid for an environment-wide drain.",
        });
      }

      const timeoutMs = Math.max(1_000, flags.timeout * 1000);
      const input: GracefulShutdownInput = {
        scope,
        timeoutMs,
        ...(flags.noSave ? { promptSaveWork: false } : {}),
        reason: "cli-shutdown",
      };

      const result = yield* withMaintainSession(flags, ({ origin, token }) =>
        Effect.gen(function* () {
          const client = yield* makeLiveServerClient(origin);
          return yield* client.maintain.gracefulShutdown({
            headers: { authorization: `Bearer ${token}` },
            payload: input,
          });
        }).pipe(
          Effect.timeout(Duration.millis(timeoutMs + 30_000)),
          Effect.mapError(
            (cause) =>
              new ShutdownCliError({
                reason:
                  cause instanceof Error ? cause.message : "Graceful shutdown request failed.",
              }),
          ),
        ),
      );

      if (result.timedOut) {
        if (flags.json) {
          yield* printJson(result);
        } else {
          yield* Console.log(formatResult(result));
          if (result.saveWorkPrompted) {
            yield* Console.log(`Save-work turns prompted: ${result.saveWorkTurnCount}.`);
          }
          yield* Console.log(
            "Drain remains active so new turns stay queued. Run `t3 shutdown --complete` to resume, or restart the server.",
          );
        }
        return yield* new ShutdownCliError({
          reason: formatResult(result),
        });
      }

      const stoppedPid = flags.stop ? yield* stopServerProcess(flags) : null;

      if (flags.json) {
        yield* printJson(stoppedPid === null ? result : { ...result, stoppedPid });
      } else {
        yield* Console.log(formatResult(result));
        if (result.saveWorkPrompted) {
          yield* Console.log(`Save-work turns prompted: ${result.saveWorkTurnCount}.`);
        }
        if (!flags.stop) {
          yield* Console.log(
            "Drain remains active so new turns stay queued. Run `t3 shutdown --complete` to resume, or restart the server.",
          );
        }
      }
    }),
  ),
);
