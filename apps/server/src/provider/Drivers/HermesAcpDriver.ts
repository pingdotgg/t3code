import {
  HermesAcpSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  HermesAcpAdapterV2Driver,
  type HermesAcpAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/HermesAcpAdapterV2.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialHermesAcpProviderSnapshot,
  checkHermesAcpProviderStatus,
} from "../Layers/HermesAcpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermesAcp");
const decodeSettings = Schema.decodeSync(HermesAcpSettings);

const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Hermes in Code sessions do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export type HermesAcpDriverEnv =
  | HermesAcpAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner;

export const HermesAcpDriver: ProviderDriver<HermesAcpSettings, HermesAcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes in Code",
    supportsMultipleInstances: true,
  },
  configSchema: HermesAcpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies HermesAcpSettings;
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });

      const orchestrationAdapter = yield* HermesAcpAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes in Code ACP orchestration adapter.",
              cause,
            }),
        ),
      );

      const snapshot = yield* makeManagedServerProvider({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialHermesAcpProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider: checkHermesAcpProviderStatus(effectiveConfig, processEnvironment).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        refreshInterval: "5 minutes",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes in Code provider diagnostics.",
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
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
