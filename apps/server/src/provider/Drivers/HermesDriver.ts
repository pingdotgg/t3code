import {
  HermesSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const HERMES_DEFAULT_MODEL = {
  slug: "default",
  name: "Hermes profile default",
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
} as const;

export type HermesDriverEnv = ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path;

const makeUnsupportedTextGeneration = (): TextGeneration.TextGeneration["Service"] => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Hermes text generation is not supported by this provider spike.",
      }),
    );
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  });
};

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
      const adapter = yield* makeHermesAdapter(effectiveConfig, {
        environment: mergeProviderInstanceEnvironment(environment),
        instanceId,
      });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const snapshot: ServerProvider = {
        ...buildServerProvider({
          presentation: {
            displayName: displayName ?? "Hermes",
            badgeLabel: "Experimental",
            showInteractionModeToggle: false,
          },
          enabled,
          checkedAt,
          models: [HERMES_DEFAULT_MODEL],
          probe: enabled
            ? {
                installed: true,
                version: null,
                status: "warning",
                auth: { status: "unknown" },
                message: "Hermes ACP availability is verified when a session starts.",
              }
            : {
                installed: false,
                version: null,
                status: "warning",
                auth: { status: "unknown" },
                message: "Hermes is disabled in T3 Code settings.",
              },
        }),
        instanceId,
        driver: DRIVER_KIND,
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      };
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
        },
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
