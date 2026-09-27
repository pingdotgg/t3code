import {
  MuseSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeExternalMspAdapter } from "../Layers/ExternalMspAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { buildMuseMspSpawnInput } from "../msp/MuseMspSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ProviderProbeResult } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);
const DRIVER_KIND = ProviderDriverKind.make("muse");
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const PRESENTATION = { displayName: "Muse", showInteractionModeToggle: false } as const;
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
    ),
};

export type MuseDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

function modelsFromSettings(
  settings: Pick<MuseSettings, "defaultModel" | "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [
      {
        slug: settings.defaultModel,
        name: settings.defaultModel,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

function initialSnapshot(settings: MuseSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (checkedAt) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(checkedAt),
      models: modelsFromSettings(settings),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Muse CLI availability..."
          : "Muse is disabled in T3 Code settings.",
      },
    }),
  );
}

const buildCheckedSnapshot = (
  settings: MuseSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
): ServerProviderDraft =>
  buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: modelsFromSettings(settings),
    probe,
  });

function checkProvider(settings: MuseSettings, environment: NodeJS.ProcessEnv) {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(settings.binaryPath, ["--version"], {
        env: environment,
        extendEnv: true,
      }),
    ).pipe(Effect.timeoutOption("10 seconds"));
    if (Option.isNone(result)) {
      return buildCheckedSnapshot(settings, checkedAt, {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Muse CLI version check timed out.",
      });
    }
    return buildCheckedSnapshot(settings, checkedAt, {
      installed: result.value.code === 0,
      version: parseGenericCliVersion(`${result.value.stdout}\n${result.value.stderr}`),
      status: result.value.code === 0 ? "ready" : "warning",
      auth: { status: "unknown" },
      ...(result.value.code === 0
        ? {}
        : {
            message:
              result.value.stderr.trim() ||
              result.value.stdout.trim() ||
              "Muse CLI version check failed.",
          }),
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return buildCheckedSnapshot(settings, checkedAt, {
          installed: !isCommandMissingCause(cause),
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: isCommandMissingCause(cause)
            ? `Muse CLI command '${settings.binaryPath}' was not found.`
            : "Muse CLI availability check failed.",
        });
      }),
    ),
  );
}

function unsupportedTextGeneration(): ProviderInstance["textGeneration"] {
  const fail = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
  ) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Muse does not provide T3 text-generation helpers yet.",
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
}

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => decodeMuseSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies MuseSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const adapter = yield* makeExternalMspAdapter({
        provider: DRIVER_KIND,
        instanceId,
        defaultModel: effectiveConfig.defaultModel,
        spawn: (cwd, env) => buildMuseMspSpawnInput(effectiveConfig, cwd, env),
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          initialSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkProvider(effectiveConfig, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
