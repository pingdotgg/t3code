import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGenericAcpAdapter } from "../Layers/GenericAcpAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

export type AcpRegistryDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Generic ACP providers do not support git text generation yet.",
    }),
  );

const makeTextGeneration = () => ({
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
});

function withIdentity(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly iconUrl: string | undefined;
  readonly continuationGroupKey: string;
}) {
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
}

function initialSnapshot(settings: AcpRegistrySettings): ServerProviderDraft {
  const checkedAt = new Date().toISOString();
  const command = settings.command.trim();
  const enabled = settings.enabled && command.length > 0;
  return buildServerProvider({
    presentation: {
      displayName: "ACP Registry",
      badgeLabel: "ACP",
      showInteractionModeToggle: true,
    },
    enabled,
    checkedAt,
    models: providerModelsFromSettings(
      [{ slug: "default", name: "Default", isCustom: false, capabilities: null }],
      DRIVER_KIND,
      settings.customModels,
      { optionDescriptors: [] },
    ),
    probe: {
      installed: enabled,
      version: null,
      status: enabled ? "ready" : "warning",
      auth: { status: "unknown" },
      message: enabled ? "ACP provider configured." : "Configure a launch command to enable.",
    },
  });
}

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: (): AcpRegistrySettings => Schema.decodeSync(AcpRegistrySettings)({}),
  create: ({ instanceId, displayName, accentColor, iconUrl, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const effectiveConfig = { ...config, enabled: enabled && config.enabled };
      const effectiveIconUrl = iconUrl ?? effectiveConfig.iconUrl;
      const processEnv = {
        ...effectiveConfig.env,
        ...mergeProviderInstanceEnvironment(environment),
      };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stamp = withIdentity({
        instanceId,
        displayName,
        accentColor,
        iconUrl: effectiveIconUrl,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const adapter = yield* makeGenericAcpAdapter(
        {
          enabled: effectiveConfig.enabled,
          command: effectiveConfig.command || "acp",
          args: effectiveConfig.args,
        },
        {
          provider: DRIVER_KIND,
          instanceId,
          environment: processEnv,
          readyReason: "ACP session ready",
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );

      const snapshot = yield* makeManagedServerProvider<AcpRegistrySettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stamp(initialSnapshot(settings)),
        checkProvider: Effect.succeed(stamp(initialSnapshot(effectiveConfig))),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP Registry snapshot: ${cause.message ?? String(cause)}`,
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
        iconUrl: effectiveIconUrl,
        enabled: effectiveConfig.enabled,
        snapshot,
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
