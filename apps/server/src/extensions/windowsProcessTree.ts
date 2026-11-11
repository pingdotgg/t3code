// @effect-diagnostics nodeBuiltinImport:off -- The server owns Windows jobs and loads native dependencies from its packaged runtime.
import * as NodeModule from "node:module";

let binding: typeof import("ffi-rs") | undefined;
const kernel32 = () => {
  if (binding) return binding;
  const native = NodeModule.createRequire(import.meta.url)("ffi-rs") as typeof import("ffi-rs");
  native.open({ library: "t3-extension-job", path: "kernel32.dll" });
  binding = native;
  return native;
};

export function ownWindowsProcessTree(pid: number): () => void {
  const { load, DataType } = kernel32();
  const library = "t3-extension-job";
  const job = load({
    library,
    funcName: "CreateJobObjectW",
    retType: DataType.BigInt,
    paramsType: [DataType.BigInt, DataType.BigInt],
    paramsValue: [0n, 0n],
  });
  if (job === 0n) throw new Error("Could not create the extension process job.");
  try {
    // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION; breakaway stays available to trusted code.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000 | 0x800, 16);
    const configured = load({
      library,
      funcName: "SetInformationJobObject",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.I32, DataType.U8Array, DataType.U32],
      paramsValue: [job, 9, [...limits], limits.length],
    });
    if (!configured) throw new Error("Could not configure extension process cleanup.");
    const child = load({
      library,
      funcName: "OpenProcess",
      retType: DataType.BigInt,
      paramsType: [DataType.U32, DataType.I32, DataType.U32],
      paramsValue: [0x101, 0, pid],
    });
    if (child === 0n) throw new Error("Could not open the extension process.");
    try {
      const assigned = load({
        library,
        funcName: "AssignProcessToJobObject",
        retType: DataType.I32,
        paramsType: [DataType.BigInt, DataType.BigInt],
        paramsValue: [job, child],
      });
      if (!assigned) throw new Error("Could not own the extension process tree.");
    } finally {
      load({
        library,
        funcName: "CloseHandle",
        retType: DataType.I32,
        paramsType: [DataType.BigInt],
        paramsValue: [child],
      });
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      load({
        library,
        funcName: "CloseHandle",
        retType: DataType.I32,
        paramsType: [DataType.BigInt],
        paramsValue: [job],
      });
    };
  } catch (cause) {
    load({
      library,
      funcName: "CloseHandle",
      retType: DataType.I32,
      paramsType: [DataType.BigInt],
      paramsValue: [job],
    });
    throw cause;
  }
}
