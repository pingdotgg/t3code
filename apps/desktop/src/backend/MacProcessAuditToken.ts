import * as NodeOS from "node:os";

// mach/task_info.h: TASK_AUDIT_TOKEN returns eight native uint32_t values.
const TASK_AUDIT_TOKEN = 15;
const AUDIT_TOKEN_WORDS = 8;
const AUDIT_TOKEN_BYTES = AUDIT_TOKEN_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const AUDIT_TOKEN_PID_OFFSET = 5 * Uint32Array.BYTES_PER_ELEMENT;
const PROC_PIDPATH_MAXSIZE = 4096;
// sys/proc_info.h: proc_bsdshortinfo begins with the PID and parent PID.
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDT_SHORTBSDINFO_SIZE = 64;

export const isProcessAuditToken = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export const auditTokenPid = (token: string): number =>
  Buffer.from(token, "hex").readUInt32LE(AUDIT_TOKEN_PID_OFFSET);

export interface MacProcessAuditToken {
  readonly read: (pid: number) => string | undefined;
  readonly executable: (pid: number) => string | undefined;
  readonly parent: (pid: number) => number | undefined;
  readonly signal: (token: string, signal: "SIGTERM" | "SIGKILL") => void;
}

let macProcessAuditToken: Promise<MacProcessAuditToken> | undefined;

/** Signals a kernel process identity so a PID reused after verification cannot receive the signal. */
export const loadMacProcessAuditToken = (): Promise<MacProcessAuditToken> =>
  (macProcessAuditToken ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "t3-macos-process-identity";
    open({ library, path: "/usr/lib/libSystem.B.dylib" });
    const self = load({
      library,
      funcName: "mach_task_self",
      retType: DataType.U32,
      paramsType: [],
      paramsValue: [],
    });

    return {
      read(pid) {
        const task = Buffer.alloc(4);
        const nameResult = load({
          library,
          funcName: "task_name_for_pid",
          retType: DataType.I32,
          paramsType: [DataType.U32, DataType.I32, DataType.U8Array],
          paramsValue: [self, pid, task],
        });
        if (nameResult !== 0) return undefined;

        const port = task.readUInt32LE();
        try {
          const token = Buffer.alloc(AUDIT_TOKEN_BYTES);
          const count = Buffer.alloc(4);
          count.writeUInt32LE(AUDIT_TOKEN_WORDS);
          const infoResult = load({
            library,
            funcName: "task_info",
            retType: DataType.I32,
            paramsType: [DataType.U32, DataType.I32, DataType.U8Array, DataType.U8Array],
            paramsValue: [port, TASK_AUDIT_TOKEN, token, count],
          });
          return infoResult === 0 &&
            count.readUInt32LE() === AUDIT_TOKEN_WORDS &&
            token.readUInt32LE(AUDIT_TOKEN_PID_OFFSET) === pid
            ? token.toString("hex")
            : undefined;
        } finally {
          load({
            library,
            funcName: "mach_port_deallocate",
            retType: DataType.I32,
            paramsType: [DataType.U32, DataType.U32],
            paramsValue: [self, port],
          });
        }
      },
      executable(pid) {
        const path = Buffer.alloc(PROC_PIDPATH_MAXSIZE);
        const length = load({
          library,
          funcName: "proc_pidpath",
          retType: DataType.I32,
          paramsType: [DataType.I32, DataType.U8Array, DataType.U32],
          paramsValue: [pid, path, path.byteLength],
        });
        return length > 0 && length <= path.byteLength
          ? path.toString("utf8", 0, length).replace(/\0$/, "")
          : undefined;
      },
      parent(pid) {
        const info = Buffer.alloc(PROC_PIDT_SHORTBSDINFO_SIZE);
        const length = load({
          library,
          funcName: "proc_pidinfo",
          retType: DataType.I32,
          paramsType: [DataType.I32, DataType.I32, DataType.BigInt, DataType.U8Array, DataType.I32],
          paramsValue: [pid, PROC_PIDT_SHORTBSDINFO, 0n, info, info.byteLength],
        });
        return length === info.byteLength && info.readUInt32LE() === pid
          ? info.readUInt32LE(4)
          : undefined;
      },
      signal(token, name) {
        if (!isProcessAuditToken(token)) throw new Error("Invalid macOS audit token");
        const result = load({
          library,
          funcName: "proc_signal_with_audittoken",
          retType: DataType.I32,
          paramsType: [DataType.U8Array, DataType.I32],
          paramsValue: [Buffer.from(token, "hex"), NodeOS.constants.signals[name]],
        });
        // ESRCH includes a process that exited or was replaced after the last observation.
        if (result !== 0 && result !== NodeOS.constants.errno.ESRCH) {
          throw new Error(`macOS could not deliver ${name} (errno ${result})`);
        }
      },
    };
  }));
