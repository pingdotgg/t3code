import type { DesktopAppBranding, DesktopRuntimeInfo } from "@t3tools/contracts";
import { Context, Effect, Option } from "effect";
import * as EffectPath from "effect/Path";

import { resolveDesktopAppBranding } from "./appBranding.ts";
import { type DesktopSettings, resolveDefaultDesktopSettings } from "./desktopSettings.ts";
import { resolveDesktopRuntimeInfo } from "./runtimeArch.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly env: NodeJS.ProcessEnv;
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
  readonly devServerUrl: Option.Option<string>;
  readonly devRemoteT3ServerEntryPath: Option.Option<string>;
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

const trimmedEnvOption = (env: NodeJS.ProcessEnv, name: string): Option.Option<string> =>
  (() => {
    const value = env[name]?.trim();
    return value && value.length > 0 ? Option.some(value) : Option.none();
  })();

export function resolveDesktopHomeDirectory(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}): string {
  const home =
    input.env.HOME?.trim() ||
    input.env.USERPROFILE?.trim() ||
    `${input.env.HOMEDRIVE ?? ""}${input.env.HOMEPATH ?? ""}`.trim();
  return home.length > 0 ? home : input.cwd;
}

export const makeDesktopEnvironment = (
  input: MakeDesktopEnvironmentInput,
): Effect.Effect<DesktopEnvironmentShape, never, EffectPath.Path> =>
  Effect.gen(function* () {
    const path = yield* EffectPath.Path;
    const homeDirectory = resolveDesktopHomeDirectory({
      env: input.env,
      cwd: input.cwd,
    });
    const devServerUrl = trimmedEnvOption(input.env, "VITE_DEV_SERVER_URL");
    const isDevelopment = Option.isSome(devServerUrl);
    const baseDir = Option.getOrElse(trimmedEnvOption(input.env, "T3CODE_HOME"), () =>
      path.join(homeDirectory, ".t3"),
    );
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
      devRemoteT3ServerEntryPath: trimmedEnvOption(
        input.env,
        "T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
      ),
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
