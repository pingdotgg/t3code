// @effect-diagnostics-next-line nodeBuiltinImport:off - pre-ready Electron setup reads persisted settings synchronously before app services are available.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      exists: existsSync,
      homeDirectory: homedir(),
      readFileString: (path) => readFileSync(path, "utf8"),
      uid: process.getuid?.(),
    });
