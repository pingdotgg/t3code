import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";
import * as EffectPath from "effect/Path";

import { type DesktopSettings, resolveDefaultDesktopSettings } from "../desktopSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { isNightlyDesktopVersion } from "../updateChannels.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export interface DesktopEnvironmentShape {
  readonly path: EffectPath.Path;
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
  readonly baseDir: string;
  readonly stateDir: string;
  readonly desktopSettingsPath: string;
  readonly clientSettingsPath: string;
  readonly savedEnvironmentRegistryPath: string;
  readonly serverSettingsPath: string;
  readonly logDir: string;
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
  readonly branding: DesktopAppBranding;
  readonly displayName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly userDataDirName: string;
  readonly legacyUserDataDirName: string;
  readonly defaultDesktopSettings: DesktopSettings;
  readonly runtimeInfo: DesktopRuntimeInfo;
  readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
  readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
  readonly developmentDockIconPath: string;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  DesktopEnvironmentShape
>()("t3/desktop/Environment") {}

function resolveDesktopHomeDirectory(input: {
  readonly config: DesktopConfig.DesktopConfigShape;
  readonly cwd: string;
}): string {
  const driveHome = Option.zipWith(
    input.config.homeDrive,
    input.config.homePath,
    (drive, homePath) => `${drive}${homePath}`,
  );
  return Option.getOrElse(
    Option.firstSomeOf([input.config.home, input.config.userProfile, driveHome]),
    () => input.cwd,
  );
}

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

const makeDesktopEnvironment = (
  input: MakeDesktopEnvironmentInput,
): Effect.Effect<DesktopEnvironmentShape, never, EffectPath.Path | DesktopConfig.DesktopConfig> =>
  Effect.gen(function* () {
    const path = yield* EffectPath.Path;
    const config = yield* DesktopConfig.DesktopConfig;
    const homeDirectory = resolveDesktopHomeDirectory({
      config,
      cwd: input.cwd,
    });
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
    const baseDir = Option.getOrElse(config.t3Home, () => path.join(homeDirectory, ".t3"));
    const stateDir = path.join(baseDir, "userdata");
    const rootDir = path.resolve(input.dirname, "../../..");
    const appRoot = input.isPackaged ? input.appPath : rootDir;
    const branding = resolveDesktopAppBranding({
      isDevelopment,
      appVersion: input.appVersion,
    });
    const displayName = branding.displayName;
    const userDataDirName = isDevelopment ? "t3code-dev" : "t3code";
    const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
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
      baseDir,
      stateDir,
      desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
      clientSettingsPath: path.join(stateDir, "client-settings.json"),
      savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
      serverSettingsPath: path.join(stateDir, "settings.json"),
      logDir: path.join(stateDir, "logs"),
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
      branding,
      displayName,
      appUserModelId: isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
      linuxDesktopEntryName: isDevelopment ? "t3code-dev.desktop" : "t3code.desktop",
      linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
      userDataDirName,
      legacyUserDataDirName,
      defaultDesktopSettings: resolveDefaultDesktopSettings(input.appVersion),
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
  Layer.effect(DesktopEnvironment, makeDesktopEnvironment(input));
