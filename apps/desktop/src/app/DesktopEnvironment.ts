import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import {
  applyT3StorageDirectoryOverrides,
  hasT3StorageDirectoryOverrides,
  resolveDefaultT3StorageRoots,
  resolveLegacyT3StorageRoots,
  resolveT3StorageDirectoryOverrides,
  selectT3StorageRoots,
  type T3StorageLayout,
} from "@t3tools/shared/storagePaths";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
  readonly temporaryDirectory?: string;
  readonly userId?: number;
}

export class DesktopStorageDirectoryConfigurationConflictError extends Error {
  override readonly name = "DesktopStorageDirectoryConfigurationConflictError";

  constructor() {
    super(
      "T3CODE_HOME cannot be combined with T3CODE_CONFIG_DIR, T3CODE_DATA_DIR, T3CODE_STATE_DIR, T3CODE_CACHE_DIR, or T3CODE_RUNTIME_DIR.",
    );
  }
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly storageLayout: T3StorageLayout;
    readonly configDir: string;
    readonly dataDir: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly cacheDir: string;
    readonly runtimeDir: string;
    readonly desktopSettingsPath: string;
    readonly clientSettingsPath: string;
    readonly savedEnvironmentRegistryPath: string;
    readonly serverSettingsPath: string;
    readonly logDir: string;
    readonly browserArtifactsDir: string;
    readonly electronUserDataPath: string;
    readonly electronCachePath: string;
    readonly rootDir: string;
    readonly appRoot: string;
    readonly backendEntryPath: string;
    readonly backendCwd: string;
    readonly preloadPath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly devRemoteT3ServerEntryPath: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly commitHashOverride: Option.Option<string>;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly linuxDesktopEntryName: string;
    readonly linuxWmClass: string;
    readonly userDataDirName: string;
    readonly legacyUserDataDirName: string;
    readonly defaultDesktopSettings: DesktopAppSettings.DesktopSettings;
    readonly runtimeInfo: DesktopRuntimeInfo;
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
    readonly developmentDockIconPath: string;
  }
