import {
  type AcpRegistryEntry,
  acpRegistryDriverKindFor,
  type AcpRegistrySettings,
  AcpRegistrySettings as AcpRegistrySettingsSchema,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Path from "effect/Path";

import { resolveSpawnTarget } from "../../acpRegistry/installer.ts";
import { reapOrphanProcesses } from "../../acpRegistry/orphanReaper.ts";
import { resolveCurrentPlatform } from "../../acpRegistry/platform.ts";
import { ServerConfig } from "../../config.ts";
import { makeAcpRegistryTextGeneration } from "../../textGeneration/AcpRegistryTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getInstallState, setInstallState } from "../../acpRegistry/installManifest.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  type AcpRegistryAdapterEnv,
  makeAcpRegistryAdapter,
} from "../Layers/AcpRegistryAdapterLayer.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider, type ProviderProbeResult } from "../providerSnapshot.ts";

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettingsSchema);

export { buildModelsFromAcpConfigOptions } from "../acp/configOptionModels.ts";

export type AcpRegistryDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ServerConfig
  | ServerSettingsService
  | Path.Path
  | AcpRegistryAdapterEnv;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function fallbackModel(entry: AcpRegistryEntry): ServerProviderModel {
  return {
    slug: entry.id,
    name: entry.name,
    isCustom: false,
    capabilities: null,
  };
}

