import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/AcpRegistryAdapterV2.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

const makeSnapshot = (input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly settings: AcpRegistrySettings;
  readonly continuationKey: string;
  readonly checkedAt: string;
}): ServerProvider => {
  const modelIds = Array.from(new Set(["default", ...input.settings.customModels]));
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    enabled: input.enabled,
    installed: true,
    version: null,
    status: input.enabled ? "ready" : "disabled",
    auth: { status: "unknown" },
    checkedAt: input.checkedAt,
    models: modelIds.map((model) => ({
      slug: model,
      name: model,
      isCustom: model !== "default",
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
};

export type AcpRegistryDriverEnv = AcpRegistryAdapterV2DriverEnv;

/** Canonical provider-instance wrapper for ACP Registry orchestration adapters. */
export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const orchestrationAdapter = yield* AcpRegistryAdapterV2Driver.create({
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
              detail: "Failed to build ACP Registry orchestration adapter.",
              cause,
            }),
        ),
      );
      const currentSnapshot = () =>
        makeSnapshot({
          instanceId,
          displayName,
          accentColor,
          enabled,
          settings: config,
          continuationKey: continuationIdentity.continuationKey,
          checkedAt,
        });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: Effect.sync(currentSnapshot),
          refresh: Effect.sync(currentSnapshot),
          streamChanges: Stream.empty,
        },
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
