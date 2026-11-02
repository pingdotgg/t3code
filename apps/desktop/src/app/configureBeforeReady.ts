// @effect-diagnostics nodeBuiltinImport:off -- Electron switches and portal identity must be configured before ready.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Electron from "electron";
import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { renderUrlHandlerDesktopEntry } from "./linuxDesktopEntry.ts";
import { resolveDesktopAppBranding } from "./desktopBranding.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

export const resolveEarlyLinuxElectronOptionsFromProcess = (
  homeDirectory: string,
): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
  DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
    env: process.env,
    homeDirectory,
    joinPath: NodePath.posix.join,
    readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
  });

export interface LinuxDesktopEntryEnv {
  readonly xdgDataHome: string | undefined;
  readonly launcherPath: string | undefined;
  readonly appImagePath: string | undefined;
}

const linuxDesktopEntryEnvFromProcess = (): LinuxDesktopEntryEnv => ({
  xdgDataHome: process.env.XDG_DATA_HOME?.trim() || undefined,
  launcherPath: process.env.T3CODE_DESKTOP_LAUNCHER_PATH?.trim() || undefined,
  appImagePath: process.env.APPIMAGE?.trim() || undefined,
});

export function configureBeforeReady(
  platform: NodeJS.Platform,
  homeDirectory: string,
  desktopEntryEnv: LinuxDesktopEntryEnv = linuxDesktopEntryEnvFromProcess(),
) {
  const linuxPasswordStoreCommandLine =
    platform === "linux"
      ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
      : null;
  const linux =
    platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess(homeDirectory) : null;

  if (platform === "darwin" || linux !== null) {
    Electron.app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
    const enableFeatures = [
      readCommandLineSwitchValue(Electron.app.commandLine, "enable-features"),
      // Networking shares the main process's lifetime and crash boundary.
      "NetworkServiceInProcess2",
      // Persistent code caching requires partitioned HTTP caching.
      "SplitCacheByNetworkIsolationKey",
      "UsePersistentCacheForCodeCache",
    ]
      .filter((feature) => feature !== null)
      .join(",");
    Electron.app.commandLine.appendSwitch("enable-features", enableFeatures);
  }

  if (platform === "darwin") {
    Electron.app.commandLine.appendSwitch(
      "disable-features",
      [
        readCommandLineSwitchValue(Electron.app.commandLine, "disable-features"),
        "NetworkServiceDedicatedThread",
        // The app serves local assets and does not use dictionary compression or declarative reporting.
        "CompressionDictionaryTransport",
        "DeclarativePerformanceObserver",
        "HttpCacheNoVarySearch",
        "GpuPersistentCache",
      ]
        .filter((feature) => feature !== null)
        .join(","),
    );
  }

  if (linux !== null) {
    DesktopEarlyElectronStartup.restoreEarlyLinuxDeviceScaleFactor({
      env: process.env,
      homeDirectory,
      joinPath: NodePath.posix.join,
      commandLine: Electron.app.commandLine,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
      writeFileString: (path, value) => {
        NodeFS.mkdirSync(NodePath.posix.dirname(path), { recursive: true });
        NodeFS.writeFileSync(path, value, "utf8");
      },
    });
    // The portal also requires a valid desktop entry. An AppImage update may
    // have removed the executable referenced by the previous launch's entry.
    try {
      const applicationsDir = NodePath.posix.join(
        desktopEntryEnv.xdgDataHome ?? NodePath.posix.join(homeDirectory, ".local", "share"),
        "applications",
      );
      NodeFS.mkdirSync(applicationsDir, { recursive: true });
      const iconPath = Electron.app.isPackaged
        ? NodePath.posix.join(applicationsDir, "..", "icons", `${linux.linuxDesktopEntryName}.png`)
        : undefined;
      if (iconPath !== undefined) {
        try {
          NodeFS.mkdirSync(NodePath.posix.dirname(iconPath), { recursive: true });
          NodeFS.copyFileSync(
            NodePath.posix.join(Electron.app.getAppPath(), "apps/desktop/prod-resources/icon.png"),
            iconPath,
          );
        } catch {}
      }
      NodeFS.writeFileSync(
        NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
        renderUrlHandlerDesktopEntry({
          displayName: resolveDesktopAppBranding({
            isDevelopment: linux.isDevelopment,
            appVersion: Electron.app.getVersion(),
          }).displayName,
          execTarget:
            desktopEntryEnv.launcherPath ?? desktopEntryEnv.appImagePath ?? process.execPath,
          scheme: linux.isDevelopment ? "t3code-dev" : "t3code",
          ...(iconPath === undefined ? {} : { iconPath }),
        }),
        "utf8",
      );
    } catch {}
    // Chromium caches portal identity; set it before any asynchronous initialization.
    Electron.app.setDesktopName(linux.linuxDesktopEntryName);
    if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
      Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
    }
    // Chromium keeps only the last --disable-features value, so pass the merged list.
    const disableFeatures = DesktopEarlyElectronStartup.resolveLinuxDisableFeaturesSwitch({
      env: process.env,
      ozonePlatform: readCommandLineSwitchValue(Electron.app.commandLine, "ozone-platform"),
      enableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "enable-features"),
      disableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "disable-features"),
      readHyprctlVersionJson: () =>
        NodeChildProcess.execFileSync("hyprctl", ["version", "-j"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
    });
    Electron.app.commandLine.appendSwitch(
      "disable-features",
      [
        disableFeatures ?? readCommandLineSwitchValue(Electron.app.commandLine, "disable-features"),
        "NetworkServiceDedicatedThread",
      ]
        .filter((feature) => feature !== null)
        .join(","),
    );
  }

  return { linux, linuxPasswordStoreCommandLine };
}
