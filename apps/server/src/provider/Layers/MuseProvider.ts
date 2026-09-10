import {
  MUSE_REASONING_EFFORT_OPTIONS,
  type MuseSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { createMuseSdkHost, makeMuseEnvironment, type MuseSdkHost } from "../museSdk.ts";
import { parseMuseVersion } from "../museMaintenance.ts";
import {
  buildServerProvider,
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
export const MUSE_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "medium",
      options: MUSE_REASONING_EFFORT_OPTIONS,
    },
  ],
});

const ModelCatalog = Schema.Struct({
  providerId: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      modelId: Schema.NonEmptyString,
      displayLabel: Schema.String,
      providerId: Schema.String,
      isDefault: Schema.Boolean,
    }),
  ),
});
const decodeModelCatalog = Schema.decodeUnknownEffect(ModelCatalog);

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

export const discoverMuseModels = Effect.fn("discoverMuseModels")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const host = yield* Effect.acquireRelease(
    Effect.tryPromise<MuseSdkHost>((signal) =>
      createHost({
        binaryPath: settings.binaryPath,
        environment,
        ...(cwd ? { cwd } : {}),
        readOnly: true,
        signal,
        startupTimeoutMs: 8_000,
      }),
    ),
    (host: MuseSdkHost) => Effect.promise(() => host.close()),
    { interruptible: true },
  );
  const result = yield* Effect.tryPromise(() => host.connection.request("model/list", {}));
  const catalog = yield* decodeModelCatalog(result);
  if (catalog.providerId !== "meta") {
    return yield* new MuseCatalogError({ detail: "Muse returned a catalog for another provider." });
  }
  const seen = new Set<string>();
  return catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [
      {
        slug: model.modelId,
        name: model.displayLabel.trim() || model.modelId,
        isCustom: false,
        isDefault: model.isDefault,
        capabilities: MUSE_MODEL_CAPABILITIES,
      },
    ];
  });
});

export const makePendingMuseProvider = Effect.fn("makePendingMuseProvider")(function* (
  settings: MuseSettings,
) {
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings([], settings.customModels, MUSE_MODEL_CAPABILITIES),
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
      models: providerModelsFromSettings(models, settings.customModels, MUSE_MODEL_CAPABILITIES),
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
