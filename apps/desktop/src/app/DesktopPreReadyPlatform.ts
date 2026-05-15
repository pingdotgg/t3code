// @effect-diagnostics-next-line nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as Context from "effect/Context";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";

export interface DesktopPreReadyElectronOptionsShape {
  readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
}

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  DesktopPreReadyElectronOptionsShape
>()("t3/desktop/PreReadyElectronOptions") {}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      exists: existsSync,
      homeDirectory: homedir(),
      readFileString: (path) => readFileSync(path, "utf8"),
      uid: process.getuid?.(),
    });
