import * as NodeOS from "node:os";

import {
  ACP_REGISTRY,
  acpRegistryDriverKindFor,
  acpRegistryEntryById,
  AcpRegistryError,
  acpRegistryIdFromDriverKind,
  type AcpRegistryDistributionKind,
  type AcpRegistryEntry,
  type AcpRegistryEntryWithStatus,
  type AcpRegistryInstallState,
  type AcpRegistryInstallStatus,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InstallManifest from "./installManifest.ts";
import * as Installer from "./installer.ts";
import { resolveCurrentPlatform } from "./platform.ts";

export class AcpRegistryService extends Context.Service<
  AcpRegistryService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<AcpRegistryEntryWithStatus>, AcpRegistryError>;
    readonly install: (agentId: string) => Effect.Effect<AcpRegistryInstallState, AcpRegistryError>;
    readonly uninstall: (agentId: string) => Effect.Effect<void, AcpRegistryError>;
    readonly authenticate: (
      instanceId: ProviderInstanceId,
      methodId: string,
    ) => Effect.Effect<void, AcpRegistryError>;
  }
>()("t3/acpRegistry/AcpRegistryService") {}

export function authProbeTimeoutForDistribution(
  distribution: AcpRegistryDistributionKind,
): Duration.Input {
  // Binary distributions are already cached locally and start immediately, so a short timeout is sufficient.
  // npx and uvx require package download and dependency resolution, which can take significantly longer,
  // especially on slow networks or for packages with many dependencies. The 25s timeout accommodates
  // these operations while still providing reasonable feedback to the user.
  switch (distribution) {
    case "binary":
      return "4 seconds";
    case "npx":
    case "uvx":
      return "25 seconds";
  }
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const sessionRuntimeRepoOpt = yield* Effect.serviceOption(
    ProviderSessionRuntime.ProviderSessionRuntimeRepository,
  );
  const platform = resolveCurrentPlatform(hostPlatform, hostArchitecture);
  const cacheRoot = config.acpRegistryCacheDir;

  const probeAuthMethods = (
    spawnTarget: Installer.SpawnTarget,
  ): Effect.Effect<
    | ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly description?: string;
      }>
    | undefined,
    never
  > => {
    const probeCwd = NodeOS.tmpdir();
    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: {
        command: spawnTarget.command,
        args: [...spawnTarget.args],
        cwd: probeCwd,
        env: { ...spawnTarget.env },
      },
      cwd: probeCwd,
      clientInfo: { name: "t3-code", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const timeout = authProbeTimeoutForDistribution(spawnTarget.distribution);
      const startExit = yield* Effect.exit(runtime.start().pipe(Effect.timeout(timeout)));
      const methods: ReadonlyArray<EffectAcpSchema.AuthMethod> = Exit.isSuccess(startExit)
        ? (startExit.value.initializeResult.authMethods ?? [])
        : yield* runtime.getAuthMethods;
      if (methods.length === 0) return undefined;
      return methods.map((method: EffectAcpSchema.AuthMethod) => {
        if (method.description) {
          return {
            id: method.id,
            name: method.name,
            description: method.description,
          };
        }
        return {
          id: method.id,
          name: method.name,
        };
      });
    }).pipe(
      Effect.provide(runtimeLayer),
      Effect.scoped,
      Effect.orElseSucceed(() => undefined),
    );
  };

  const readSettings = settingsService.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new AcpRegistryError({
          operation: "read-settings",
          detail: "Failed to read server settings",
          cause,
        }),
    ),
  );

  const readInstalls = InstallManifest.readInstalls.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.mapError(
      (cause) =>
        new AcpRegistryError({
          operation: "read-install-manifest",
          detail: "Failed to read install manifest",
          cause,
        }),
    ),
  );

  const writeInstalls = (next: Readonly<Record<string, AcpRegistryInstallState>>) =>
    InstallManifest.writeInstalls(next).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            operation: "write-install-manifest",
            detail: "Failed to write install manifest",
            cause,
          }),
      ),
    );

  const writeInstances = (nextInstances: ProviderInstanceConfigMap) =>
    settingsService.updateSettings({ providerInstances: nextInstances }).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            operation: "write-settings",
            detail: "Failed to persist server settings",
            cause,
          }),
      ),
    );

  const requireEntry = (agentId: string): Effect.Effect<AcpRegistryEntry, AcpRegistryError> => {
    const entry = acpRegistryEntryById(agentId);
    return entry
      ? Effect.succeed(entry)
      : Effect.fail(
          new AcpRegistryError({
            operation: "resolve-agent",
            agentId,
            detail: "Unknown ACP registry agent.",
          }),
        );
  };

  yield* Effect.gen(function* () {
    const settings = yield* readSettings;
    const installs = yield* readInstalls;
    const installedAgentIds = Object.keys(installs);
    if (installedAgentIds.length === 0) return;
    const existingInstances = settings.providerInstances ?? {};
    const existingDrivers = new Set(
      Object.values(existingInstances).map((instance) => instance.driver),
    );
    const existingIds = new Set(Object.keys(existingInstances));
    let nextInstances: Record<string, ProviderInstanceConfig> | undefined;
    let changed = false;
    for (const agentId of installedAgentIds) {
      const entry = acpRegistryEntryById(agentId);
      if (!entry) continue;
      const driverKind = ProviderDriverKind.make(acpRegistryDriverKindFor(entry.id));
      if (existingDrivers.has(driverKind)) continue;
      const instanceId = pickFreeAutoInstanceId(driverKind, existingIds);
      nextInstances ??= { ...existingInstances };
      nextInstances[instanceId] = {
        driver: driverKind,
        displayName: entry.name,
        enabled: true,
      };
      existingDrivers.add(driverKind);
      existingIds.add(instanceId);
      changed = true;
    }
    if (!changed) return;
    yield* writeInstances(nextInstances as ProviderInstanceConfigMap);
  }).pipe(
    Effect.catchTags({
      AcpRegistryError: (error) =>
        Effect.logWarning("acp.registry backfill skipped", {
          operation: error.operation,
          agentId: error.agentId,
          detail: error.detail,
          cause: error.cause,
        }),
    }),
  );

  const isAcpRegistryError = Schema.is(AcpRegistryError);

  return AcpRegistryService.of({
    list: () =>
      Effect.gen(function* () {
        const installs = yield* readInstalls;
        return ACP_REGISTRY.map((entry) =>
          buildEntryStatus(entry, installs[entry.id], Installer.availableChannels(entry, platform)),
        );
      }),

    install: (agentId) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(agentId);
        const result = yield* Effect.tryPromise({
          try: () => Installer.installAgent(entry, { cacheRoot, platform }),
          catch: (cause) =>
            isAcpRegistryError(cause)
              ? cause
              : new AcpRegistryError({
                  operation: "install",
                  agentId,
                  detail: "Install failed",
                  cause,
                }),
        });

        const spawnTargetForProbe = Installer.resolveSpawnTarget(entry, result.state, { platform });
        const authMethods = spawnTargetForProbe
          ? yield* probeAuthMethods(spawnTargetForProbe)
          : undefined;

        const installs = yield* readInstalls;
        const installedState = {
          ...result.state,
          ...(authMethods ? { authMethods } : {}),
        };
        const nextInstalls = {
          ...installs,
          [agentId]: installedState,
        };
        yield* writeInstalls(nextInstalls);

        const settings = yield* readSettings;
        const driverKind = ProviderDriverKind.make(acpRegistryDriverKindFor(entry.id));
        const existingInstances = settings.providerInstances ?? {};
        const hasInstance = Object.values(existingInstances).some(
          (instance) => instance.driver === driverKind,
        );
        const nextInstances = hasInstance
          ? existingInstances
          : ({
              ...existingInstances,
              [pickFreeAutoInstanceId(driverKind, new Set(Object.keys(existingInstances)))]: {
                driver: driverKind,
                displayName: entry.name,
                enabled: true,
              } satisfies ProviderInstanceConfig,
            } satisfies ProviderInstanceConfigMap);

        yield* writeInstances(nextInstances);
        return installedState;
      }),

    uninstall: (agentId) =>
      Effect.gen(function* () {
        const entry = yield* requireEntry(agentId);
        const settings = yield* readSettings;
        const providerInstances = settings.providerInstances ?? {};
        const driverKind = ProviderDriverKind.make(acpRegistryDriverKindFor(agentId));
        const instancesForAgent = Object.entries(providerInstances).filter(
          ([, instance]) => instance.driver === driverKind,
        );

        if (instancesForAgent.length > 0 && Option.isSome(sessionRuntimeRepoOpt)) {
          const sessionRuntimeRepo = sessionRuntimeRepoOpt.value;
          const allSessions = yield* sessionRuntimeRepo.list().pipe(
            Effect.mapError(
              (cause) =>
                new AcpRegistryError({
                  operation: "list-sessions",
                  agentId,
                  detail: "Failed to list provider sessions",
                  cause,
                }),
            ),
          );
          const activeInstanceIds = new Set(instancesForAgent.map(([instanceId]) => instanceId));
          const activeSessions = allSessions.filter(
            (session) =>
              session.providerInstanceId != null &&
              activeInstanceIds.has(session.providerInstanceId),
          );
          if (activeSessions.length > 0) {
            return yield* new AcpRegistryError({
              operation: "uninstall",
              agentId,
              detail: `Cannot uninstall ${entry.name}: ${activeSessions.length} active session(s) using this provider. Close them first.`,
            });
          }
        }
        if (instancesForAgent.length > 0) {
          const nextInstances = { ...providerInstances } as Record<string, ProviderInstanceConfig>;
          for (const [instanceId] of instancesForAgent) {
            delete nextInstances[instanceId];
          }
          yield* settingsService
            .updateSettings({
              providerInstances: nextInstances as ProviderInstanceConfigMap,
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    operation: "delete-provider-instances",
                    agentId,
                    detail: "Failed to cascade-delete provider instances",
                    cause,
                  }),
              ),
            );
        }

        yield* Effect.tryPromise({
          try: () => Installer.uninstallAgent(entry, cacheRoot),
          catch: (cause) =>
            isAcpRegistryError(cause)
              ? cause
              : new AcpRegistryError({
                  operation: "uninstall",
                  agentId,
                  detail: "Uninstall failed",
                  cause,
                }),
        });

        const installs = yield* readInstalls;
        if (!(agentId in installs)) return;
        const { [agentId]: _removed, ...rest } = installs;
        yield* writeInstalls(rest);
      }),

    authenticate: (instanceId, methodId) =>
      Effect.gen(function* () {
        const settings = yield* readSettings;
        const instance = settings.providerInstances?.[instanceId];
        if (!instance) {
          return yield* new AcpRegistryError({
            operation: "authenticate",
            agentId: instanceId,
            detail: `Provider instance ${instanceId} not found`,
          });
        }
        const agentId = acpRegistryIdFromDriverKind(instance.driver);
        if (!agentId) {
          return yield* new AcpRegistryError({
            operation: "authenticate",
            detail: `Instance ${instanceId} is not an ACP registry provider (driver=${instance.driver})`,
          });
        }
        const entry = yield* requireEntry(agentId);
        const installs = yield* readInstalls;
        const installState = installs[agentId];
        if (!installState) {
          return yield* new AcpRegistryError({
            operation: "authenticate",
            agentId,
            detail: `${entry.name} is not installed`,
          });
        }
        const spawnTarget = Installer.resolveSpawnTarget(entry, installState, { platform });
        if (!spawnTarget) {
          return yield* new AcpRegistryError({
            operation: "authenticate",
            agentId,
            detail: `${entry.name} install state is missing a spawn target`,
          });
        }

        const probeCwd = NodeOS.tmpdir();
        const env = mergeProviderInstanceEnvironment(instance.environment, spawnTarget.env);
        const runtimeLayer = AcpSessionRuntime.layer({
          spawn: {
            command: spawnTarget.command,
            args: [...spawnTarget.args],
            cwd: probeCwd,
            env,
          },
          cwd: probeCwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
          authMethodId: methodId,
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* runtime.start();
        }).pipe(
          Effect.provide(runtimeLayer),
          Effect.scoped,
          Effect.mapError(
            (cause) =>
              new AcpRegistryError({
                operation: "authenticate",
                agentId,
                detail: `Authentication failed for method '${methodId}'`,
                cause,
              }),
          ),
        );

        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        yield* settingsService
          .updateSettings({
            providerInstances: {
              ...settings.providerInstances,
              [instanceId]: {
                ...instance,
                authenticatedAt: now,
              },
            },
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new AcpRegistryError({
                  operation: "write-settings",
                  agentId,
                  detail: "Failed to update provider instance",
                  cause,
                }),
            ),
          );
      }),
  } satisfies AcpRegistryService["Service"]);
});

export const layer = Layer.effect(AcpRegistryService, make);

function buildEntryStatus(
  entry: AcpRegistryEntry,
  installed: AcpRegistryInstallState | undefined,
  channels: ReadonlyArray<ReturnType<typeof Installer.availableChannels>[number]>,
): AcpRegistryEntryWithStatus {
  return {
    entry,
    availableChannels: channels,
    status: rollupStatus(entry, installed, channels),
    ...(installed ? { installed } : {}),
  };
}

function rollupStatus(
  entry: AcpRegistryEntry,
  installed: AcpRegistryInstallState | undefined,
  channels: ReadonlyArray<ReturnType<typeof Installer.availableChannels>[number]>,
): AcpRegistryInstallStatus {
  if (channels.length === 0) return "unsupported";
  if (!installed) return "not_installed";
  return installed.version === entry.version ? "installed" : "update_available";
}

function pickFreeAutoInstanceId(
  driverKind: ProviderDriverKind,
  existing: ReadonlySet<string>,
): ProviderInstanceId {
  const base = String(driverKind);
  if (!existing.has(base)) return ProviderInstanceId.make(base);
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return ProviderInstanceId.make(candidate);
  }
}
