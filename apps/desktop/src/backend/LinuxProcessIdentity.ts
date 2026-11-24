// @effect-diagnostics nodeBuiltinImport:off - Recovery reads /proc synchronously inside its helper process.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import type { MacProcessAuditToken } from "./MacProcessAuditToken.ts";

// Same 32-byte layout as a macOS audit token, so records and auditTokenPid work unchanged:
// the start time (clock ticks since boot) in bytes 0-7 and the PID at byte 20.
const TOKEN_BYTES = 32;
const PID_OFFSET = 20;

function readStat(pid: number): { state: string; parent: number; startTime: bigint } | undefined {
  let stat: string;
  try {
    stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // proc(5): the command name is in parentheses and may itself contain ") ".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const parent = Number(fields[1]);
  const startTime = fields[19];
  if (fields[0] === undefined || !Number.isSafeInteger(parent) || !/^\d+$/.test(startTime ?? "")) {
    return undefined;
  }
  return { state: fields[0], parent, startTime: BigInt(startTime!) };
}

/** A PID with its start time; the recovery record's boot id makes the pair unique. */
export const linuxProcessIdentity: MacProcessAuditToken = {
  read(pid) {
    const stat = readStat(pid);
    // A zombie holds no lock and cannot be signalled into exiting.
    if (stat === undefined || stat.state === "Z") return undefined;
    const token = Buffer.alloc(TOKEN_BYTES);
    token.writeBigUInt64LE(stat.startTime);
    token.writeUInt32LE(pid, PID_OFFSET);
    return token.toString("hex");
  },
  executable(pid) {
    try {
      return NodeFS.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return undefined;
    }
  },
  parent: (pid) => readStat(pid)?.parent,
  signal(token, name) {
    const pid = Buffer.from(token, "hex").readUInt32LE(PID_OFFSET);
    // Node has no pidfd signal; checking the start time first leaves only a reuse race of
    // microseconds, after the record's process was already seen as this backend.
    if (linuxProcessIdentity.read(pid) !== token) return;
    try {
      NodeProcess.kill(pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};
