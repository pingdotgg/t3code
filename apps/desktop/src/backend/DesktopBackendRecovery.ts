// @effect-diagnostics nodeBuiltinImport:off - Secure record opens require O_NOFOLLOW and fstat.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import {
  auditTokenPid,
  isProcessAuditToken,
  loadMacProcessAuditToken,
  type MacProcessAuditToken,
} from "./MacProcessAuditToken.ts";
import { linuxProcessIdentity } from "./LinuxProcessIdentity.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const directoryName = "t3code-backend-recovery";
const maxRecordBytes = 512;
const isDarwin = NodeProcess.platform === "darwin";
// Darwin sys/fcntl.h. Node accepts these open flags but does not export them. Linux has no
// open-time locks, so there a record is written under a temporary name and renamed into place.
const O_SHLOCK = isDarwin ? 0x10 : 0;
const O_EXLOCK = isDarwin ? 0x20 : 0;
const observedFileName = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.json$/;
const scopePattern = /^[0-9a-f]{64}$/;
const bootIdPattern = /^[0-9a-f-]{36}$/i;
const terminateGraceMs = 5_000;
const killGraceMs = 1_000;
const pollIntervalMs = 250;

interface RecoveryRecord {
  readonly version: 1;
  readonly bootId: string;
  readonly scope: string;
  readonly launcher: string;
  readonly backend: string;
}

type RecordReadResult = RecoveryRecord | "incomplete" | undefined;

function decodeRecord(raw: string): RecordReadResult {
  try {
    const value = JSON.parse(raw) as Partial<RecoveryRecord> | null;
    if (
      value?.version !== 1 ||
      typeof value.bootId !== "string" ||
      !bootIdPattern.test(value.bootId) ||
      typeof value.scope !== "string" ||
      !scopePattern.test(value.scope) ||
      !isProcessAuditToken(value.launcher) ||
      !isProcessAuditToken(value.backend)
    ) {
      return undefined;
    }
    const owner = auditTokenPid(value.launcher);
    const child = auditTokenPid(value.backend);
    if (owner <= 1 || child <= 1 || owner > 0x7fff_ffff || child > 0x7fff_ffff || owner === child) {
      return undefined;
    }
    return {
      version: 1,
      bootId: value.bootId,
      scope: value.scope,
      launcher: value.launcher,
      backend: value.backend,
    };
  } catch {
    return "incomplete";
  }
}

const isErrorCode = (error: unknown, code: string) =>
  (error as NodeJS.ErrnoException)?.code === code;

function ownsPrivateFile(info: { uid: number; mode: number }): boolean {
  return info.uid === NodeProcess.getuid?.() && (info.mode & 0o077) === 0;
}

async function readRecord(path: string): Promise<RecordReadResult> {
  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY |
      NodeFS.constants.O_NOFOLLOW |
      NodeFS.constants.O_NONBLOCK |
      O_SHLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !ownsPrivateFile(info) ||
      info.size > maxRecordBytes
    ) {
      return undefined;
    }
    const bytes = Buffer.alloc(maxRecordBytes + 1);
    const { bytesRead } = await file.read(bytes);
    return bytesRead > maxRecordBytes
      ? undefined
      : decodeRecord(bytes.toString("utf8", 0, bytesRead));
  } finally {
    await file.close();
  }
}

type ProcessStatus = "same" | "gone" | "unknown";

function status(native: MacProcessAuditToken, token: string): ProcessStatus {
  const target = auditTokenPid(token);
  const observed = native.read(target);
  if (observed !== undefined) return observed === token ? "same" : "gone";
  try {
    NodeProcess.kill(target, 0);
    return "unknown";
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? "gone" : "unknown";
  }
}

async function waitForExit(
  native: MacProcessAuditToken,
  token: string,
  graceMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) {
    if (status(native, token) === "gone") return true;
    await NodeTimersPromises.setTimeout(pollIntervalMs, undefined, { signal });
  }
  return status(native, token) === "gone";
}

async function recoverRecord(
  native: MacProcessAuditToken,
  record: RecoveryRecord,
  options: { launcherPid: number; signal: AbortSignal; onRecovery: (pid: number) => void },
): Promise<boolean> {
  const backendPid = auditTokenPid(record.backend);
  if (backendPid === options.launcherPid) return false;
  // The launch record already binds the executable. Its vnode may be gone after
  // a volume disconnect, but the kernel still knows the recorded audit token.
  const ownsOrphan = () =>
    status(native, record.launcher) === "gone" &&
    status(native, record.backend) === "same" &&
    // macOS reparents orphans to launchd; Linux may pick a subreaper such as systemd --user.
    native.parent(backendPid) !== auditTokenPid(record.launcher);

  if (status(native, record.backend) === "gone") return true;
  if (!ownsOrphan()) return false;

  options.signal.throwIfAborted();
  options.onRecovery(backendPid);
  native.signal(record.backend, "SIGTERM");
  if (await waitForExit(native, record.backend, terminateGraceMs, options.signal)) return true;
  if (!ownsOrphan()) return false;
  options.signal.throwIfAborted();
  native.signal(record.backend, "SIGKILL");
  return waitForExit(native, record.backend, killGraceMs, options.signal);
}

