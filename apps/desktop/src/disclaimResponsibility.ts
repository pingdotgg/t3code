// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Runs synchronously via --require before Effect starts; stderr is its only fallback.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as Ffi from "ffi-rs";

import {
  BACKEND_SETTLED_ACK_FD,
  BACKEND_SETTLED_LINE,
  keepOpenAcrossExec,
  macHelperExecutable,
} from "./macHelperExec.ts";

// macOS files everything a process starts under its "responsible" app. The backend loads this
// with --require and re-executes in place as the app's Dock-less Helper, disclaiming the desktop
// app, so what agents launch is filed under the Helper. Any failure leaves the backend as it was.
if (!NodePath.basename(process.execPath).endsWith(" Helper")) {
  try {
    const helper = macHelperExecutable(process.execPath);
    const { DataType, load, open, unwrapPointer } = require("ffi-rs") as typeof Ffi;
    const { External, I32, I64 } = DataType;
    open({ library: "libSystem", path: "/usr/lib/libSystem.B.dylib" });
    const call = <T extends Ffi.DataType>(
      retType: T,
      funcName: string,
      paramsType: Array<Ffi.DataType>,
      paramsValue: Array<unknown>,
    ) => load({ library: "libSystem", funcName, retType, paramsType, paramsValue });
    const check = (name: string, types: Array<Ffi.DataType>, values: Array<unknown>) => {
      const error = call(I32, name, types, values);
      if (error !== 0) throw new Error(`${name} failed with ${error}`);
    };
    const attributes = call(External, "malloc", [I64], [8]);
    check("posix_spawnattr_init", [External], [attributes]);
    // POSIX_SPAWN_SETEXEC: replace this process, keeping the PID the desktop app supervises.
    check("posix_spawnattr_setflags", [External, I32], [attributes, 0x40]);
    // A private libSystem export. On a macOS without it this throws before anything changes.
    check("responsibility_spawnattrs_setdisclaim", [External, I32], [attributes, 1]);
    const [argv] = unwrapPointer([call(External, "_NSGetArgv", [], [])]);
    const [environment] = unwrapPointer([call(External, "_NSGetEnviron", [], [])]);
    // Node marks inherited descriptors close-on-exec at startup. Stdio and the desktop app's
    // pipes (descriptors 0-8, see DesktopBackendConfiguration) must stay open across the exec.
    const inherited = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((fd) => {
      try {
        NodeFS.fstatSync(fd);
        return true;
      } catch {
        return false;
      }
    });
    const restore = keepOpenAcrossExec(inherited, (fd, request) =>
      call(I32, "ioctl", [I32, I64], [fd, request]),
    );
    try {
      check(
        "posix_spawn",
        [I64, DataType.String, I64, External, External, External],
        [0, helper, 0, attributes, argv, environment],
      );
    } finally {
      // Only reached when the exec failed and this process carries on.
      const unrestored = restore();
      if (unrestored.length > 0) {
        console.warn(
          `Descriptors ${unrestored.join(", ")} stay open in processes the backend starts`,
        );
      }
    }
  } catch (cause) {
    console.warn(`macOS will file processes the backend starts under T3 Code: ${String(cause)}`);
  }
}

// Now in its final process. Backend recovery identifies the backend by its audit token, which
// the exec changed, so the desktop records it here, before the server can take the T3 home. Only
// the desktop's ack lets the backend start; anything else means the desktop went away unrecorded.
try {
  NodeFS.writeSync(5, BACKEND_SETTLED_LINE);
  const ack = Buffer.alloc(1);
  if (NodeFS.readSync(BACKEND_SETTLED_ACK_FD, ack) !== 1 || ack[0] !== 1) {
    throw new Error("the desktop app did not acknowledge the backend");
  }
  NodeFS.closeSync(BACKEND_SETTLED_ACK_FD);
} catch (cause) {
  console.error(`Stopping the backend before it starts: ${String(cause)}`);
  process.exit(1);
}
