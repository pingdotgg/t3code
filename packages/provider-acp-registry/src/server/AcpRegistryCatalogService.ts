import {
  ACP_REGISTRY_MAX_AGENTS,
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryManagedBinaryUninstallResult,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { sha256 } from "@noble/hashes/sha2";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";


import {
  DEFAULT_SEARCH_LIMIT,
  type AcpRegistryAgent,
  type AcpRegistryIndex,
  decodeBoundedAgentId,
  AcpRegistryError,
  isAcpRegistryError,
  packageManagerFor,
  withPreferredPath,
  resolveAcpRegistryDistribution,
  type ResolvedAcpRegistryAgent,
  AcpRegistryCatalog,
  compareText,
  searchRank,
} from "./AcpRegistryModel.ts";
import type { makeAcpRegistryInstaller } from "./AcpRegistryInstaller.ts";

/** The ACP catalog service surface. */
export const makeAcpRegistryCatalogService = (
  catalog: Effect.Success<ReturnType<typeof makeAcpRegistryInstaller>>,
) => {
  const hostSettings = catalog.hostSettings;
  const fileSystem = catalog.fileSystem;
  const path = catalog.path;
  const platform = catalog.platform;
  const architecture = catalog.architecture;
  const hostEnvironment = catalog.hostEnvironment;
  const resolveExecutable = catalog.resolveExecutable;
  const platformTarget = catalog.platformTarget;
  const installsDirectory = catalog.installsDirectory;
  const withInstallPermit = catalog.withInstallPermit;
  const reservePreparedBinary = catalog.reservePreparedBinary;
  const consumePreparedBinaryReservation = catalog.consumePreparedBinaryReservation;
  const hasPreparedBinaryReservation = catalog.hasPreparedBinaryReservation;
  const refreshRegistry = catalog.refreshRegistry;
  const recentRegistry = catalog.recentRegistry;
  const loadCachedRegistry = catalog.loadCachedRegistry;
  const loadRegistry = catalog.loadRegistry;
  const ensureGlobalPackage = catalog.ensureGlobalPackage;
  const assertExecutableInRoot = catalog.assertExecutableInRoot;
  const binaryPaths = catalog.binaryPaths;
  const installBinary = catalog.installBinary;

  const findAgent = Effect.fn("AcpRegistryCatalog.findAgent")(function* (
    registry: AcpRegistryIndex,
    agentId: string,
  ) {
    const agent = registry.agents.find((candidate) => candidate.id === agentId.trim());
    if (agent === undefined) {
      return yield* new AcpRegistryError({
        reason: "agent_not_found",
        detail: `ACP Registry does not contain agent '${agentId.trim()}'.`,
      });
    }
    return agent;
  });

  const compatibleDistribution = Effect.fn("AcpRegistryCatalog.compatibleDistribution")(function* (
    agent: AcpRegistryAgent,
    preference: AcpRegistryDistributionPreference,
  ) {
    const distribution = resolveAcpRegistryDistribution({
      agent,
      preference,
      platformTarget,
    });
    if (distribution === undefined) {
      return yield* new AcpRegistryError({
        reason: platformTarget === undefined ? "unsupported_platform" : "unsupported_distribution",
        detail: `ACP Registry agent ${agent.id} has no ${preference === "auto" ? "compatible" : preference} distribution for ${platform}-${architecture}.`,
      });
    }
    return distribution;
  });

  const search: AcpRegistryCatalog["Service"]["search"] = Effect.fn("AcpRegistryCatalog.search")(
    function* (input) {
      const registry = yield* recentRegistry();
      const ranked = registry.agents.flatMap((agent) => {
        const distribution = resolveAcpRegistryDistribution({
          agent,
          preference: "auto",
          platformTarget,
        });
        const rank = searchRank(agent, input.query);
        const packageManager =
          distribution === undefined ? undefined : packageManagerFor(distribution.kind);
        const packageManagerAvailable =
          packageManager === undefined ||
          resolveExecutable(packageManager, platform, hostEnvironment) !== undefined;
        return distribution === undefined || rank === undefined || !packageManagerAvailable
          ? []
          : [{ agent, distribution, rank }];
      });
      ranked.sort(
        (left, right) =>
          left.rank - right.rank ||
          compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
          compareText(left.agent.id, right.agent.id),
      );
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
      return {
        agents: ranked.slice(0, limit).map(({ agent, distribution }) => ({
          id: agent.id,
          name: agent.name,
          version: agent.version,
          description: agent.description,
          authors: agent.authors ?? [],
          license: agent.license ?? null,
          website: agent.website ?? null,
          repository: agent.repository ?? null,
          icon: agent.icon ?? null,
          distribution: distribution.kind,
          integrity:
            distribution.kind === "binary" && distribution.binaryTarget?.sha256 !== undefined
              ? "sha256"
              : "registry",
        })),
      } satisfies AcpRegistrySearchResult;
    },
  );

  const prepare: AcpRegistryCatalog["Service"]["prepare"] = Effect.fn("AcpRegistryCatalog.prepare")(
    function* (input) {
      const registry = yield* refreshRegistry();
      const agent = yield* findAgent(registry, input.agentId);
      const distribution = yield* compatibleDistribution(agent, "auto");
      if (distribution.kind === "binary") {
        // Only explicit command overrides may use PATH copies with different ACP capabilities.
        yield* withInstallPermit(agent.id)(
          installBinary(agent, distribution.binaryTarget!).pipe(
            Effect.tap(() => reservePreparedBinary(agent.id)),
          ),
        );
      } else {
        yield* withInstallPermit(agent.id)(
          ensureGlobalPackage(agent, distribution.kind, distribution.packageName!, hostEnvironment),
        );
      }
      return {
        agentId: agent.id,
        version: agent.version,
        distribution: distribution.kind,
        prepared: true,
      } satisfies AcpRegistryPrepareResult;
    },
  );

  const validateLocalExecutable = (command: string) =>
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
      ? Effect.fail(
          new AcpRegistryError({
            reason: "runner_unavailable",
            detail:
              "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
          }),
        )
      : Effect.void;

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = Effect.fn("AcpRegistryCatalog.inspect")(
    function* (settings, environment) {
      if (settings.source === "local") {
        const command = settings.commandPath.trim();
        if (!command) return { status: "unconfigured" } as const;
        const executable = resolveExecutable(command, platform, environment ?? hostEnvironment);
        if (executable !== undefined) yield* validateLocalExecutable(executable);
        return executable === undefined
          ? ({
              status: "missing_runner",
              version: null,
              distribution: "local",
            } as const)
          : ({ status: "ready", agentId: command, version: null, distribution: "local" } as const);
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) return { status: "unconfigured" } as const;
      const registry = yield* loadCachedRegistry();
      const agent = registry.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) return { status: "not_found", agentId } as const;
      const documentationUrl = agent.website ?? agent.repository;
      const distribution = resolveAcpRegistryDistribution({
        agent,
        preference: settings.distribution,
        platformTarget,
      });
      if (distribution === undefined) {
        return { status: "unsupported", agentId, version: agent.version } as const;
      }

      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const available =
          resolveExecutable(commandOverride, platform, environment ?? hostEnvironment) !==
          undefined;
        return available
          ? ({
              status: "ready",
              agentId,
              version: null,
              distribution: distribution.kind,
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const)
          : ({
              status: "missing_runner",
              agentId,
              version: agent.version,
              distribution: distribution.kind,
              runner: commandOverride,
            } as const);
      }

      if (distribution.kind === "binary") {
        return yield* withInstallPermit(agent.id)(
          Effect.gen(function* () {
            const paths = binaryPaths(agent, distribution.binaryTarget!);
            if (paths === undefined) {
              return { status: "unsupported", agentId, version: agent.version } as const;
            }
            yield* consumePreparedBinaryReservation(agent.id);
            const exists = yield* fileSystem
              .exists(paths.executablePath)
              .pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              return {
                status: "unprepared",
                agentId,
                version: agent.version,
                distribution: "binary",
              } as const;
            }
            yield* assertExecutableInRoot(paths.installRoot, paths.executablePath).pipe(
              Effect.mapError((cause) =>
                isAcpRegistryError(cause)
                  ? cause
                  : new AcpRegistryError({
                      reason: "install_failed",
                      detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                      cause,
                    }),
              ),
            );
            return {
              status: "ready",
              agentId,
              version: agent.version,
              distribution: "binary",
              ...(documentationUrl ? { documentationUrl } : {}),
            } as const;
          }),
        );
      }

      const runner = packageManagerFor(distribution.kind)!;
      const available =
        resolveExecutable(runner, platform, environment ?? hostEnvironment) !== undefined;
      return available
        ? ({
            status: "ready",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            ...(documentationUrl ? { documentationUrl } : {}),
          } as const)
        : ({
            status: "missing_runner",
            agentId,
            version: agent.version,
            distribution: distribution.kind,
            runner,
          } as const);
    },
  );

  const resolve: AcpRegistryCatalog["Service"]["resolve"] = Effect.fn("AcpRegistryCatalog.resolve")(
    function* (settings, cwd, environment) {
      if (settings.source === "local") {
        const executable = settings.commandPath.trim();
        if (!executable) {
          return yield* new AcpRegistryError({
            reason: "agent_not_configured",
            detail: "Local ACP provider requires an executable.",
          });
        }
        const env = environment ?? hostEnvironment;
        const command = resolveExecutable(executable, platform, env);
        if (command === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: "Local ACP executable is not available on this environment's PATH.",
          });
        }
        yield* validateLocalExecutable(command);
        return {
          distribution: "local",
          spawn: { command, args: settings.commandArgs, cwd, env, shell: false },
        } satisfies ResolvedAcpRegistryAgent;
      }
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "ACP Registry provider requires a registry agent ID.",
        });
      }
      const registry = yield* loadRegistry();
      const agent = yield* findAgent(registry, agentId);
      const distribution = yield* compatibleDistribution(agent, settings.distribution);

      let command: string;
      let args: ReadonlyArray<string>;
      let commandBinDirectory: string | undefined;
      const effectiveEnvironment = environment ?? hostEnvironment;
      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        const resolvedOverride = resolveExecutable(commandOverride, platform, effectiveEnvironment);
        if (resolvedOverride === undefined) {
          return yield* new AcpRegistryError({
            reason: "runner_unavailable",
            detail: `ACP Registry agent ${agent.id} requires '${commandOverride}', but it is not available on this provider instance's PATH.`,
          });
        }
        command = resolvedOverride;
        args = distribution.args;
      } else if (distribution.kind === "npx" || distribution.kind === "uvx") {
        const installed = yield* withInstallPermit(agent.id)(
          ensureGlobalPackage(
            agent,
            distribution.kind,
            distribution.packageName!,
            effectiveEnvironment,
          ),
        );
        command = installed.executablePath;
        args = distribution.args;
        commandBinDirectory = installed.binDirectory;
      } else {
        const target = distribution.binaryTarget!;
        command = yield* withInstallPermit(agent.id)(
          installBinary(agent, target).pipe(
            Effect.tap(() => consumePreparedBinaryReservation(agent.id)),
          ),
        );
        args = distribution.args;
      }

      const baseSpawnEnvironment = {
        ...effectiveEnvironment,
        ...distribution.env,
      };
      const spawnEnvironment =
        commandBinDirectory === undefined
          ? baseSpawnEnvironment
          : withPreferredPath(baseSpawnEnvironment, commandBinDirectory, platform);

      return {
        agent,
        distribution: distribution.kind,
        spawn: {
          command,
          args,
          cwd,
          env: spawnEnvironment,
        },
      } satisfies ResolvedAcpRegistryAgent;
    },
  );

  const uninstallManagedBinary: AcpRegistryCatalog["Service"]["uninstallManagedBinary"] = (input) =>
    hostSettings
      .withSnapshot((settings) =>
        withInstallPermit(input.agentId)(
          Effect.gen(function* () {
            const safeAgentId = yield* decodeBoundedAgentId(input.agentId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: "ACP Registry managed binary uninstall received an invalid agent ID.",
                    cause,
                  }),
              ),
            );
            const isReferenced = Object.values(settings.providerInstances).some((instance) => {
              if (
                instance.driver !== "acpRegistry" ||
                instance.config === null ||
                typeof instance.config !== "object"
              )
                return false;
              const config = instance.config as Record<string, unknown>;
              return (
                config.source !== "local" &&
                typeof config.agentId === "string" &&
                config.agentId.trim() === safeAgentId
              );
            });
            if (isReferenced) {
              yield* consumePreparedBinaryReservation(safeAgentId);
              return { agentId: safeAgentId, removed: false };
            }
            if (yield* hasPreparedBinaryReservation(safeAgentId)) {
              return { agentId: safeAgentId, removed: false };
            }
            const agentRoot = path.join(installsDirectory, safeAgentId);
            const existed = yield* fileSystem.exists(agentRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not inspect the managed binary cache for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            if (!existed) return { agentId: safeAgentId, removed: false };

            let removed = false;
            yield* Effect.gen(function* () {
              for (const version of yield* fileSystem.readDirectory(agentRoot)) {
                const versionRoot = path.join(agentRoot, version);
                for (const entry of yield* fileSystem.readDirectory(versionRoot)) {
                  if (!/^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/u.test(entry)) continue;
                  yield* fileSystem.remove(path.join(versionRoot, entry), {
                    recursive: true,
                    force: true,
                  });
                  removed = true;
                }
                if ((yield* fileSystem.readDirectory(versionRoot)).length === 0)
                  yield* fileSystem.remove(versionRoot, { recursive: true });
              }
              if ((yield* fileSystem.readDirectory(agentRoot)).length === 0)
                yield* fileSystem.remove(agentRoot, { recursive: true });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryError({
                    reason: "install_failed",
                    detail: `Could not remove managed binaries for ACP Registry agent ${safeAgentId}.`,
                    cause,
                  }),
              ),
            );
            return { agentId: safeAgentId, removed };
          }),
        ),
      )
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail:
                "Could not read provider settings while checking managed ACP binary references.",
              cause,
            }),
        }),
      );

  return AcpRegistryCatalog.of({
    search,
    prepare,
    inspect,
    resolve,
    uninstallManagedBinary,
  });
};