async function readBootId(): Promise<string> {
  const bootId = isDarwin
    ? (
        await exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 1_000 })
      ).stdout.trim()
    : (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!bootIdPattern.test(bootId)) throw new Error("Could not identify the current boot");
  return bootId;
}

const loadProcessIdentity = (): Promise<MacProcessAuditToken> =>
  isDarwin ? loadMacProcessAuditToken() : Promise.resolve(linuxProcessIdentity);

// A first launch can precede creation of the state directory. Resolve existing
// ancestors so a symlinked home keeps the same key after that directory appears.
async function canonicalHome(path: string): Promise<string> {
  try {
    return await NodeFSP.realpath(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") || NodePath.dirname(path) === path) throw error;
    return NodePath.join(await canonicalHome(NodePath.dirname(path)), NodePath.basename(path));
  }
}

export function make(input: {
  readonly appDataDirectory: string;
  readonly stateDir: string;
  /** The desktop main process; this module runs in a helper so native calls stay off main. */
  readonly launcherPid: number;
  readonly onRecovery: (pid: number) => void;
  readonly onError: (operation: string, error: unknown) => void;
}) {
  // Use Application Support even when the T3 home or the app lives on removable storage.
  const directory = NodePath.join(input.appDataDirectory, directoryName);
  const scope = async () => {
    const appImage = isDarwin ? undefined : NodeProcess.env.APPIMAGE?.trim();
    const [home, executable, installation] = await Promise.all([
      canonicalHome(input.stateDir),
      NodeFSP.realpath(NodeProcess.execPath),
      // An AppImage runs from a new mount path each launch; its file path is the stable install.
      appImage ? NodeFSP.realpath(appImage) : undefined,
    ]);
    const prefix = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([home, installation ?? executable]))
      .digest("hex");
    return { prefix, executable };
  };
  const privateDirectory = async () => {
    const info = await NodeFSP.lstat(directory);
    if (!info.isDirectory() || !ownsPrivateFile(info)) {
      throw new Error("Backend recovery records must be in an owner-only directory");
    }
  };

  return {
    /** Returns the record path, which the launcher removes after observing the backend exit. */
    async track(backendPid: number): Promise<string | undefined> {
      try {
        const [native, bootId, { prefix, executable }] = await Promise.all([
          loadProcessIdentity(),
          readBootId(),
          scope(),
        ]);
        const launcher = native.read(input.launcherPid);
        const backend = native.read(backendPid);
        // A token and executable alone do not prove this desktop actually spawned this process.
        if (
          launcher === undefined ||
          backend === undefined ||
          native.parent(backendPid) !== input.launcherPid ||
          native.executable(backendPid) !== executable ||
          native.read(backendPid) !== backend
        ) {
          throw new Error("Could not verify desktop ownership of the backend");
        }
        await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((error) => {
          if (!isErrorCode(error, "EEXIST")) throw error;
        });
        await privateDirectory();
        const path = NodePath.join(directory, `${prefix}.${NodeCrypto.randomUUID()}.json`);
        const writePath = isDarwin ? path : `${path}.partial`;
        // Take the lock at creation so recovery can distinguish a partial write from a crash.
        {
          await using file = await NodeFSP.open(
            writePath,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              O_EXLOCK,
            0o600,
          );
          await file.writeFile(
            JSON.stringify({ version: 1, bootId, scope: prefix, launcher, backend }),
          );
        }
        if (writePath !== path) await NodeFSP.rename(writePath, path);
        return path;
      } catch (error) {
        input.onError("record backend", error);
        return undefined;
      }
    },
    async recover(signal: AbortSignal = new AbortController().signal): Promise<void> {
      try {
        await privateDirectory();
        const { prefix } = await scope();
        const records = (await NodeFSP.readdir(directory)).filter(
          (name) => name.startsWith(`${prefix}.`) && observedFileName.test(name),
        );
        if (records.length === 0) return;

        const [bootId, native] = await Promise.all([readBootId(), loadProcessIdentity()]);
        await Promise.all(
          records.map(async (name) => {
            const path = NodePath.join(directory, name);
            try {
              const record = await readRecord(path);
              if (
                record === "incomplete" ||
                (record !== undefined &&
                  record.scope === prefix &&
                  (record.bootId !== bootId ||
                    (await recoverRecord(native, record, {
                      launcherPid: input.launcherPid,
                      signal,
                      onRecovery: input.onRecovery,
                    }))))
              ) {
                await NodeFSP.unlink(path);
              }
            } catch (error) {
              // EAGAIN means the launcher is still writing this record.
              if (
                !signal.aborted &&
                !isErrorCode(error, "ENOENT") &&
                !isErrorCode(error, "EAGAIN")
              ) {
                input.onError("recover backend", error);
              }
            }
          }),
        );
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) input.onError("read backend records", error);
      }
    },
  };
}
