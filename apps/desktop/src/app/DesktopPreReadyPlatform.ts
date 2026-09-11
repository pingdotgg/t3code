// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings and prepares the Linux desktop entry synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  DesktopPackageMetadata,
  resolveDesktopRuntimeIdentity,
  resolveDesktopUrlScheme,
} from "@t3tools/shared/desktopBuild";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
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

const decodeEarlyDesktopPackageMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopPackageMetadata),
);

/** Reads packaged identity synchronously before Electron can emit ready. */
function resolveEarlyDesktopIdentityFromProcess() {
  // Identity must be known before any asynchronous runtime layer can let
  // Electron become ready. Clerk later registers the same renderer scheme.
  const packagedIdentity = Electron.app.isPackaged
    ? decodeEarlyDesktopPackageMetadata(
        NodeFS.readFileSync(NodePath.join(Electron.app.getAppPath(), "package.json"), "utf8"),
      ).t3codeDesktopIdentity
    : undefined;
  return Electron.app.isPackaged
    ? resolveDesktopRuntimeIdentity({
        isDevelopment: false,
        isPackaged: true,
        stageLabel: isNightlyDesktopVersion(Electron.app.getVersion()) ? "Nightly" : "Alpha",
        appName: Electron.app.getName(),
        ...(packagedIdentity === undefined ? {} : { packagedIdentity }),
      })
    : null;
}

export function resolveEarlyDesktopSchemeFromProcess(): string | null {
  const identity = resolveEarlyDesktopIdentityFromProcess();
  return identity === null ? null : resolveDesktopUrlScheme(false, identity.distributionId);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const identity = resolveEarlyDesktopIdentityFromProcess();
    const distributionScheme =
      identity === null ? null : resolveDesktopUrlScheme(false, identity.distributionId);
    ElectronProtocol.registerDesktopSchemePrivilegesSync(
      distributionScheme === null ? [] : [distributionScheme],
    );

    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const earlyLinux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;
    const linux =
      earlyLinux !== null && identity?.distributionId != null
        ? {
            ...earlyLinux,
            linuxDesktopEntryName: `${identity.packageName}.desktop`,
            linuxWmClass: identity.packageName,
          }
        : earlyLinux;

    if (linux !== null) {
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const applicationsDir = NodePath.posix.join(
          process.env.XDG_DATA_HOME?.trim() ||
            NodePath.posix.join(NodeOS.homedir(), ".local", "share"),
          "applications",
        );
        NodeFS.mkdirSync(applicationsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
          renderUrlHandlerDesktopEntry({
            displayName:
              identity?.displayName ??
              resolveDesktopAppBranding({
                isDevelopment: linux.isDevelopment,
                appVersion: Electron.app.getVersion(),
              }).displayName,
            execTarget: process.env.APPIMAGE?.trim() || process.execPath,
            scheme: ElectronProtocol.getDesktopScheme(
              linux.isDevelopment,
              identity?.distributionId ?? null,
            ),
          }),
          "utf8",
        );
      } catch {
        // The URL handler retries with the full environment and logs failures.
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
export const layer = Layer.effect(DesktopPreReadyElectronOptions, make);
