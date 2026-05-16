import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OllamaSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

import { makeOllamaTextGeneration } from "../../textGeneration/OllamaTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOllamaAdapter } from "../Layers/OllamaAdapter.ts";
import { checkOllamaProviderStatus, makePendingOllamaProvider } from "../Layers/OllamaProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const decodeOllamaSettings = Schema.decodeSync(OllamaSettings);
const DRIVER_KIND = ProviderDriverKind.make("ollama");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type OllamaDriverEnv = ProviderEventLoggers;

const withInstanceIdentity = (input: { readonly instanceId: ProviderInstance["instanceId"]; readonly displayName: string | undefined; readonly accentColor: string | undefined; readonly continuationGroupKey: string }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OllamaDriver: ProviderDriver<OllamaSettings, OllamaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Ollama", supportsMultipleInstances: true },
  configSchema: OllamaSettings,
  defaultConfig: (): OllamaSettings => decodeOllamaSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies OllamaSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const stampIdentity = withInstanceIdentity({ instanceId, displayName, accentColor, continuationGroupKey: continuationIdentity.continuationKey });

      const adapter = yield* makeOllamaAdapter(effectiveConfig, processEnv, { instanceId });
      const textGeneration = yield* makeOllamaTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOllamaProviderStatus(effectiveConfig, processEnv).pipe(Effect.map(stampIdentity));
      const snapshot = yield* makeManagedServerProvider<OllamaSettings>({
        maintenanceCapabilities: { provider: DRIVER_KIND, packageName: null, update: null },
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => makePendingOllamaProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) => publishSnapshot(snapshot),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail: `Failed to build Ollama snapshot: ${cause.message ?? String(cause)}`, cause })));

      return { instanceId, driverKind: DRIVER_KIND, continuationIdentity, displayName, accentColor, enabled, snapshot, adapter, textGeneration } satisfies ProviderInstance;
    }),
};