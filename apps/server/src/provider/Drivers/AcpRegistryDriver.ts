import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type AcpRegistryOperationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/AcpRegistryAdapterV2.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  probeAcpRegistryConfiguration,
} from "../acp/AcpRegistryProbe.ts";
import { AcpRegistryCatalog, type AcpRegistryInspection } from "../acp/AcpRegistrySupport.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// How long a successful discovery probe stays valid. Periodic health
// refreshes reuse it instead of spawning a fresh disposable ACP session;
// failed or unauthenticated probes are never cached so a completed sign-in
// is detected on the next refresh.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

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

function modelsFromProbe(
  probe: AcpRegistryConfigurationProbeResult | undefined,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const discovered = probe?.probe.models ?? [];
  // Discovered session config options and modes ride on every model so the
  // composer's generic option controls can drive them per thread.
  const capabilities =
    probe === undefined || probe.probe.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: probe.probe.configOptions });
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === probe?.probe.currentModelId ? { isDefault: true } : {}),
          capabilities,
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}

export function acpRegistrySnapshotReadiness(
  inspection: AcpRegistryInspection | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return { installed: true, version: inspection.version, status: "ready" };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message: "Select an ACP Registry agent before starting a thread.",
      };
    case "not_found":
      return {
        installed: false,
        version: null,
        status: "error",
        message: `ACP Registry does not contain agent '${inspection.agentId}'.`,
      };
    case "unsupported":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' has no compatible distribution for this environment.`,
      };
    case "missing_runner":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' requires '${inspection.runner}' on this environment's PATH.`,
      };
    case "unprepared":
      return {
        installed: false,
        version: inspection.version,
        status: "warning",
        message: `ACP Registry agent '${inspection.agentId}' has not been prepared on this environment.`,
      };
    case "failed":
      return {
        installed: false,
        version: null,
        status: "error",
        message: inspection.message,
      };
  }
}

interface SnapshotIdentity {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

function baseSnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProvider["auth"];
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
  },
): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    // The registry driver rejects every application text-generation operation,
    // so selectors must not offer these instances for commit, PR, branch, or
    // title generation.
    supportsAppTextGeneration: false,
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: input.auth,
    checkedAt: input.checkedAt,
    ...(input.message ? { message: input.message } : {}),
    models: modelsFromProbe(input.probe, input.settings.customModels),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export function applyAcpRegistryAvailableCommands(
  provider: ServerProvider,
  commands: Option.Option<AcpRegistryAvailableCommands>,
): ServerProvider {
  return Option.match(commands, {
    onNone: () => provider,
    onSome: ({ slashCommands, skills }) => ({ ...provider, slashCommands, skills }),
  });
}

export const buildInitialAcpRegistrySnapshot = Effect.fn("AcpRegistryDriver.buildInitialSnapshot")(
  function* (input: SnapshotIdentity & { readonly settings: AcpRegistrySettings }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return baseSnapshot({
      ...input,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "Checking ACP Registry agent readiness..."
        : "ACP Registry is disabled in T3 Code settings.",
    });
  },
);

export function buildCheckedAcpRegistrySnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly inspection:
      | AcpRegistryInspection
      | { readonly status: "failed"; readonly message: string };
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const probeFailed = input.probeError !== undefined;
  const advertisedAuthMethod =
    input.probeError?.reason === "authentication_failed"
      ? (input.probeError.authMethods?.find(
          (method) => method.id === input.settings.authMethodId,
        ) ?? input.probeError.authMethods?.[0])
      : undefined;
  const authenticationMessage = advertisedAuthMethod
    ? advertisedAuthMethod.type === "terminal" && advertisedAuthMethod.command
      ? `Run \`${advertisedAuthMethod.command}\` in a thread terminal on this environment. T3 Code will detect the completed sign-in on the next provider refresh.`
      : advertisedAuthMethod.type === "env_var" &&
          (advertisedAuthMethod.envVarNames?.length ?? 0) > 0
        ? `Set ${advertisedAuthMethod.envVarNames!.join(", ")} under this instance's environment variables in provider settings. T3 Code will detect it on the next provider refresh.`
        : `Complete the advertised "${advertisedAuthMethod.name}" authentication method on the server. T3 Code will detect it automatically on the next provider refresh.`
    : undefined;
  return baseSnapshot({
    ...input,
    installed: readiness.installed,
    version: readiness.version,
    // A failed discovery probe on a ready installation is a warning, not an
    // outage: the agent binary is present and a real turn may still work
    // (for example after the user completes authentication).
    status: probeFailed ? "warning" : readiness.status,
    auth: input.probe
      ? { status: "authenticated" }
      : input.probeError?.reason === "authentication_failed"
        ? {
            status: "unauthenticated",
            ...(advertisedAuthMethod
              ? { type: advertisedAuthMethod.type, label: advertisedAuthMethod.name }
              : {}),
          }
        : { status: "unknown" },
    ...(input.probeError
      ? { message: authenticationMessage ?? input.probeError.message }
      : readiness.message
        ? { message: readiness.message }
        : {}),
  });
}

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistryCatalog | Requirements> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialAcpRegistrySnapshot(input);
    }
    const catalog = yield* AcpRegistryCatalog;
    const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
    if (Result.isFailure(inspected)) {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      });
    }
    if (inspected.success.status !== "ready") {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      });
    }
    const probed = yield* Effect.result(
      probeConfiguration({
        instanceId: input.instanceId,
        settings: input.settings,
        cwd: input.cwd,
        environment: input.environment,
      }),
    );
    return Result.isFailure(probed)
      ? buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        })
      : buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        });
  },
);

