import * as NodeOS from "node:os";

import { type DevinSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

const DEVIN_XDG_DIRECTORY_NAME = "devin";
export const DEVIN_USAGE_TRANSCRIPT_NAME = "t3code-usage.jsonl";

export interface DevinProfileLayout {
  readonly profileRootPath: string | undefined;
  readonly configHomePath: string;
  readonly dataHomePath: string;
  readonly cacheHomePath: string;
  readonly configDirectoryPath: string;
  readonly dataDirectoryPath: string;
  readonly cacheDirectoryPath: string;
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves the locations the current Devin CLI actually uses.
 *
 * Devin stores its state below the XDG config, data, and cache roots. A configured
 * T3 profile path becomes a self-contained set of those roots; an empty path keeps
 * the user's existing CLI profile and honours inherited XDG overrides.
 */
export const resolveDevinProfileLayout = Effect.fn("resolveDevinProfileLayout")(function* (
  config: Pick<DevinSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<DevinProfileLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const configuredProfileRoot = config.homePath.trim();

  if (configuredProfileRoot.length > 0) {
    const profileRootPath = path.resolve(expandHomePath(configuredProfileRoot));
    const configHomePath = path.join(profileRootPath, "config");
    const dataHomePath = path.join(profileRootPath, "data");
    const cacheHomePath = path.join(profileRootPath, "cache");
    return {
      profileRootPath,
      configHomePath,
      dataHomePath,
      cacheHomePath,
      configDirectoryPath: path.join(configHomePath, DEVIN_XDG_DIRECTORY_NAME),
      dataDirectoryPath: path.join(dataHomePath, DEVIN_XDG_DIRECTORY_NAME),
      cacheDirectoryPath: path.join(cacheHomePath, DEVIN_XDG_DIRECTORY_NAME),
    };
  }

  const userHomePath = path.resolve(
    expandHomePath(nonEmptyEnvironmentValue(baseEnv.HOME) ?? NodeOS.homedir()),
  );
  const configHomePath = path.resolve(
    expandHomePath(
      nonEmptyEnvironmentValue(baseEnv.XDG_CONFIG_HOME) ?? path.join(userHomePath, ".config"),
    ),
  );
  const dataHomePath = path.resolve(
    expandHomePath(
      nonEmptyEnvironmentValue(baseEnv.XDG_DATA_HOME) ?? path.join(userHomePath, ".local", "share"),
    ),
  );
  const cacheHomePath = path.resolve(
    expandHomePath(
      nonEmptyEnvironmentValue(baseEnv.XDG_CACHE_HOME) ?? path.join(userHomePath, ".cache"),
    ),
  );

  return {
    profileRootPath: undefined,
    configHomePath,
    dataHomePath,
    cacheHomePath,
    configDirectoryPath: path.join(configHomePath, DEVIN_XDG_DIRECTORY_NAME),
    dataDirectoryPath: path.join(dataHomePath, DEVIN_XDG_DIRECTORY_NAME),
    cacheDirectoryPath: path.join(cacheHomePath, DEVIN_XDG_DIRECTORY_NAME),
  };
});

export const makeDevinEnvironment = Effect.fn("makeDevinEnvironment")(function* (
  config: Pick<DevinSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const layout = yield* resolveDevinProfileLayout(config, baseEnv);
  const environment: NodeJS.ProcessEnv = { ...baseEnv };

  if (layout.profileRootPath !== undefined) {
    environment.DEVIN_HOME = layout.profileRootPath;
    environment.XDG_CONFIG_HOME = layout.configHomePath;
    environment.XDG_DATA_HOME = layout.dataHomePath;
    environment.XDG_CACHE_HOME = layout.cacheHomePath;
    return environment;
  }

  // XDG requires absolute paths. Normalize inherited overrides so Devin's state
  // does not unexpectedly become relative to each thread's working directory.
  if (baseEnv.XDG_CONFIG_HOME !== undefined) {
    environment.XDG_CONFIG_HOME = layout.configHomePath;
  }
  if (baseEnv.XDG_DATA_HOME !== undefined) {
    environment.XDG_DATA_HOME = layout.dataHomePath;
  }
  if (baseEnv.XDG_CACHE_HOME !== undefined) {
    environment.XDG_CACHE_HOME = layout.cacheHomePath;
  }

  return environment;
});

function makeDevinProfileIdentity(layout: DevinProfileLayout): string {
  return `${layout.configHomePath}\0${layout.dataHomePath}\0${layout.cacheHomePath}`;
}

type DevinRuntimeIdentitySettings = Partial<Pick<DevinSettings, "agentType" | "configPath">>;

function makeDevinRuntimeIdentity(config: DevinRuntimeIdentitySettings): string | undefined {
  const configPath = config.configPath?.trim();
  const agentType = config.agentType ?? "default";
  if (!configPath && agentType === "default") {
    return undefined;
  }
  return `${configPath ? expandHomePath(configPath) : ""}\0${agentType}`;
}

export const makeDevinContinuationGroupKey = Effect.fn("makeDevinContinuationGroupKey")(function* (
  config: Pick<DevinSettings, "homePath"> & DevinRuntimeIdentitySettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const layout = yield* resolveDevinProfileLayout(config, environment);
  const profileIdentity = `devin:profile:${makeDevinProfileIdentity(layout)}`;
  const runtimeIdentity = makeDevinRuntimeIdentity(config);
  return runtimeIdentity ? `${profileIdentity}\0${runtimeIdentity}` : profileIdentity;
});

export const makeDevinCapabilitiesCacheKey = Effect.fn("makeDevinCapabilitiesCacheKey")(function* (
  config: Pick<DevinSettings, "binaryPath" | "homePath"> & DevinRuntimeIdentitySettings,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const layout = yield* resolveDevinProfileLayout(config, environment);
  const baseKey = `${config.binaryPath}\0${makeDevinProfileIdentity(layout)}\0${cwd ?? ""}`;
  const runtimeIdentity = makeDevinRuntimeIdentity(config);
  return runtimeIdentity ? `${baseKey}\0${runtimeIdentity}` : baseKey;
});

export const resolveDevinUsageTranscriptDirectory = Effect.fn(
  "resolveDevinUsageTranscriptDirectory",
)(function* (
  config: Pick<DevinSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const layout = yield* resolveDevinProfileLayout(config, environment);
  return layout.dataDirectoryPath;
});

export const resolveDevinUsageTranscriptPath = Effect.fn("resolveDevinUsageTranscriptPath")(
  function* (
    config: Pick<DevinSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const transcriptDirectory = yield* resolveDevinUsageTranscriptDirectory(config, environment);
    return path.join(transcriptDirectory, DEVIN_USAGE_TRANSCRIPT_NAME);
  },
);
