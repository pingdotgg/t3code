// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Runs synchronously via --require before Effect starts; stderr is its only fallback.
import * as NodePath from "node:path";
import type * as Ffi from "ffi-rs";

// macOS files everything a process starts under its "responsible" app. The backend loads this
// with --require and re-executes in place as the app's Dock-less Helper, disclaiming the desktop
// app, so what agents launch is filed under the Helper. Any failure leaves the backend as it was.
const executable = NodePath.basename(process.execPath);
if (!executable.endsWith(" Helper")) {
  try {
    const helper = NodePath.join(
      process.execPath,
      "../../Frameworks",
      `${executable} Helper.app/Contents/MacOS/${executable} Helper`,
    );
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
    // Node marks inherited descriptors close-on-exec at startup. FIONCLEX keeps stdio and the
    // desktop app's pipes (descriptors 0-7, see DesktopBackendConfiguration) open across the exec;
    // FIOCLEX puts the flag back when the exec fails and this process carries on.
    const setCloseOnExec = (request: number) => {
      for (let fd = 0; fd < 8; fd++) call(I32, "ioctl", [I32, I64], [fd, request]);
    };
    const [argv] = unwrapPointer([call(External, "_NSGetArgv", [], [])]);
    const [environment] = unwrapPointer([call(External, "_NSGetEnviron", [], [])]);
    try {
      setCloseOnExec(0x20006602);
      check(
        "posix_spawn",
        [I64, DataType.String, I64, External, External, External],
        [0, helper, 0, attributes, argv, environment],
      );
    } finally {
      setCloseOnExec(0x20006601);
    }
  } catch (cause) {
    console.warn(`macOS will file processes the backend starts under T3 Code: ${String(cause)}`);
  }
}
