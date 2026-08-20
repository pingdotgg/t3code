import {
  DevinCloudSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDevinCloudAdapter } from "../Layers/DevinCloudAdapter.ts";
import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
} from "../Layers/DevinCloudProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("devinCloud");
const decodeSettings = Schema.decodeSync(DevinCloudSettings);

export type DevinCloudDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
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

const unsupportedTextGeneration = {
  generateCommitMessage: () => failTextGeneration("generateCommitMessage"),
  generatePrContent: () => failTextGeneration("generatePrContent"),
  generateBranchName: () => failTextGeneration("generateBranchName"),
  generateThreadTitle: () => failTextGeneration("generateThreadTitle"),
} satisfies ProviderInstance["textGeneration"];

export const DevinCloudDriver: ProviderDriver<DevinCloudSettings, DevinCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Devin Cloud", supportsMultipleInstances: true },
  configSchema: DevinCloudSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
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
      const effectiveConfig = { ...config, enabled } satisfies DevinCloudSettings;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const adapter = yield* makeDevinCloudAdapter(effectiveConfig, { instanceId }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Path.Path, path),
      );
      const checkProvider = checkDevinCloudProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Path.Path, path),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DevinCloudSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialDevinCloudProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Devin Cloud snapshot: ${cause.message ?? String(cause)}`,
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
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};

function failTextGeneration(operation: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Devin Cloud cannot be used for T3's auxiliary text-generation tasks.",
    }),
  );
}
