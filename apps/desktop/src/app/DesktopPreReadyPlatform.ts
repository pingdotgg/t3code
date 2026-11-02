import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { configureBeforeReady } from "./configureBeforeReady.ts";
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

/** @public */
export const make = Effect.gen(function* () {
  const boot = desktopBootState();
  if (boot) return boot.preReadyOptions;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  return yield* Effect.sync(() => configureBeforeReady(platform, homeDirectory));
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
