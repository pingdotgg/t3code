// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

import type {
  AcpPosixProcessIdentity,
  AcpPosixProcessTreeController,
} from "./AcpSessionRuntime.ts";

const requireForFfi = NodeModule.createRequire(import.meta.url);

export function makeDarwinProcessTreeController(): AcpPosixProcessTreeController {
  const koffi = requireForFfi("koffi") as typeof import("koffi");
  const libproc = koffi.load("/usr/lib/libproc.dylib");
  const libc = koffi.load("/usr/lib/libSystem.B.dylib");
  const pidInfo = libproc.func(
    "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)",
  );
  const pidPath = libproc.func("int proc_pidpath(int pid, void *buffer, uint32_t size)");
  const listPids = libproc.func(
    "int proc_listpids(uint32_t type, uint32_t info, void *buffer, int size)",
  );
  const getSid = libc.func("int getsid(int pid)");

  const pids = (type: number, info: number): ReadonlyArray<number> => {
    const read = (buffer: Buffer | null, size: number): number => {
      // libproc reports errors as zero bytes and errno, also allowing an empty child list.
      koffi.errno(0);
      const bytes: number = listPids(type, info, buffer, size);
      if (bytes < 0 || (bytes === 0 && koffi.errno() !== 0) || bytes % 4 !== 0) {
        throw new Error("Failed to read Darwin process list");
      }
      return bytes;
    };
    const needed = read(null, 0);
    // proc_listpids returns bytes; spare entries absorb forks between sizing and reading.
    let size = needed + 4096;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const buffer = Buffer.alloc(size);
      const bytes = read(buffer, size);
      if (bytes < size) {
        const result: Array<number> = [];
        for (let offset = 0; offset < bytes; offset += 4) {
          const pid = buffer.readInt32LE(offset);
          if (pid > 0) result.push(pid);
        }
        return result;
      }
      size *= 2;
    }
    throw new Error("Darwin process list exceeded its buffer");
  };

  const identity = (pid: number): AcpPosixProcessIdentity | undefined => {
    // SDK proc_bsdinfo uses this 136-byte layout on both Darwin arm64 and x64.
    const info = Buffer.alloc(136);
    if (pidInfo(pid, 3, 0, info, info.length) !== info.length) return undefined;
    const sid: number = getSid(pid);
    if (sid < 0 || info.readUInt32LE(12) !== pid) return undefined;
    const path = Buffer.alloc(4096);
    const pathLength: number = pidPath(pid, path, path.length);
    return {
      pid,
      ppid: info.readUInt32LE(16),
      pgid: info.readUInt32LE(100),
      sid,
      startTime: `${info.readBigUInt64LE(120)}.${info.readBigUInt64LE(128).toString().padStart(6, "0")}`,
      state: info.readUInt32LE(4) === 5 ? "Z" : "live",
      executable:
        pathLength > 0 ? path.toString("utf8", 0, pathLength).replace(/\0.*$/s, "") : undefined,
    };
  };
  const identities = (pids: ReadonlyArray<number>) =>
    pids.flatMap((pid) => {
      const observed = identity(pid);
      return observed === undefined ? [] : [observed];
    });

  return {
    identity,
    childPidsOf: (pid) => pids(6, pid),
    childrenOf: (pid) => identities(pids(6, pid)),
    snapshot: () => identities(pids(1, 0)),
    signalProcess: (pid, signal) => process.kill(pid, signal),
  };
}
