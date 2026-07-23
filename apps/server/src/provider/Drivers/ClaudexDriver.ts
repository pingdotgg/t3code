/**
 * ClaudexDriver — Claudex models routed through the Claude Code harness.
 *
 * Claudex intentionally reuses the Claude adapter and provider probe while
 * exposing only the two models served by the `claudex` CLI.
 *
 * @module provider/Drivers/ClaudexDriver
 */
import {
  ClaudexSettings,
  type ClaudexSettings as ClaudexSettingsType,
  type ClaudeSettings,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  type ClaudeProviderIdentity,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  CLAUDEX_DEFAULT_MODEL,
  CLAUDEX_MODELS,
  CLAUDEX_MODEL_SLUGS,
  getClaudexModelCapabilities,
  normalizeClaudexEffort,
} from "../claudexModels.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudex");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodeClaudexSettings = Schema.decodeSync(ClaudexSettings);

export function normalizeClaudexModelSelection(
  modelSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (modelSelection === undefined) return undefined;
  return {
    ...modelSelection,
    model: CLAUDEX_MODEL_SLUGS.has(modelSelection.model)
      ? modelSelection.model
      : CLAUDEX_DEFAULT_MODEL,
  };
}

function normalizeRequiredClaudexModelSelection(modelSelection: ModelSelection): ModelSelection {
  return normalizeClaudexModelSelection(modelSelection)!;
}

const CLAUDEX_IDENTITY: ClaudeProviderIdentity = {
  provider: DRIVER_KIND,
  displayName: "Claudex",
  showInteractionModeToggle: true,
  disabledMessage: "Claudex is disabled in SergeCode settings.",
  uncheckedMessage: "Claudex provider status has not been checked in this session yet.",
  commandMissingMessage: "Claudex requires the Claudex CLI (`claudex`) to be installed.",
  healthCheckFailedMessage: "Failed to execute Claudex health check.",
  timedOutMessage: "Claudex is installed but timed out while checking provider status.",
  commandFailedMessage: "Claudex is installed but failed to run.",
  authUnknownMessage: "Could not verify Claudex authentication status from initialization result.",
};

const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

function toClaudeSettings(config: ClaudexSettingsType): ClaudeSettings {
  return {
    enabled: config.enabled,
    binaryPath: config.binaryPath,
    homePath: config.homePath,
    customModels: config.customModels,
    launchArgs: config.launchArgs,
  } satisfies ClaudeSettings;
}

export function makeClaudexContinuationGroupKey(
  config: Pick<ClaudexSettingsType, "homePath">,
): Effect.Effect<string, never, Path.Path> {
  return resolveClaudeHomePath(config).pipe(Effect.map((homePath) => `claudex:home:${homePath}`));
}

export function normalizeClaudexProviderSnapshot(
  snapshot: ServerProviderDraft,
): ServerProviderDraft {
  return {
    ...snapshot,
    models: CLAUDEX_MODELS,
  };
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export type ClaudexDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClaudexDriver: ProviderDriver<ClaudexSettingsType, ClaudexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claudex",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudexSettings,
  defaultConfig: (): ClaudexSettingsType => decodeClaudexSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies ClaudexSettingsType;
      const claudeSettings = toClaudeSettings(effectiveConfig);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudexContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const rawAdapter = yield* makeClaudeAdapter(claudeSettings, {
        instanceId,
        driverKind: DRIVER_KIND,
        environment: processEnv,
        getModelCapabilities: getClaudexModelCapabilities,
        normalizeEffort: normalizeClaudexEffort,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const adapter = {
        ...rawAdapter,
        startSession: (input) =>
          rawAdapter.startSession({
            ...input,
            ...(input.modelSelection
              ? { modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection) }
              : {}),
          }),
        sendTurn: (input) =>
          rawAdapter.sendTurn({
            ...input,
            ...(input.modelSelection
              ? { modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection) }
              : {}),
          }),
      } satisfies typeof rawAdapter;
      const rawTextGeneration = yield* makeClaudeTextGeneration(claudeSettings, processEnv, {
        getModelCapabilities: getClaudexModelCapabilities,
        normalizeEffort: normalizeClaudexEffort,
      });
      const textGeneration = {
        ...rawTextGeneration,
        generateCommitMessage: (input) =>
          rawTextGeneration.generateCommitMessage({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
        generatePrContent: (input) =>
          rawTextGeneration.generatePrContent({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
        generateBranchName: (input) =>
          rawTextGeneration.generateBranchName({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
        generateThreadTitle: (input) =>
          rawTextGeneration.generateThreadTitle({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
        generateScenerySet: (input) =>
          rawTextGeneration.generateScenerySet({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
        generateAutoReviewFindings: (input) =>
          rawTextGeneration.generateAutoReviewFindings({
            ...input,
            modelSelection: normalizeRequiredClaudexModelSelection(input.modelSelection),
          }),
      } satisfies typeof rawTextGeneration;
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);

      const checkProvider = checkClaudeProviderStatus(
        claudeSettings,
        () =>
          probeClaudeCapabilities(claudeSettings, processEnv).pipe(
            Effect.provideService(Path.Path, path),
          ),
        processEnv,
        CLAUDEX_IDENTITY,
      ).pipe(
        Effect.map(normalizeClaudexProviderSnapshot),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ClaudexSettingsType>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(toClaudeSettings(settings.provider), CLAUDEX_IDENTITY).pipe(
            Effect.map(normalizeClaudexProviderSnapshot),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claudex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