/** Publishes local executable readiness without starting an ACP process. */
export const checkAcpRegistryProviderReadiness = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ServerProvider, never, AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return yield* buildInitialAcpRegistrySnapshot(input);
  }
  const catalog = yield* AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  const snapshot = buildCheckedAcpRegistrySnapshot({
    ...input,
    checkedAt,
    inspection: Result.isFailure(inspected)
      ? {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        }
      : inspected.success,
  });
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        ...snapshot,
        message: "Checking ACP authentication, models, and commands in the background...",
      }
    : snapshot;
});

export type AcpRegistryDriverEnv =
  | AcpRegistryAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService;

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
      const catalog = yield* AcpRegistryCatalog;
      const runtimeCoordinator = yield* Effect.serviceOption(AcpRegistryRuntimeCoordinator);
      if (Option.isSome(runtimeCoordinator)) {
        yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
        yield* Effect.addFinalizer(() =>
          runtimeCoordinator.value.clearAvailableCommands(instanceId),
        );
      }
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hostEnvironment = yield* HostProcessEnvironment;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const identity = {
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      };
      const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment, hostEnvironment);
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
      const readinessInput = {
        ...identity,
        settings: effectiveConfig,
        environment: processEnvironment,
      };
      const withAvailableCommands = (provider: ServerProvider) =>
        Option.isNone(runtimeCoordinator)
          ? Effect.succeed(provider)
          : runtimeCoordinator.value
              .getAvailableCommands(instanceId)
              .pipe(
                Effect.map((commands) => applyAcpRegistryAvailableCommands(provider, commands)),
              );
      const checkProvider = checkAcpRegistryProviderReadiness(readinessInput).pipe(
        Effect.provideService(AcpRegistryCatalog, catalog),
        Effect.flatMap(withAvailableCommands),
      );
      const enrichProvider = checkAcpRegistryProviderStatus(
        {
          ...readinessInput,
          cwd: serverConfig.cwd,
        },
        probeAcpRegistryConfiguration,
      ).pipe(
        Effect.provideService(AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.flatMap(withAvailableCommands),
      );
      const enrichmentCache = yield* Ref.make<{
        readonly provider: ServerProvider;
        readonly expiresAt: number;
      } | null>(null);
      const enrichProviderCached = (baseSnapshot: ServerProvider) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* Ref.get(enrichmentCache);
          if (
            cached !== null &&
            cached.expiresAt > now &&
            cached.provider.version === baseSnapshot.version
          ) {
            return yield* withAvailableCommands({
              ...cached.provider,
              checkedAt: baseSnapshot.checkedAt,
            });
          }
          const enriched = yield* enrichProvider;
          if (enriched.auth.status === "authenticated") {
            yield* Ref.set(enrichmentCache, {
              provider: enriched,
              expiresAt: now + PROBE_SUCCESS_TTL_MS,
            });
          }
          return enriched;
        });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AcpRegistrySettings>
      >({
        maintenanceCapabilities: MAINTENANCE,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
        enrichSnapshot: ({ snapshot, getSnapshot, publishSnapshot }) => {
          if (!snapshot.installed) return Effect.void;
          const publishEnrichment = (
            Option.isSome(runtimeCoordinator)
              ? runtimeCoordinator.value.runBackgroundProbe(
                  effectiveConfig.agentId,
                  enrichProviderCached(snapshot),
                )
              : enrichProviderCached(snapshot).pipe(Effect.map(Option.some))
          ).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: publishSnapshot,
              }),
            ),
          );
          if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

          const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
            instanceId,
            ({ slashCommands, skills }) =>
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot({
                    ...current,
                    slashCommands,
                    skills,
                  }),
                ),
              ),
          );
          return publishEnrichment.pipe(Effect.andThen(publishLiveCommands));
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the ACP Registry provider snapshot.",
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
