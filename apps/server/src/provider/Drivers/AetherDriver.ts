/**
 * AetherDriver — `ProviderDriver` for Aether cloud tasks.
 *
 * A real snapshot (probe = authenticated `GET /profile`, models from the
 * vendored platform catalog) over the session-core adapter (REST task client
 * + git preflight + workspace WS event pipeline; the turn surface lands with
 * build item 7) and deterministic text-generation stubs. There is no local
 * binary — the driver talks to the Aether REST API and workspace WS,
 * authenticated by the sensitive `AETHER_API_KEY` instance environment
 * variable.
 *
 * @module provider/Drivers/AetherDriver
 */
import { AetherSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAetherTextGeneration } from "../../textGeneration/AetherTextGeneration.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { AetherMirrorRegistry } from "../AetherMirrorRegistry.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  AetherMirrorRegistrationService,
  AetherSessionGitService,
  makeAetherAdapter,
} from "../Layers/AetherAdapter.ts";
import { makeAetherRestClient } from "../Layers/aether/restClient.ts";
import {
  checkAetherProviderStatus,
  makePendingAetherProvider,
  readAetherApiKey,
} from "../Layers/AetherProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeAetherSettings = Schema.decodeSync(AetherSettings);

const DRIVER_KIND = ProviderDriverKind.make("aether");

// Cloud API — no local binary to update, so maintenance is manual-only.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type AetherDriverEnv =
  | AetherMirrorRegistry
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | GitVcsDriver
  | HttpClient.HttpClient
  | ServerConfig
  | ServerSettingsService;

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

export const AetherDriver: ProviderDriver<AetherSettings, AetherDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Aether",
    supportsMultipleInstances: true,
  },
  configSchema: AetherSettings,
  defaultConfig: (): AetherSettings => decodeAetherSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const gitVcsDriver = yield* GitVcsDriver;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies AetherSettings;

      // Missing key is NOT a create() failure: the probe reports it and
      // startSession fails loudly with the remediation — a keyless instance
      // still shows a useful settings card instead of an "unavailable" shadow.
      const apiKey = readAetherApiKey(processEnv);
      const restClient =
        apiKey === undefined
          ? undefined
          : makeAetherRestClient({
              apiBaseUrl: effectiveConfig.apiBaseUrl,
              apiKey,
              httpClient,
            });
      const mirrorRegistry = yield* AetherMirrorRegistry;
      const adapter = yield* makeAetherAdapter({
        instanceId,
        defaultCwd: serverConfig.cwd,
        attachmentsDir: serverConfig.attachmentsDir,
        restClient,
        socket:
          apiKey === undefined ? undefined : { apiBaseUrl: effectiveConfig.apiBaseUrl, apiKey },
      }).pipe(
        Effect.provideService(AetherSessionGitService, gitVcsDriver),
        Effect.provideService(AetherMirrorRegistrationService, mirrorRegistry),
      );
      const textGeneration = makeAetherTextGeneration();

      const checkProvider = checkAetherProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AetherSettings>>({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingAetherProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              // Stable structural phrase; the dynamic cause is preserved below, not folded
              // into the caller-visible message (Effect service conventions).
              detail: "Failed to build the Aether provider snapshot.",
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
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
