// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
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
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export function readCommandLineSwitchValue(
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

const decodeEarlyDesktopPackageMetadata = Schema.decodeSync(
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
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      Electron.app.commandLine.appendSwitch("class", identity?.packageName ?? linux.linuxWmClass);
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
