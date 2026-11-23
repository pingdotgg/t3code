import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { providerProbeEnvironment } from "@t3tools/provider-core/server/snapshotProbe";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Digest from "effect/crypto/Digest";
import type { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { readOpenCodeChatGptUsageLimits } from "./chatGptUsageLimits.ts";
import type { ProbedOpenCode } from "./versionProbe.ts";

export const makeOpenCodeUsageLimitsProbe = Effect.fn("makeOpenCodeUsageLimitsProbe")(function* ({
  config,
  environment,
  runtime,
  consoleLimits,
}: {
  readonly config: Pick<OpenCodeSettings, "enabled" | "binaryPath" | "serverUrl">;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtime: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly consoleLimits: Effect.Effect<
    ServerProviderUsageLimits | undefined,
    OpenCodeRuntime.OpenCodeRuntimeError
  >;
}) {
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | Digest.Digest
  >();
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const pathService = yield* Path.Path;
  const usageInput = { enabled: config.enabled, serverUrl: config.serverUrl, environment };
  const legacyUsageLimits = readOpenCodeGoUsageLimits(usageInput);
  // The configured CLI owns the database filename, including its build-channel suffix.
  const localDatabasePath = yield* openCodeRuntime
    .runOpenCodeCommand({
      binaryPath: config.binaryPath,
      environment: providerProbeEnvironment(environment),
      args: ["debug", "paths", "db"],
    })
    .pipe(
      Effect.flatMap(({ stdout, code }) => {
        const path = stdout.trim();
        return code === 0 && (path === ":memory:" || pathService.isAbsolute(path))
          ? Effect.succeed(path)
          : Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "debug paths db",
                detail: "OpenCode could not locate its database.",
              }),
            );
      }),
      Effect.timeout("3 seconds"),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
    );
  let unsupportedUsageVersion: string | undefined;
  return Effect.gen(function* () {
    if (!config.enabled) return yield* legacyUsageLimits;
    const { generation, version } = yield* runtime;
    if (generation === "v1") return yield* legacyUsageLimits;
    const limits =
      version === unsupportedUsageVersion
        ? undefined
        : yield* consoleLimits.pipe(Effect.timeout("10 seconds"));
    if (limits === undefined) unsupportedUsageVersion = version;
    if (limits !== undefined && limits.unavailable?.reason !== "unsupported") return limits;
    if (config.serverUrl.trim()) return limits ?? (yield* legacyUsageLimits);
    const configuredDb = environment.OPENCODE_DB;
    const databasePath =
      configuredDb && (configuredDb === ":memory:" || pathService.isAbsolute(configuredDb))
        ? configuredDb
        : yield* localDatabasePath.pipe(Effect.orElseSucceed(() => undefined));
    const legacy = yield* readOpenCodeGoUsageLimits({
      ...usageInput,
      openCode2: { databasePath },
    });
    if (legacy.unavailable?.reason !== "unsupported")
      return limits?.externalUsage ? { ...legacy, externalUsage: limits.externalUsage } : legacy;
    if (databasePath === undefined)
      return {
        ...limits,
        checkedAt: legacy.checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed" as const,
          message: "OpenCode could not locate its database.",
        },
      };
    const chatGpt = yield* readOpenCodeChatGptUsageLimits({
      ...usageInput,
      databasePath,
    });
    if (chatGpt.unavailable?.reason === "unsupported" && !chatGpt.unavailable.message)
      return limits ?? legacy;
    return limits?.externalUsage ? { ...chatGpt, externalUsage: limits.externalUsage } : chatGpt;
  }).pipe(
    Effect.provideContext(services),
    Effect.catch(() =>
      Effect.map(DateTime.now, (now) =>
        makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(now),
          reason: "probeFailed",
          message: "OpenCode could not read workspace usage.",
        }),
      ),
    ),
  );
});