>()("@t3tools/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "T3 Code";

function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<
  DesktopEnvironment["Service"],
  Config.ConfigError | DesktopStorageDirectoryConfigurationConflictError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () =>
          path.join(homeDirectory, "AppData", "Roaming"),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const userDataDirName = isDevelopment ? "t3code-dev" : "t3code";
  const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
  const pathOperations = {
    join: (...paths: ReadonlyArray<string>) => path.join(...paths),
    resolve: (...paths: ReadonlyArray<string>) => path.resolve(...paths),
    isAbsolute: (candidate: string) => path.isAbsolute(candidate),
  };
  const storageEnvironment = {
    T3CODE_CONFIG_DIR: Option.getOrUndefined(config.t3ConfigDir),
    T3CODE_DATA_DIR: Option.getOrUndefined(config.t3DataDir),
    T3CODE_STATE_DIR: Option.getOrUndefined(config.t3StateDir),
    T3CODE_CACHE_DIR: Option.getOrUndefined(config.t3CacheDir),
    T3CODE_RUNTIME_DIR: Option.getOrUndefined(config.t3RuntimeDir),
    XDG_CONFIG_HOME: Option.getOrUndefined(config.xdgConfigHome),
    XDG_DATA_HOME: Option.getOrUndefined(config.xdgDataHome),
    XDG_STATE_HOME: Option.getOrUndefined(config.xdgStateHome),
    XDG_CACHE_HOME: Option.getOrUndefined(config.xdgCacheHome),
    XDG_RUNTIME_DIR: Option.getOrUndefined(config.xdgRuntimeDir),
    APPDATA: Option.getOrUndefined(config.appDataDirectory),
    LOCALAPPDATA: Option.getOrUndefined(config.localAppDataDirectory),
  };
  const defaultSplitRoots = resolveDefaultT3StorageRoots({
    platform: input.platform,
    homeDirectory,
    temporaryDirectory: input.temporaryDirectory ?? NodeOS.tmpdir(),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    isDevelopment,
    environment: storageEnvironment,
    path: pathOperations,
  });
  const directoryOverrides = resolveT3StorageDirectoryOverrides({
    environment: storageEnvironment,
    homeDirectory,
    path: pathOperations,
  });
  const explicitSplitRoots = hasT3StorageDirectoryOverrides(directoryOverrides)
    ? applyT3StorageDirectoryOverrides(defaultSplitRoots, directoryOverrides)
    : undefined;
  const configuredBaseDir = Option.map(config.t3Home, (value) => {
    const expanded =
      value === "~"
        ? homeDirectory
        : value.startsWith("~/") || value.startsWith("~\\")
          ? path.join(homeDirectory, value.slice(2))
          : value;
    return path.resolve(expanded);
  });
  if (Option.isSome(configuredBaseDir) && hasT3StorageDirectoryOverrides(directoryOverrides)) {
    return yield* Effect.fail(new DesktopStorageDirectoryConfigurationConflictError());
  }
  const legacyBaseDir = path.join(homeDirectory, ".t3");
  const legacyRoots = resolveLegacyT3StorageRoots({
    baseDir: legacyBaseDir,
    stateDirectoryName: isDevelopment ? "dev" : "userdata",
    path,
  });
  const explicitLegacyRoots = Option.map(configuredBaseDir, (baseDir) =>
    resolveLegacyT3StorageRoots({
      baseDir,
      stateDirectoryName: "userdata",
      path,
    }),
  );
  const legacyArtifacts = [
    path.join(legacyRoots.stateDir, "state.sqlite"),
    path.join(legacyRoots.configDir, "settings.json"),
    path.join(legacyRoots.configDir, "keybindings.json"),
    path.join(legacyRoots.stateDir, "environment-id"),
    path.join(legacyRoots.stateDir, "connection-catalog.json"),
    path.join(appDataDirectory, legacyUserDataDirName, "Local State"),
    path.join(appDataDirectory, legacyUserDataDirName, "Preferences"),
    path.join(appDataDirectory, userDataDirName, "Local State"),
    path.join(appDataDirectory, userDataDirName, "Preferences"),
  ];
  const legacyStorageInitialized = (yield* Effect.all(
    legacyArtifacts.map((artifact) =>
      fileSystem.exists(artifact).pipe(Effect.orElseSucceed(() => false)),
    ),
    { concurrency: "unbounded" },
  )).some(Boolean);
  const storageRoots = selectT3StorageRoots({
    ...(Option.isNone(explicitLegacyRoots)
      ? {}
      : { explicitLegacyRoots: explicitLegacyRoots.value }),
    ...(explicitSplitRoots === undefined ? {} : { explicitSplitRoots }),
    defaultSplitRoots,
    legacyRoots,
    legacyStorageInitialized,
  });
  const { cacheDir, configDir, dataDir, runtimeDir, stateDir } = storageRoots;
  const baseDir = dataDir;
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const branding = resolveDesktopAppBranding({
    isDevelopment,
    appVersion: input.appVersion,
  });
  const displayName = branding.displayName;
  const resourcesPath = input.resourcesPath;

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath,
    homeDirectory,
    appDataDirectory,
    storageLayout: storageRoots.layout,
    configDir,
    dataDir,
    baseDir,
    stateDir,
    cacheDir,
    runtimeDir,
    desktopSettingsPath: path.join(configDir, "desktop-settings.json"),
    clientSettingsPath: path.join(configDir, "client-settings.json"),
    savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
    serverSettingsPath: path.join(configDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    browserArtifactsDir: path.join(
      storageRoots.layout === "legacy" ? stateDir : cacheDir,
      "browser-artifacts",
    ),
    electronUserDataPath: path.join(stateDir, "electron"),
    electronCachePath: path.join(cacheDir, "electron"),
    rootDir,
    appRoot,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    backendCwd: input.isPackaged ? homeDirectory : appRoot,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    branding,
    displayName,
    appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
      isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
    ),
    linuxDesktopEntryName: isDevelopment ? "t3code-dev.desktop" : "t3code.desktop",
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    userDataDirName,
    legacyUserDataDirName,
    defaultDesktopSettings: DesktopAppSettings.resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
    developmentDockIconPath: path.join(rootDir, "assets", "dev", "blueprint-macos-1024.png"),
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
