import {
  ProviderDriverKind,
  TextGenerationError,
  type CustomModelSetting,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { ClaudeCloudSettings, CodexCloudSettings } from "../settings.ts";
import { makeCloudAdapterV2 } from "./adapter.ts";
import { makeClaudeCloudBackend, makeCodexCloudBackend, type CloudBackend } from "./backends.ts";
import { makeCloudCli, type CloudCli } from "./cli.ts";
import {
  checkCloudProvider,
  claudeCloudAuthCheck,
  codexCloudAuthCheck,
  pendingCloudProvider,
  type CloudAuthCheck,
} from "./status.ts";

export type CloudDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner;

interface CloudSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}

/** Cloud runtimes have no local model to write commit messages or titles with. */
const unsupportedTextGeneration = (displayName: string): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${displayName} does not provide application text generation.`,
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

/** Builds a driver for one cloud runtime from its settings, CLI, and backend. */
const makeCloudDriver = <Settings extends CloudSettings>(definition: {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly binaryName: string;
  readonly settingsSchema: Schema.Codec<Settings, unknown>;
  readonly authCheck: CloudAuthCheck;
  readonly setupWarning?: (settings: Settings) => string | undefined;
  readonly backend: (settings: Settings, cli: CloudCli) => CloudBackend;
}): ProviderDriver<Settings, CloudDriverEnv> => {
  const decode = Schema.decodeSync(definition.settingsSchema);
  const DRIVER_KIND = definition.driverKind;
  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  });
  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: definition.displayName, supportsMultipleInstances: true },
    configSchema: definition.settingsSchema,
    defaultConfig: () => decode({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const host = yield* ProviderHost.ProviderHost;
        const env = yield* mergeProviderInstanceEnvironment(
          environment,
          yield* HostProcess.Environment,
        );
        const effectiveConfig: Settings = {
          ...config,
          enabled,
          binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
        };
        const cli = yield* makeCloudCli(effectiveConfig.binaryPath, env);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          driverKind: DRIVER_KIND,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const statusInput = {
          displayName: definition.displayName,
          enabled,
          customModels: effectiveConfig.customModels,
        };
        const setupWarning = definition.setupWarning?.(effectiveConfig);
        const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<Settings>>({
          resolveMaintenance: () => Effect.succeed(maintenance),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () => pendingCloudProvider(statusInput).pipe(Effect.map(stampIdentity)),
          checkProvider: checkCloudProvider({
            ...statusInput,
            cli,
            cwd: host.paths.cwd,
            binaryName: definition.binaryName,
            authCheck: definition.authCheck,
            ...(setupWarning ? { setupWarning } : {}),
          }).pipe(Effect.map(stampIdentity)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ${definition.displayName} snapshot.`,
                cause,
              }),
          ),
        );
        const orchestrationAdapter = yield* makeCloudAdapterV2({
          instanceId,
          driver: DRIVER_KIND,
          backend: definition.backend(effectiveConfig, cli),
        });
        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          orchestrationAdapter,
          textGeneration: unsupportedTextGeneration(definition.displayName),
        } satisfies ProviderInstance;
      }),
  };
};

export const CodexCloudDriver = makeCloudDriver({
  driverKind: ProviderDriverKind.make("codexCloud"),
  displayName: "Codex Cloud",
  binaryName: "codex",
  settingsSchema: CodexCloudSettings,
  authCheck: codexCloudAuthCheck,
  setupWarning: (settings) =>
    settings.environment
      ? undefined
      : "Set the Cloud environment in this provider's settings. Run codex cloud to list yours.",
  backend: (settings, cli) => makeCodexCloudBackend({ cli, environment: settings.environment }),
});

export const ClaudeCloudDriver = makeCloudDriver({
  driverKind: ProviderDriverKind.make("claudeCloud"),
  displayName: "Claude Code Cloud",
  binaryName: "claude",
  settingsSchema: ClaudeCloudSettings,
  authCheck: claudeCloudAuthCheck,
  backend: (_settings, cli) => makeClaudeCloudBackend({ cli }),
});
