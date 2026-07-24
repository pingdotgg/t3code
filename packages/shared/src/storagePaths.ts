export const T3CODE_CONFIG_DIR_ENV = "T3CODE_CONFIG_DIR";
export const T3CODE_DATA_DIR_ENV = "T3CODE_DATA_DIR";
export const T3CODE_STATE_DIR_ENV = "T3CODE_STATE_DIR";
export const T3CODE_CACHE_DIR_ENV = "T3CODE_CACHE_DIR";
export const T3CODE_RUNTIME_DIR_ENV = "T3CODE_RUNTIME_DIR";

export type T3StorageLayout = "split" | "legacy";

export interface T3StorageRoots {
  readonly layout: T3StorageLayout;
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly runtimeDir: string;
  readonly legacyBaseDir?: string;
}

export interface T3StorageDirectoryOverrides {
  readonly configDir?: string;
  readonly dataDir?: string;
  readonly stateDir?: string;
  readonly cacheDir?: string;
  readonly runtimeDir?: string;
}

export interface StoragePathOperations {
  readonly join: (...paths: ReadonlyArray<string>) => string;
  readonly resolve: (...paths: ReadonlyArray<string>) => string;
  readonly isAbsolute: (path: string) => boolean;
}

export interface ResolveDefaultT3StorageRootsInput {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
  readonly userId?: number;
  readonly isDevelopment: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly path: StoragePathOperations;
}

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
};

const absoluteEnvironmentDirectory = (
  value: string | undefined,
  path: StoragePathOperations,
): string | undefined => {
  const candidate = trimmed(value);
  return candidate !== undefined && path.isAbsolute(candidate) ? candidate : undefined;
};

const expandHome = (value: string, homeDirectory: string, path: StoragePathOperations): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2));
  }
  return value;
};

const resolveOverride = (
  value: string | undefined,
  homeDirectory: string,
  path: StoragePathOperations,
): string | undefined => {
  const candidate = trimmed(value);
  return candidate === undefined
    ? undefined
    : path.resolve(expandHome(candidate, homeDirectory, path));
};

export function hasT3StorageDirectoryOverrides(overrides: T3StorageDirectoryOverrides): boolean {
  return Object.values(overrides).some((value) => value !== undefined);
}

