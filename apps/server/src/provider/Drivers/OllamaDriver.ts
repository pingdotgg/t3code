import { OllamaSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOllamaAdapter } from "../Layers/OllamaAdapter.ts";
import {
  buildInitialOllamaProviderSnapshot,
  checkOllamaProviderStatus,
} from "../Layers/OllamaProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { makeOllamaTextGeneration } from "../../textGeneration/OllamaTextGeneration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("ollama");
const decode = Schema.decodeSync(OllamaSettings);
export type OllamaDriverEnv = BackgroundPolicy.BackgroundPolicy | ServerSettingsService;

export const OllamaDriver: ProviderDriver<OllamaSettings, OllamaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Ollama", supportsMultipleInstances: true },
  configSchema: OllamaSettings,
  defaultConfig: () => decode({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const effectiveConfig = { ...config, enabled } satisfies OllamaSettings;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makeOllamaAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const textGeneration = makeOllamaTextGeneration(effectiveConfig, processEnv);
      const settingsSource = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OllamaSettings>>({
        resolveMaintenance: () =>
          Effect.succeed({ provider: DRIVER_KIND, packageName: null, update: null }),
        getSettings: settingsSource.getSettings,
        streamSettings: settingsSource.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOllamaProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOllamaProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.map(stamp),
        ),
        refreshOnInterval: true,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Ollama snapshot: ${cause.message ?? String(cause)}`,
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
