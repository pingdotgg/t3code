import {
  DEFAULT_HERMES_MODEL,
  HERMES_DRIVER_KIND,
  HermesSettings,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

export type HermesDriverEnv = Crypto.Crypto;

const unsupportedTextGeneration = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Hermes gateway instances do not support utility text generation.",
    }),
  );

const makeTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: HERMES_DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const broker = yield* HermesGatewayBroker;
      const adapter = yield* makeHermesAdapter({ instanceId });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: HERMES_DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: HERMES_DRIVER_KIND,
        packageName: null,
      });
      const getSnapshot = Effect.gen(function* () {
        const connected = yield* broker.isConnected(instanceId);
        const status = yield* broker
          .getInstanceStatus(instanceId)
          .pipe(Effect.catchTag("HermesGatewayManagementError", () => Effect.succeed(undefined)));
        return {
          instanceId,
          driver: HERMES_DRIVER_KIND,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: true,
          enabled,
          installed: true,
          version: status?.hermesVersion ?? null,
          status: !enabled ? "disabled" : connected ? "ready" : "warning",
          auth: {
            status: connected ? "authenticated" : "unauthenticated",
            type: "gateway",
            label: status?.nickname ?? displayName ?? "Hermes",
          },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(!connected && enabled
            ? { message: "Hermes is offline. Reconnect its T3 Code gateway plugin." }
            : {}),
          availability: "available",
          models: [
            {
              slug: DEFAULT_HERMES_MODEL,
              name: "Hermes",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const snapshot = {
        maintenanceCapabilities,
        getSnapshot,
        refresh: getSnapshot,
        streamChanges: broker.streamStatuses.pipe(
          Stream.filter((status) => status.instanceId === instanceId),
          Stream.mapEffect(() => getSnapshot),
        ),
      };

      return {
        instanceId,
        driverKind: HERMES_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
