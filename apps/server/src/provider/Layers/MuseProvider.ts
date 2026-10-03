import {
  type CustomModelSetting,
  type MuseSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import { createMuseSdkHost, makeMuseEnvironment } from "../museSdk.ts";
import { parseMuseVersion } from "../museMaintenance.ts";
import { discoverMuseModels, museModelCapabilities } from "../museModelCatalog.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
} from "../providerSnapshot.ts";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
} as const;

export const MUSE_DEFAULT_MODEL = "muse-spark-1.3-contributor";

function museModelsFromSettings(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
) {
  return providerModelsFromSettings(
    models,
    customModels.map((entry) => {
      const model = typeof entry === "string" ? { slug: entry } : entry;
      return {
        ...model,
        capabilities: model.capabilities ?? museModelCapabilities(model.slug.trim()),
      };
    }),
    museModelCapabilities(""),
  );
}

export const makePendingMuseProvider = Effect.fn("makePendingMuseProvider")(function* (
  settings: MuseSettings,
) {
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: museModelsFromSettings([], settings.customModels),
    slashCommands: settings.enabled ? [COMPACT_SLASH_COMMAND] : [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Muse Code CLI availability..."
        : "Muse Code is disabled in T3 Code settings.",
    },
  });
});

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  settings: MuseSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  if (!settings.enabled) return yield* makePendingMuseProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const museEnvironment = makeMuseEnvironment(environment);
  const snapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel> = []) =>
    buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: museModelsFromSettings(models, settings.customModels),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe,
    });
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: museEnvironment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: museEnvironment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Muse Code CLI (`muse`) was not found. Install Muse Code and run `muse login` on this T3 server host."
        : "Failed to execute Muse Code CLI. Check its binary path on this T3 server host.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Muse Code CLI version check timed out.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseMuseVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Muse Code CLI is installed but failed to run.",
    });
  }

  const catalog = yield* discoverMuseModels(settings, museEnvironment, cwd, createHost).pipe(
    Effect.scoped,
    Effect.timeoutOption(12_000),
    Effect.result,
  );
  if (Result.isFailure(catalog) || Option.isNone(catalog.success)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Muse Code SDK could not read the model catalog. Check your Muse installation and run `muse login` on this T3 server host.",
    });
  }
  const models = catalog.success.value;
  return snapshot(
    {
      installed: true,
      version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      message:
        models.length > 0
          ? "Muse Code is available. Authentication and subscription billing are not reported by the SDK; use `muse login` on this T3 server host."
          : "Muse Code returned no models. Run `muse login` on this T3 server host and refresh its status.",
    },
    models,
  );
});
