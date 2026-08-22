/**
 * ZaiDriver — `ProviderDriver` for Z.ai's GLM Coding Plan.
 *
 * Z.ai has no CLI of its own; its endpoint is Anthropic-compatible and
 * officially supported by Claude Code. This driver therefore instantiates the
 * Claude runtime (adapter, text generation, probes) with the Z.ai endpoint
 * environment and a dedicated `CLAUDE_CONFIG_DIR`, and stamps its own driver
 * kind on sessions and events. Threads can never resume across stock Claude
 * and Z.ai instances: the driver kind differs and the continuation group key
 * resolves against the Z.ai home path.
 *
 * @module provider/Drivers/ZaiDriver
 */
import { ProviderDriverKind, ZaiSettings, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import { probeClaudeCapabilities } from "../Layers/ClaudeProvider.ts";
import {
  buildInitialZaiProviderSnapshot,
  checkZaiProviderStatus,
  enrichZaiSnapshot,
} from "../Layers/ZaiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { isClaudeNativeCommandPath, type ClaudeDriverEnv } from "./ClaudeDriver.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
} from "./ClaudeHome.ts";
import { claudeSettingsForZai, zaiInstanceEnvironment } from "./ZaiHome.ts";

const decodeZaiSettings = Schema.decodeSync(ZaiSettings);

const DRIVER_KIND = ProviderDriverKind.make("zai");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

// Same binary as stock Claude, so the update machinery is the Claude one
// under the Z.ai driver's identity (separate native-update lock).
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "zai-claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ZaiDriverEnv = ClaudeDriverEnv;

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

export const ZaiDriver: ProviderDriver<ZaiSettings, ZaiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Z.ai",
    supportsMultipleInstances: true,
  },
  configSchema: ZaiSettings,
  defaultConfig: (): ZaiSettings => decodeZaiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      // Endpoint + token first, user-declared environment after: explicit
      // instance env vars win over config-derived values.
      const processEnv = mergeProviderInstanceEnvironment(
        zaiInstanceEnvironment(config, environment),
      );
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = claudeSettingsForZai(config, enabled);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapter = yield* makeClaudeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        driverKind: DRIVER_KIND,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv);

      // Per-instance capabilities cache, keyed on binary + resolved HOME so
      // probes never cross-contaminate auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

      const checkProvider = checkZaiProviderStatus(
        { ...config, enabled },
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
        cwd,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<typeof effectiveConfig>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialZaiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: current, publishSnapshot }) =>
          enrichZaiSnapshot({
            snapshot: current,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Z.ai snapshot: ${cause.message ?? String(cause)}`,
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
