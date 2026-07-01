// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

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

export function makeDesktopElectronPreReadyLayer<E, R, E2, R2>(input: {
  readonly schemePrivilegesLayer: Layer.Layer<never, E, R>;
  readonly configureElectronBeforeReady: Effect.Effect<
    DesktopPreReadyElectronOptions["Service"],
    E2,
    R2
  >;
}): Layer.Layer<DesktopPreReadyElectronOptions, E | E2, R | R2> {
  return Layer.mergeAll(
    input.schemePrivilegesLayer,
    Layer.effect(DesktopPreReadyElectronOptions, input.configureElectronBeforeReady),
  );
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
    });
