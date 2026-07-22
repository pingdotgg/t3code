import { PiSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProcessRunner } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const DRIVER_KIND = ProviderDriverKind.make("pi");
const SETUP_MESSAGE = "Pi session runtime is not available until Pi native session support is enabled.";

const unavailableAdapter: ProviderAdapterShape<ProviderAdapterRequestError> = {
  provider: DRIVER_KIND,
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "startSession", detail: SETUP_MESSAGE })),
  sendTurn: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "sendTurn", detail: SETUP_MESSAGE })),
  interruptTurn: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "interruptTurn", detail: SETUP_MESSAGE })),
  respondToRequest: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "respondToRequest", detail: SETUP_MESSAGE })),
  respondToUserInput: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "respondToUserInput", detail: SETUP_MESSAGE })),
  stopSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "readThread", detail: SETUP_MESSAGE })),
  rollbackThread: () => Effect.fail(new ProviderAdapterRequestError({ provider: DRIVER_KIND, method: "rollbackThread", detail: SETUP_MESSAGE })),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty,
};

const unavailableTextGeneration = TextGeneration.TextGeneration.of({
  generateCommitMessage: () => Effect.fail(new TextGenerationError({ operation: "generateCommitMessage", detail: SETUP_MESSAGE })),
  generatePrContent: () => Effect.fail(new TextGenerationError({ operation: "generatePrContent", detail: SETUP_MESSAGE })),
  generateBranchName: () => Effect.fail(new TextGenerationError({ operation: "generateBranchName", detail: SETUP_MESSAGE })),
  generateThreadTitle: () => Effect.fail(new TextGenerationError({ operation: "generateThreadTitle", detail: SETUP_MESSAGE })),
});

export type PiDriverEnv = ProcessRunner | ServerSettingsService;

const withInstanceIdentity =
  (input: { readonly instanceId: ProviderInstance["instanceId"]; readonly displayName: string | undefined; readonly accentColor: string | undefined; readonly continuationGroupKey: string }) =>
  (snapshot: ServerProviderDraft) => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const stampIdentity = withInstanceIdentity({ instanceId, displayName, accentColor, continuationGroupKey: continuationIdentity.continuationKey });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: "@earendil-works/pi-coding-agent" }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) => makePendingPiProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkPiProviderStatus(effectiveConfig, processEnv).pipe(Effect.map(stampIdentity)),
        refreshInterval: Duration.minutes(5),
      }).pipe(Effect.mapError((cause) => new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`, cause })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: unavailableAdapter,
        textGeneration: unavailableTextGeneration,
      } satisfies ProviderInstance;
    }),
};
