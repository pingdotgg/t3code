// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings, prepares the Linux desktop entry, and asks Hyprland for its version synchronously before app services are available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { trimmedString } from "./DesktopConfig.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import { renderUrlHandlerDesktopEntry } from "./DesktopLinuxUrlHandler.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

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

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

const LinuxDesktopEntryConfig = Config.all({
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  launcherPath: trimmedString("T3CODE_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
});

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const linuxDesktopEntryConfig = yield* LinuxDesktopEntryConfig;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux =
      platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess(homeDirectory) : null;

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
          Option.getOrElse(linuxDesktopEntryConfig.xdgDataHome, () =>
            NodePath.posix.join(homeDirectory, ".local", "share"),
          ),
          "applications",
        );
        NodeFS.mkdirSync(applicationsDir, { recursive: true });
        const iconPath = Electron.app.isPackaged
          ? NodePath.posix.join(
              applicationsDir,
              "..",
              "icons",
              `${linux.linuxDesktopEntryName}.png`,
            )
          : undefined;
        if (iconPath !== undefined) {
          try {
            NodeFS.mkdirSync(NodePath.posix.dirname(iconPath), { recursive: true });
            const icon = NodeFS.readFileSync(
              NodePath.posix.join(
                Electron.app.getAppPath(),
                "apps/desktop/prod-resources/icon.png",
              ),
            );
            let current: Buffer | undefined;
            try {
              current = NodeFS.readFileSync(iconPath);
            } catch {}
            if (current === undefined || !current.equals(icon)) {
              NodeFS.writeFileSync(iconPath, icon);
            }
          } catch {}
        }
        const desktopEntryPath = NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName);
        const content = renderUrlHandlerDesktopEntry({
          displayName: resolveDesktopAppBranding({
            isDevelopment: linux.isDevelopment,
            appVersion: Electron.app.getVersion(),
          }).displayName,
          execTarget:
            Option.getOrUndefined(
              Option.orElse(
                linuxDesktopEntryConfig.launcherPath,
                () => linuxDesktopEntryConfig.appImagePath,
              ),
            ) ?? process.execPath,
          scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
          ...(iconPath === undefined ? {} : { iconPath }),
        });
        let existing: string | undefined;
        try {
          existing = NodeFS.readFileSync(desktopEntryPath, "utf8");
        } catch {}
        if (existing !== content) {
          NodeFS.writeFileSync(desktopEntryPath, content, "utf8");
        }
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
      if (disableFeatures !== null) {
        Electron.app.commandLine.appendSwitch("disable-features", disableFeatures);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Complete scheme privileges and switches before later layers can observe app readiness.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