export function resolveT3StorageDirectoryOverrides(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly path: StoragePathOperations;
}): T3StorageDirectoryOverrides {
  const { environment, homeDirectory, path } = input;
  const configDir = resolveOverride(environment[T3CODE_CONFIG_DIR_ENV], homeDirectory, path);
  const dataDir = resolveOverride(environment[T3CODE_DATA_DIR_ENV], homeDirectory, path);
  const stateDir = resolveOverride(environment[T3CODE_STATE_DIR_ENV], homeDirectory, path);
  const cacheDir = resolveOverride(environment[T3CODE_CACHE_DIR_ENV], homeDirectory, path);
  const runtimeDir = resolveOverride(environment[T3CODE_RUNTIME_DIR_ENV], homeDirectory, path);
  return {
    ...(configDir === undefined ? {} : { configDir }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
  };
}

export function resolveDefaultT3StorageRoots(
  input: ResolveDefaultT3StorageRootsInput,
): T3StorageRoots {
  const { environment, homeDirectory, isDevelopment, path, platform, temporaryDirectory } = input;
  const applicationDirectoryName = isDevelopment ? "t3code-dev" : "t3code";
  const runtimeFallbackName =
    input.userId === undefined
      ? applicationDirectoryName
      : `${applicationDirectoryName}-${String(input.userId)}`;

  if (platform === "win32") {
    const roamingApplicationData =
      trimmed(environment.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
    const localApplicationData =
      trimmed(environment.LOCALAPPDATA) ?? path.join(homeDirectory, "AppData", "Local");
    const localRoot = path.join(localApplicationData, applicationDirectoryName);
    return {
      layout: "split",
      configDir: path.join(roamingApplicationData, applicationDirectoryName),
      dataDir: path.join(localRoot, "data"),
      stateDir: path.join(localRoot, "state"),
      cacheDir: path.join(localRoot, "cache"),
      runtimeDir: path.join(localRoot, "runtime"),
    };
  }

  const xdgConfigHome = absoluteEnvironmentDirectory(environment.XDG_CONFIG_HOME, path);
  const xdgDataHome = absoluteEnvironmentDirectory(environment.XDG_DATA_HOME, path);
  const xdgStateHome = absoluteEnvironmentDirectory(environment.XDG_STATE_HOME, path);
  const xdgCacheHome = absoluteEnvironmentDirectory(environment.XDG_CACHE_HOME, path);
  const xdgRuntimeHome = absoluteEnvironmentDirectory(environment.XDG_RUNTIME_DIR, path);

  if (platform === "darwin" && xdgConfigHome === undefined && xdgDataHome === undefined) {
    const applicationSupportRoot = path.join(
      homeDirectory,
      "Library",
      "Application Support",
      applicationDirectoryName,
    );
    return {
      layout: "split",
      configDir: path.join(applicationSupportRoot, "config"),
      dataDir: path.join(applicationSupportRoot, "data"),
      stateDir: path.join(applicationSupportRoot, "state"),
      cacheDir: path.join(homeDirectory, "Library", "Caches", applicationDirectoryName),
      runtimeDir: path.join(temporaryDirectory, runtimeFallbackName),
    };
  }

  return {
    layout: "split",
    configDir: path.join(
      xdgConfigHome ?? path.join(homeDirectory, ".config"),
      applicationDirectoryName,
    ),
    dataDir: path.join(
      xdgDataHome ?? path.join(homeDirectory, ".local", "share"),
      applicationDirectoryName,
    ),
    stateDir: path.join(
      xdgStateHome ?? path.join(homeDirectory, ".local", "state"),
      applicationDirectoryName,
    ),
    cacheDir: path.join(
      xdgCacheHome ?? path.join(homeDirectory, ".cache"),
      applicationDirectoryName,
    ),
    runtimeDir:
      xdgRuntimeHome === undefined
        ? path.join(temporaryDirectory, runtimeFallbackName)
        : path.join(xdgRuntimeHome, applicationDirectoryName),
  };
}

export function applyT3StorageDirectoryOverrides(
  defaults: T3StorageRoots,
  overrides: T3StorageDirectoryOverrides,
): T3StorageRoots {
  return {
    layout: "split",
    configDir: overrides.configDir ?? defaults.configDir,
    dataDir: overrides.dataDir ?? defaults.dataDir,
    stateDir: overrides.stateDir ?? defaults.stateDir,
    cacheDir: overrides.cacheDir ?? defaults.cacheDir,
    runtimeDir: overrides.runtimeDir ?? defaults.runtimeDir,
  };
}

export function resolveLegacyT3StorageRoots(input: {
  readonly baseDir: string;
  readonly stateDirectoryName: "userdata" | "dev";
  readonly path: Pick<StoragePathOperations, "join">;
}): T3StorageRoots {
  const stateDir = input.path.join(input.baseDir, input.stateDirectoryName);
  return {
    layout: "legacy",
    configDir: stateDir,
    dataDir: input.baseDir,
    stateDir,
    cacheDir: input.path.join(input.baseDir, "caches"),
    runtimeDir: stateDir,
    legacyBaseDir: input.baseDir,
  };
}

export function selectT3StorageRoots(input: {
  readonly explicitLegacyRoots?: T3StorageRoots;
  readonly explicitSplitRoots?: T3StorageRoots;
  readonly bootstrapRoots?: T3StorageRoots;
  readonly defaultSplitRoots: T3StorageRoots;
  readonly legacyRoots: T3StorageRoots;
  readonly legacyStorageInitialized: boolean;
}): T3StorageRoots {
  if (input.explicitLegacyRoots !== undefined) return input.explicitLegacyRoots;
  if (input.explicitSplitRoots !== undefined) return input.explicitSplitRoots;
  if (input.bootstrapRoots !== undefined) return input.bootstrapRoots;
  return input.legacyStorageInitialized ? input.legacyRoots : input.defaultSplitRoots;
}

export function t3StorageEnvironment(roots: T3StorageRoots): Readonly<Record<string, string>> {
  if (roots.layout === "legacy" && roots.legacyBaseDir !== undefined) {
    return { T3CODE_HOME: roots.legacyBaseDir };
  }
  return {
    [T3CODE_CONFIG_DIR_ENV]: roots.configDir,
    [T3CODE_DATA_DIR_ENV]: roots.dataDir,
    [T3CODE_STATE_DIR_ENV]: roots.stateDir,
    [T3CODE_CACHE_DIR_ENV]: roots.cacheDir,
    [T3CODE_RUNTIME_DIR_ENV]: roots.runtimeDir,
  };
}
