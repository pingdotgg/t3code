import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { configureBeforeReady } from "./configureBeforeReady.ts";
import { trimmedString } from "./DesktopConfig.ts";
import { desktopBootState } from "./desktopBootState.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
export { resolveEarlyLinuxElectronOptionsFromProcess } from "./configureBeforeReady.ts";

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

const LinuxDesktopEntryConfig = Config.all({
  xdgDataHome: trimmedString("XDG_DATA_HOME").pipe(Config.map(Option.getOrUndefined)),
  launcherPath: trimmedString("T3CODE_DESKTOP_LAUNCHER_PATH").pipe(
    Config.map(Option.getOrUndefined),
  ),
  appImagePath: trimmedString("APPIMAGE").pipe(Config.map(Option.getOrUndefined)),
});

/** @public */
export const make = Effect.gen(function* () {
  const boot = desktopBootState();
  if (boot) return boot.preReadyOptions;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const desktopEntryEnv = yield* LinuxDesktopEntryConfig;
  return yield* Effect.sync(() => configureBeforeReady(platform, homeDirectory, desktopEntryEnv));
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
