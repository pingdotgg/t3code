/**
 * FuguDriver — Sakana AI Fugu as a first-class provider, reusing the Codex
 * app-server stack (adapter, probe, text generation) with a dedicated
 * CODEX_HOME bootstrapped for the Sakana model provider.
 *
 * @module provider/Drivers/FuguDriver
 */
import {
  FuguSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  type CodexProviderIdentity,
} from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ensureFuguHome } from "./FuguHome.ts";

const decodeFuguSettings = Schema.decodeSync(FuguSettings);

const DRIVER_KIND = ProviderDriverKind.make("fugu");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
export const FUGU_ALLOWED_REASONING_EFFORTS = ["high", "xhigh", "max"] as const;
const FUGU_REASONING_CHOICES = [
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] satisfies ReadonlyArray<{
  readonly id: (typeof FUGU_ALLOWED_REASONING_EFFORTS)[number];
  readonly label: string;
}>;
const FUGU_ALLOWED_REASONING_EFFORT_IDS = new Set<string>(FUGU_ALLOWED_REASONING_EFFORTS);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

const FUGU_IDENTITY: CodexProviderIdentity = {
  presentation: {
    displayName: "Fugu",
    showInteractionModeToggle: true,
  },
  label: "Fugu",
  notInstalledMessage:
    "Fugu requires the real Codex binary (`codex`) on PATH. Install Codex (not codex-fugu — that wrapper cannot run app-server).",
  unauthenticatedMessage:
    "Fugu is not authenticated. Set the SAKANA_API_KEY environment variable and try again.",
};

type SelectProviderOptionDescriptor = Extract<
  ProviderOptionDescriptor,
  { readonly type: "select" }
>;

function isFuguReasoningDescriptor(
  descriptor: ProviderOptionDescriptor,
): descriptor is SelectProviderOptionDescriptor {
  return descriptor.type === "select" && descriptor.id === "reasoningEffort";
}

function defaultFuguReasoningEffort(model: ServerProviderModel): string {
  const reasoningDescriptor =
    model.capabilities?.optionDescriptors?.find(isFuguReasoningDescriptor);
  const current = reasoningDescriptor?.currentValue;
  if (current && FUGU_ALLOWED_REASONING_EFFORT_IDS.has(current)) {
    return current;
  }
  const catalogDefault = reasoningDescriptor?.options.find((option) => option.isDefault)?.id;
  if (catalogDefault && FUGU_ALLOWED_REASONING_EFFORT_IDS.has(catalogDefault)) {
    return catalogDefault;
  }
  return model.slug.includes("ultra") ? "xhigh" : "high";
}

export function normalizeFuguModelCapabilities(model: ServerProviderModel): ModelCapabilities {
  const defaultReasoning = defaultFuguReasoningEffort(model);
  const existingDescriptors = model.capabilities?.optionDescriptors ?? [];
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: FUGU_REASONING_CHOICES.map((choice) => ({
          ...choice,
          ...(choice.id === defaultReasoning ? { isDefault: true } : {}),
        })),
        currentValue: defaultReasoning,
      },
      ...existingDescriptors.filter((descriptor) => !isFuguReasoningDescriptor(descriptor)),
    ],
  });
}

function normalizeFuguProviderSnapshot(snapshot: ServerProviderDraft): ServerProviderDraft {
  return {
    ...snapshot,
    models: snapshot.models.map((model) => ({
      ...model,
      capabilities: normalizeFuguModelCapabilities(model),
    })),
  };
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type FuguDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * shared Codex helpers.
 */
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

export const FuguDriver: ProviderDriver<FuguSettings, FuguDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Fugu",
    supportsMultipleInstances: true,
  },
  configSchema: FuguSettings,
  defaultConfig: (): FuguSettings => decodeFuguSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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

      // Keep the configured home path (tilde form is fine — spawn expands it).
      // Bootstrap (write config.toml) runs on each status check when enabled so
      // a later catalog install recovers without a full instance rebuild.
      const effectiveConfig = {
        ...config,
        enabled,
      } satisfies FuguSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        driverKind: DRIVER_KIND,
        defaultReasoningEffort: "high",
        allowedReasoningEfforts: FUGU_ALLOWED_REASONING_EFFORTS,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      // Fugu models only accept high/xhigh/max reasoning efforts.
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnv, {
        defaultReasoningEffort: "high",
        allowedReasoningEfforts: FUGU_ALLOWED_REASONING_EFFORTS,
        displayName: "Fugu",
      });

      const checkProvider = Effect.gen(function* () {
        if (!effectiveConfig.enabled) {
          return yield* checkCodexProviderStatus(
            effectiveConfig,
            undefined,
            processEnv,
            FUGU_IDENTITY,
          );
        }

        const homeBootstrap = yield* ensureFuguHome(effectiveConfig).pipe(Effect.result);
        if (Result.isFailure(homeBootstrap)) {
          const pending = yield* makePendingCodexProvider(effectiveConfig, FUGU_IDENTITY);
          return {
            ...pending,
            installed: false,
            status: "error" as const,
            auth: { status: "unknown" as const },
            message: homeBootstrap.failure.message,
          } satisfies ServerProviderDraft;
        }

        return yield* checkCodexProviderStatus(
          {
            ...effectiveConfig,
            homePath: homeBootstrap.success,
          },
          undefined,
          processEnv,
          FUGU_IDENTITY,
        ).pipe(Effect.map(normalizeFuguProviderSnapshot));
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FuguSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingCodexProvider(settings.provider, FUGU_IDENTITY).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Fugu snapshot: ${cause.message ?? String(cause)}`,
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