export function makeAcpRegistryDriver(
  entry: AcpRegistryEntry,
): ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> {
  const driverKind = ProviderDriverKind.make(acpRegistryDriverKindFor(entry.id));

  return {
    driverKind,
    metadata: {
      displayName: entry.name,
      supportsMultipleInstances: true,
    },
    configSchema: AcpRegistrySettingsSchema,
    defaultConfig: () => decodeAcpRegistrySettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const driverContext = yield* Effect.context<
          FileSystem.FileSystem | ServerConfig | ServerSettingsService | Path.Path
        >();
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const hostPlatform = yield* HostProcessPlatform;
        const hostArchitecture = yield* HostProcessArchitecture;
        const platform = resolveCurrentPlatform(hostPlatform, hostArchitecture);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind,
          instanceId,
        });

        const installState = yield* getInstallState(entry.id).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: driverKind,
                instanceId,
                detail: "Failed to read ACP registry install state.",
                cause,
              }),
          ),
        );

        const spawnTarget = resolveSpawnTarget(entry, installState, { platform });
        const installed = spawnTarget !== undefined;

        // Reap orphan child processes from previous server runs that didn't shut down cleanly.
        // Critical for Junie (its `.app` launcher detaches → JVM survives parent SIGKILL,
        // accumulating across restarts at ~150MB/30%CPU each).
        if (installed && spawnTarget?.command) {
          const reaped = yield* reapOrphanProcesses(spawnTarget.command);
          if (reaped > 0) {
            yield* Effect.logInfo("ACP registry reaped orphan agent processes", {
              entryId: entry.id,
              command: spawnTarget.command,
              count: reaped,
            });
          }
        }

        const cachedModels: ReadonlyArray<ServerProviderModel> = (
          installState?.cachedModels ?? []
        ).map((cached) => ({
          slug: cached.slug,
          name: cached.name,
          isCustom: false,
          capabilities: null,
        }));

        const discoveredModelsRef =
          yield* Ref.make<ReadonlyArray<ServerProviderModel>>(cachedModels);
        const refreshSnapshotRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);

        const nowIsoEffect = Effect.map(DateTime.now, DateTime.formatIso);

        const adapter = yield* makeAcpRegistryAdapter({
          driverKind,
          instanceId,
          spawnTarget,
          environment: processEnv,
          onModelsDiscovered: (models) =>
            Effect.gen(function* () {
              const previous = yield* Ref.get(discoveredModelsRef);
              const unchanged =
                previous.length === models.length &&
                previous.every((model, index) => model.slug === models[index]?.slug);
              yield* Ref.set(discoveredModelsRef, models);
              const currentInstall = yield* getInstallState(entry.id).pipe(
                Effect.provide(driverContext),
                Effect.orElseSucceed(() => undefined as typeof installState),
              );
              if (currentInstall) {
                const { discoveryFailureCount: _f, ...rest } = currentInstall;
                yield* setInstallState(entry.id, {
                  ...rest,
                  cachedModels: models.map((model) => ({
                    slug: model.slug,
                    name: model.name,
                  })),
                  lastDiscoveryAttemptAt: yield* nowIsoEffect,
                }).pipe(
                  Effect.provide(driverContext),
                  Effect.orElseSucceed(() => undefined),
                );
              }
              if (!unchanged) {
                const refresh = yield* Ref.get(refreshSnapshotRef);
                yield* refresh;
              }
            }),
          onDiscoveryFailed: (reason) =>
            Effect.gen(function* () {
              const currentInstall = yield* getInstallState(entry.id).pipe(
                Effect.provide(driverContext),
                Effect.orElseSucceed(() => undefined as typeof installState),
              );
              if (!currentInstall) return;
              const nextCount = (currentInstall.discoveryFailureCount ?? 0) + 1;
              yield* Effect.logInfo("ACP registry discovery failure recorded", {
                entryId: entry.id,
                count: nextCount,
                reason,
              });
              yield* setInstallState(entry.id, {
                ...currentInstall,
                discoveryFailureCount: nextCount,
                lastDiscoveryAttemptAt: yield* nowIsoEffect,
              }).pipe(
                Effect.provide(driverContext),
                Effect.orElseSucceed(() => undefined),
              );
            }),
        });

        const stampIdentity = (snapshot: Omit<ServerProvider, "instanceId" | "driver">) =>
          ({
            ...snapshot,
            instanceId,
            driver: driverKind,
            continuation: { groupKey: continuationIdentity.continuationKey },
            ...(displayName ? { displayName } : {}),
            ...(accentColor ? { accentColor } : {}),
          }) satisfies ServerProvider;

        const buildSnapshot = (input: {
          readonly checkedAt: string;
          readonly models?: ReadonlyArray<ServerProviderModel>;
          readonly discoveryWarning?: string;
        }) => {
          let probe: ProviderProbeResult;
          if (installed) {
            const hasAuthMethods = (installState?.authMethods?.length ?? 0) > 0;
            probe = {
              installed: true,
              version: installState?.version ?? entry.version,
              status: input.discoveryWarning ? "warning" : "ready",
              auth: {
                status: "unknown",
                ...(hasAuthMethods ? { authMethods: installState?.authMethods ?? [] } : {}),
              },
              ...(input.discoveryWarning ? { message: input.discoveryWarning } : {}),
            };
          } else {
            probe = {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: `${entry.name} is not installed. Install it from Settings → ACP Registry.`,
            };
          }
          return stampIdentity(
            buildServerProvider({
              driver: driverKind,
              presentation: { displayName: displayName ?? entry.name },
              enabled,
              checkedAt: input.checkedAt,
              models:
                input.models && input.models.length > 0 ? input.models : [fallbackModel(entry)],
              probe,
            }),
          );
        };

        const buildSnapshotFromState = Effect.gen(function* () {
          const checkedAt = yield* nowIso;
          const models = yield* Ref.get(discoveredModelsRef);
          return buildSnapshot({ checkedAt, models });
        });

        const snapshot = yield* makeManagedServerProvider<AcpRegistrySettings>({
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: driverKind,
            packageName: null,
          }),
          getSettings: Effect.succeed(config),
          streamSettings: Stream.never,
          haveSettingsChanged: () => false,
          initialSnapshot: () => buildSnapshotFromState,
          checkProvider: buildSnapshotFromState,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: driverKind,
                instanceId,
                detail: `Failed to build the ${entry.name} provider snapshot.`,
                cause,
              }),
          ),
        );

        yield* Ref.set(refreshSnapshotRef, snapshot.refresh);

        // Pre-warm model discovery: if we don't have a cached list yet AND the agent is
        // installed AND we haven't already failed too many times, fire a background
        // session/new on boot so models appear in the UI before the user opens a chat.
        // Non-blocking. Skipped after 3 consecutive failures to avoid wasting time on an
        // agent that's hung / requires manual auth (Junie's auth flow, qwen-code's env vars).
        const failureCount = installState?.discoveryFailureCount ?? 0;
        const MAX_FAILURES = 3;
        if (installed && cachedModels.length === 0 && failureCount < MAX_FAILURES) {
          yield* Effect.logInfo("ACP registry driver: scheduling boot-time discovery", {
            entryId: entry.id,
            instanceId,
            cwd: process.cwd(),
            previousFailures: failureCount,
          });
          yield* adapter.discoverModels(process.cwd()).pipe(Effect.forkDetach, Effect.asVoid);
        } else {
          yield* Effect.logInfo("ACP registry driver: skipping boot-time discovery", {
            entryId: entry.id,
            instanceId,
            installed,
            cachedModelCount: cachedModels.length,
            failureCount,
            reason: !installed
              ? "not installed"
              : cachedModels.length > 0
                ? "cache hit"
                : `${failureCount} prior failures (>= ${MAX_FAILURES}); manual reload required`,
          });
        }

        return {
          instanceId,
          driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration: makeAcpRegistryTextGeneration(),
        } satisfies ProviderInstance;
      }),
  };
}
