// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings and prepares the Linux desktop entry synchronously before app services are available.
// @effect-diagnostics globalTimers:off -- Bounded SIGKILL for a fire-and-forget icon-cache helper before app services exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import {
  linuxDesktopIconInstallOperations,
  renderUrlHandlerDesktopEntry,
} from "./DesktopLinuxUrlHandler.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

function linuxDesktopIconNeedsCopy(sourcePath: string, targetPath: string): boolean {
  if (!NodeFS.existsSync(sourcePath)) return false;
  if (!NodeFS.existsSync(targetPath)) return true;
  try {
    return NodeFS.statSync(sourcePath).size !== NodeFS.statSync(targetPath).size;
  } catch {
    return true;
  }
}

function refreshLinuxDesktopIconCache(cacheDir: string): void {
  try {
    const child = NodeChildProcess.spawn("gtk-update-icon-cache", ["-f", "-t", cacheDir], {
      stdio: "ignore",
    });
    child.unref();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    timer.unref();
    const stop = () => clearTimeout(timer);
    child.on("error", stop);
    child.on("exit", stop);
  } catch {
    // Icon files are already in place; a missing cache tool is not fatal.
  }
}

function installLinuxDesktopIconsFromAppImage(input: {
  readonly appDir: string;
  readonly dataHome: string;
  readonly desktopEntryName: string;
}): void {
  const pending = linuxDesktopIconInstallOperations({
    packagedHicolorRoot: NodePath.posix.join(input.appDir, "usr/share/icons/hicolor"),
    dataHome: input.dataHome,
    desktopEntryName: input.desktopEntryName,
  }).filter((operation) => linuxDesktopIconNeedsCopy(operation.sourcePath, operation.targetPath));
  if (pending.length === 0) return;
  const directories = new Set(
    pending.map((operation) => NodePath.posix.dirname(operation.targetPath)),
  );
  for (const directory of directories) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  for (const operation of pending) {
    NodeFS.copyFileSync(operation.sourcePath, operation.targetPath);
  }
  refreshLinuxDesktopIconCache(NodePath.posix.join(input.dataHome, "icons/hicolor"));
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

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const dataHome =
          process.env.XDG_DATA_HOME?.trim() ||
          NodePath.posix.join(NodeOS.homedir(), ".local", "share");
        const applicationsDir = NodePath.posix.join(dataHome, "applications");
        NodeFS.mkdirSync(applicationsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
          renderUrlHandlerDesktopEntry({
            displayName: resolveDesktopAppBranding({
              isDevelopment: linux.isDevelopment,
              appVersion: Electron.app.getVersion(),
            }).displayName,
            execTarget: process.env.APPIMAGE?.trim() || process.execPath,
            scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
          }),
          "utf8",
        );
        const appDir = process.env.APPDIR?.trim();
        if (appDir) {
          // Stay inside this Effect.sync. Awaiting fs.promises here returns to
          // the event loop, Electron emits ready, and Clerk's
          // registerSchemesAsPrivileged then throws.
          installLinuxDesktopIconsFromAppImage({
            appDir,
            dataHome,
            desktopEntryName: linux.linuxDesktopEntryName,
          });
        }
      } catch {
        // Later URL-handler registration retries the desktop entry and logs failures.
        // Icon install is best-effort and is not retried.
      }
      // Chromium caches its portal registration during startup. Set the identity
      // before any asynchronous work can initialize it with Electron's default.
      Electron.app.setDesktopName(linux.linuxDesktopEntryName);
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
