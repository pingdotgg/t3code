// @effect-diagnostics nodeBuiltinImport:off
import { constants as FsConstants } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { FilesystemDrive, FilesystemDriveKind, FilesystemDriveList } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../processRunner.ts";

// cheap poll of the mount table every 2s while someone's subscribed, the slow
// stuff (labels, kinds, statfs) only runs when the set of mount points changed
export class DriveDiscovery extends Context.Service<
  DriveDiscovery,
  {
    readonly changes: Stream.Stream<FilesystemDriveList>;
  }
>()("t3/workspace/DriveDiscovery") {}

const POLL_INTERVAL = "2 seconds";
const PROBE_TIMEOUT = "2 seconds";

export interface DriveCandidate {
  readonly path: string;
  readonly label: string;
  readonly kind: FilesystemDriveKind;
}

export interface LinuxMountEntry {
  readonly source: string;
  readonly mountPoint: string;
  readonly fsType: string;
}

const LINUX_NETWORK_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.davfs2",
  "davfs",
  "afs",
  "ceph",
  "fuse.ceph",
  "glusterfs",
  "fuse.glusterfs",
]);

const LINUX_WSL_FS_TYPES = new Set(["drvfs", "9p"]);

const LINUX_EXCLUDED_FS_TYPES = new Set(["squashfs", "iso9660", "udf", "erofs"]);

// standard system partitions. /home is covered by the Home location so a
// separate home partition should not double up as a drive
const LINUX_EXCLUDED_MOUNT_PREFIXES = [
  "/boot",
  "/efi",
  "/usr",
  "/var",
  "/tmp",
  "/run",
  "/proc",
  "/sys",
  "/dev",
  "/snap",
  "/home",
  "/root",
];

const DARWIN_NETWORK_FS_TYPES = new Set(["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp"]);

function decodeOctalEscapes(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function decodeUdevEscapes(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function isUnderPrefix(mountPoint: string, prefix: string): boolean {
  return mountPoint === prefix || mountPoint.startsWith(`${prefix}/`);
}

export function parseLinuxMounts(text: string): ReadonlyArray<LinuxMountEntry> {
  const entries: Array<LinuxMountEntry> = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    entries.push({
      source: decodeOctalEscapes(fields[0]!),
      mountPoint: decodeOctalEscapes(fields[1]!),
      fsType: fields[2]!,
    });
  }
  return entries;
}

export function selectLinuxDriveMounts(
  mounts: ReadonlyArray<LinuxMountEntry>,
): ReadonlyArray<LinuxMountEntry & { readonly kind: FilesystemDriveKind }> {
  const byMountPoint = new Map<string, LinuxMountEntry & { readonly kind: FilesystemDriveKind }>();
  const seenBlockDevices = new Set<string>();
  for (const mount of mounts) {
    if (LINUX_EXCLUDED_FS_TYPES.has(mount.fsType)) continue;
    if (mount.source.startsWith("/dev/loop")) continue;
    const isBlockDevice = mount.source.startsWith("/dev/");
    const isNetwork = LINUX_NETWORK_FS_TYPES.has(mount.fsType);
    const isWslDrive = LINUX_WSL_FS_TYPES.has(mount.fsType) && mount.mountPoint.startsWith("/mnt/");
    if (mount.mountPoint !== "/" && !isBlockDevice && !isNetwork && !isWslDrive) continue;
    if (
      mount.mountPoint !== "/" &&
      LINUX_EXCLUDED_MOUNT_PREFIXES.some((prefix) => isUnderPrefix(mount.mountPoint, prefix))
    ) {
      continue;
    }
    if (isBlockDevice && mount.mountPoint !== "/") {
      if (seenBlockDevices.has(mount.source)) continue;
      seenBlockDevices.add(mount.source);
    }
    const kind: FilesystemDriveKind =
      mount.mountPoint === "/" ? "system" : isNetwork ? "network" : "fixed";
    byMountPoint.set(mount.mountPoint, { ...mount, kind });
  }
  const root = byMountPoint.get("/");
  return [...byMountPoint.values()].filter(
    (mount) => mount.mountPoint === "/" || !root || mount.source !== root.source,
  );
}

export function linuxDefaultLabel(mount: LinuxMountEntry): string {
  if (mount.mountPoint === "/") return "System";
  const base = NodePath.posix.basename(mount.mountPoint);
  if (LINUX_WSL_FS_TYPES.has(mount.fsType) && /^[a-zA-Z]$/.test(base)) {
    return `${base.toUpperCase()}:`;
  }
  return base.length > 0 ? base : mount.mountPoint;
}

export interface DarwinMountEntry {
  readonly mountPoint: string;
  readonly fsType: string;
}

export function parseDarwinMountOutput(text: string): ReadonlyArray<DarwinMountEntry> {
  const entries: Array<DarwinMountEntry> = [];
  for (const line of text.split("\n")) {
    const match = /^(.*) on (.*) \(([^,)]+)(?:,[^)]*)?\)\s*$/.exec(line.trim());
    if (!match) continue;
    entries.push({ mountPoint: match[2]!, fsType: match[3]!.trim() });
  }
  return entries;
}

export function darwinDriveKind(path: string, fsType: string | undefined): FilesystemDriveKind {
  if (path === "/") return "system";
  if (fsType !== undefined && DARWIN_NETWORK_FS_TYPES.has(fsType)) return "network";
  return "fixed";
}

export interface WindowsLogicalDisk {
  readonly deviceId: string;
  readonly volumeName: string | null;
  readonly driveType: number | null;
  readonly volumeSerialNumber: string | null;
}

export function parseWindowsLogicalDisks(json: string): ReadonlyArray<WindowsLogicalDisk> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const disks: Array<WindowsLogicalDisk> = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const deviceId = typeof record.DeviceID === "string" ? record.DeviceID.trim() : "";
    if (!/^[a-zA-Z]:$/.test(deviceId)) continue;
    const volumeName =
      typeof record.VolumeName === "string" && record.VolumeName.trim().length > 0
        ? record.VolumeName.trim()
        : null;
    const driveType = typeof record.DriveType === "number" ? record.DriveType : null;
    const serialValue = record.VolumeSerialNumber;
    const volumeSerialNumber =
      typeof serialValue === "string" && serialValue.trim().length > 0
        ? serialValue.trim()
        : typeof serialValue === "number"
          ? String(serialValue)
          : null;
    disks.push({ deviceId: deviceId.toUpperCase(), volumeName, driveType, volumeSerialNumber });
  }
  return disks;
}

export function windowsDriveCandidate(
  letter: string,
  disk: WindowsLogicalDisk | undefined,
  systemDrive: string,
): DriveCandidate {
  const deviceId = `${letter.toUpperCase()}:`;
  const isSystem = deviceId === systemDrive.toUpperCase();
  const kind: FilesystemDriveKind = isSystem
    ? "system"
    : disk?.driveType === 2
      ? "removable"
      : disk?.driveType === 4
        ? "network"
        : "fixed";
  const fallbackName =
    kind === "network" ? "Network Drive" : kind === "removable" ? "Removable Disk" : "Local Disk";
  return {
    path: `${deviceId}\\`,
    label: `${disk?.volumeName ?? fallbackName} (${deviceId})`,
    kind,
  };
}

export function darwinDriveIdentity(
  candidates: ReadonlyArray<{ readonly path: string; readonly device: number }>,
): string {
  return candidates.map((candidate) => `${candidate.path}\0${candidate.device}`).join("\n");
}

export function linuxDriveIdentity(
  mounts: ReadonlyArray<Pick<LinuxMountEntry, "mountPoint" | "source" | "fsType">>,
): string {
  return mounts.map((mount) => `${mount.mountPoint}\0${mount.source}\0${mount.fsType}`).join("\n");
}

export function windowsDriveIdentity(
  letters: ReadonlyArray<string>,
  disks: ReadonlyArray<WindowsLogicalDisk>,
): string {
  const diskByDeviceId = new Map(disks.map((disk) => [disk.deviceId, disk]));
  return letters
    .map((letter) => {
      const deviceId = `${letter.toUpperCase()}:`;
      const disk = diskByDeviceId.get(deviceId);
      return [
        deviceId,
        disk?.volumeSerialNumber ?? "",
        disk?.volumeName ?? "",
        String(disk?.driveType ?? ""),
      ].join("\0");
    })
    .join("\n");
}

export function sortDriveCandidates<T extends DriveCandidate>(candidates: ReadonlyArray<T>): T[] {
  return candidates.toSorted((left, right) => {
    if (left.kind === "system" && right.kind !== "system") return -1;
    if (right.kind === "system" && left.kind !== "system") return 1;
    return left.path.localeCompare(right.path);
  });
}

const DRIVE_ROOT_SKIP_NAMES = new Set(["lost+found", "$RECYCLE.BIN", "System Volume Information"]);

// root-owned mounts usually hand each user a folder at the top, so land there
// when the mount itself refuses writes: the user's own folder first, otherwise
// the single writable folder when there is only one to choose from
export function pickExtraDriveBrowsePath(input: {
  readonly mountPoint: string;
  readonly kind: FilesystemDriveKind;
  readonly mountWritable: boolean;
  readonly writableChildNames: ReadonlyArray<string>;
  readonly userName?: string | undefined;
}): { readonly path: string; readonly writable: boolean } {
  if (input.mountWritable) {
    return { path: input.mountPoint, writable: true };
  }
  if (input.kind === "system") {
    return { path: input.mountPoint, writable: false };
  }
  const userName = input.userName?.trim();
  const ownFolder =
    userName && userName.length > 0
      ? input.writableChildNames.find((name) => name.toLowerCase() === userName.toLowerCase())
      : undefined;
  const target =
    ownFolder ?? (input.writableChildNames.length === 1 ? input.writableChildNames[0] : undefined);
  if (target === undefined) {
    return { path: input.mountPoint, writable: false };
  }
  return { path: NodePath.join(input.mountPoint, target), writable: true };
}

export function hostUserName(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.USER ?? env.LOGNAME ?? env.USERNAME;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

class DriveProbeError extends Schema.TaggedError<DriveProbeError>()("DriveProbeError", {
  cause: Schema.Defect(),
}) {}

const promiseOrNull = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DriveProbeError({ cause }) }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => null),
  );

const readDriveSpace = Effect.fn("DriveDiscovery.readDriveSpace")(function* (path: string) {
  const stats = yield* promiseOrNull(() => NodeFSP.statfs(path));
  if (!stats) return { totalBytes: null, freeBytes: null };
  return {
    totalBytes: stats.bsize * stats.blocks,
    freeBytes: stats.bsize * stats.bavail,
  };
});

const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const runner = yield* ProcessRunner.ProcessRunner;

  const latest = yield* SubscriptionRef.make<FilesystemDriveList | null>(null);
  const lastIdentity = yield* Ref.make<string | null>(null);
  const retainCount = yield* Ref.make(0);

  const runCommand = Effect.fn("DriveDiscovery.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const output = yield* runner
      .run({ command, args, timeout: "10 seconds", maxOutputBytes: 1024 * 1024 })
      .pipe(Effect.orElseSucceed(() => null));
    return output && output.code === 0 ? output.stdout : null;
  });

  const scanDarwin = Effect.fn("DriveDiscovery.scanDarwin")(function* () {
    const names = (yield* promiseOrNull(() => NodeFSP.readdir("/Volumes"))) ?? [];
    const candidates: Array<
      DriveCandidate & { readonly realPath: string; readonly device: number }
    > = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const volumePath = `/Volumes/${name}`;
      const realPath = yield* promiseOrNull(() => NodeFSP.realpath(volumePath));
      if (realPath === null) continue;
      const stat = yield* promiseOrNull(() => NodeFSP.stat(realPath));
      if (!stat?.isDirectory()) continue;
      const isRoot = realPath === "/";
      candidates.push({
        path: isRoot ? "/" : volumePath,
        label: name,
        kind: isRoot ? "system" : "fixed",
        realPath,
        device: stat.dev,
      });
    }
    if (!candidates.some((candidate) => candidate.path === "/")) {
      const rootStat = yield* promiseOrNull(() => NodeFSP.stat("/"));
      candidates.unshift({
        path: "/",
        label: "Macintosh HD",
        kind: "system",
        realPath: "/",
        device: rootStat?.dev ?? 0,
      });
    }
    return sortDriveCandidates(candidates);
  });

  const enrichDarwin = Effect.fn("DriveDiscovery.enrichDarwin")(function* (
    candidates: ReadonlyArray<DriveCandidate & { readonly realPath: string }>,
  ) {
    const mountOutput = yield* runCommand("mount", []);
    const fsTypeByMountPoint = new Map(
      parseDarwinMountOutput(mountOutput ?? "").map((entry) => [entry.mountPoint, entry.fsType]),
    );
    return candidates.map((candidate): DriveCandidate => ({
      path: candidate.path,
      label: candidate.label,
      kind: darwinDriveKind(
        candidate.path,
        fsTypeByMountPoint.get(candidate.path) ?? fsTypeByMountPoint.get(candidate.realPath),
      ),
    }));
  });

  const scanLinux = Effect.fn("DriveDiscovery.scanLinux")(function* () {
    const text = yield* promiseOrNull(() => NodeFSP.readFile("/proc/self/mounts", "utf8"));
    if (text === null) {
      return [{ source: "", mountPoint: "/", fsType: "", kind: "system" as const }];
    }
    const selected = selectLinuxDriveMounts(parseLinuxMounts(text));
    return selected.toSorted((left, right) => {
      if (left.kind === "system" && right.kind !== "system") return -1;
      if (right.kind === "system" && left.kind !== "system") return 1;
      return left.mountPoint.localeCompare(right.mountPoint);
    });
  });

  const readLinuxLabels = Effect.fn("DriveDiscovery.readLinuxLabels")(function* () {
    const labelDirectory = "/dev/disk/by-label";
    const names = (yield* promiseOrNull(() => NodeFSP.readdir(labelDirectory))) ?? [];
    const labelByDevice = new Map<string, string>();
    for (const name of names) {
      const device = yield* promiseOrNull(() => NodeFSP.realpath(`${labelDirectory}/${name}`));
      if (device !== null) labelByDevice.set(device, decodeUdevEscapes(name));
    }
    return labelByDevice;
  });

  const isLinuxRemovable = Effect.fn("DriveDiscovery.isLinuxRemovable")(function* (source: string) {
    if (!source.startsWith("/dev/")) return false;
    const device = yield* promiseOrNull(() => NodeFSP.realpath(source));
    if (device === null) return false;
    const name = NodePath.posix.basename(device);
    for (const candidate of [
      `/sys/class/block/${name}/removable`,
      `/sys/class/block/${name}/../removable`,
    ]) {
      const flag = yield* promiseOrNull(() => NodeFSP.readFile(candidate, "utf8"));
      if (flag !== null) return flag.trim() === "1";
    }
    return false;
  });

  const enrichLinux = Effect.fn("DriveDiscovery.enrichLinux")(function* (
    mounts: ReadonlyArray<LinuxMountEntry & { readonly kind: FilesystemDriveKind }>,
  ) {
    const labelByDevice = yield* readLinuxLabels();
    const candidates: Array<DriveCandidate> = [];
    for (const mount of mounts) {
      const device =
        mount.source.startsWith("/dev/") && labelByDevice.size > 0
          ? yield* promiseOrNull(() => NodeFSP.realpath(mount.source))
          : null;
      const label =
        (device !== null ? labelByDevice.get(device) : undefined) ?? linuxDefaultLabel(mount);
      const kind: FilesystemDriveKind =
        mount.kind === "fixed" && (yield* isLinuxRemovable(mount.source))
          ? "removable"
          : mount.kind;
      candidates.push({ path: mount.mountPoint, label, kind });
    }
    return candidates;
  });

  const scanWindows = Effect.fn("DriveDiscovery.scanWindows")(function* () {
    const present = yield* Effect.forEach(
      WINDOWS_DRIVE_LETTERS,
      (letter) =>
        promiseOrNull(() => NodeFSP.stat(`${letter}:\\`)).pipe(
          Effect.map((stat) => (stat?.isDirectory() ? letter : null)),
        ),
      { concurrency: "unbounded" },
    );
    return present.filter((letter): letter is string => letter !== null);
  });

  const readWindowsLogicalDisks = Effect.fn("DriveDiscovery.readWindowsLogicalDisks")(function* () {
    return yield* runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,VolumeSerialNumber | ConvertTo-Json -Compress",
    ]);
  });

  const enrichWindows = Effect.fn("DriveDiscovery.enrichWindows")(function* (
    letters: ReadonlyArray<string>,
    json: string | null,
  ) {
    const diskByDeviceId = new Map(
      parseWindowsLogicalDisks(json ?? "").map((disk) => [disk.deviceId, disk]),
    );
    const systemDrive = env.SystemDrive ?? "C:";
    return sortDriveCandidates(
      letters.map((letter) =>
        windowsDriveCandidate(letter, diskByDeviceId.get(`${letter}:`), systemDrive),
      ),
    );
  });

  const isPathWritable = Effect.fn("DriveDiscovery.isPathWritable")(function* (path: string) {
    const result = yield* promiseOrNull(() => NodeFSP.access(path, FsConstants.W_OK));
    return result !== null;
  });

  const listWritableChildDirectoryNames = Effect.fn(
    "DriveDiscovery.listWritableChildDirectoryNames",
  )(function* (mountPoint: string) {
    const entries =
      (yield* promiseOrNull(() => NodeFSP.readdir(mountPoint, { withFileTypes: true }))) ?? [];
    const names: Array<string> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || DRIVE_ROOT_SKIP_NAMES.has(entry.name)) continue;
      const childPath = NodePath.join(mountPoint, entry.name);
      const stat = yield* promiseOrNull(() => NodeFSP.stat(childPath));
      if (!stat?.isDirectory()) continue;
      if (yield* isPathWritable(childPath)) names.push(entry.name);
    }
    return names;
  });

  const withSpace = Effect.fn("DriveDiscovery.withSpace")(function* (
    candidates: ReadonlyArray<DriveCandidate>,
  ) {
    return yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const space = yield* readDriveSpace(candidate.path);
          const mountWritable = yield* isPathWritable(candidate.path);
          const writableChildNames =
            mountWritable || candidate.kind === "system"
              ? []
              : yield* listWritableChildDirectoryNames(candidate.path);
          const browse = pickExtraDriveBrowsePath({
            mountPoint: candidate.path,
            kind: candidate.kind,
            mountWritable,
            writableChildNames,
            userName: hostUserName(env),
          });
          return {
            ...candidate,
            ...space,
            path: browse.path,
            writable: browse.writable,
          } satisfies FilesystemDrive;
        }),
      { concurrency: 8 },
    );
  });

  const scan = Effect.fn("DriveDiscovery.scan")(function* () {
    switch (platform) {
      case "darwin": {
        const candidates = yield* scanDarwin();
        return {
          identity: darwinDriveIdentity(candidates),
          enrich: enrichDarwin(candidates),
        };
      }
      case "linux": {
        const mounts = yield* scanLinux();
        return {
          identity: linuxDriveIdentity(mounts),
          enrich: enrichLinux(mounts),
        };
      }
      case "win32": {
        const letters = yield* scanWindows();
        const json = yield* readWindowsLogicalDisks();
        return {
          identity: windowsDriveIdentity(letters, parseWindowsLogicalDisks(json ?? "")),
          enrich: enrichWindows(letters, json),
        };
      }
      default: {
        const fallback: ReadonlyArray<DriveCandidate> = [
          { path: "/", label: "System", kind: "system" },
        ];
        return { identity: "/", enrich: Effect.succeed(fallback) };
      }
    }
  });

  const pollTick = Effect.fn("DriveDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(retainCount)) <= 0) return;
      const { identity, enrich } = yield* scan();
      const previousIdentity = yield* Ref.get(lastIdentity);
      if (identity === previousIdentity && (yield* SubscriptionRef.get(latest)) !== null) return;
      const drives = yield* withSpace(yield* enrich);
      const scannedAt = DateTime.formatIso(yield* DateTime.now);
      yield* Ref.set(lastIdentity, identity);
      yield* SubscriptionRef.set(latest, { drives, scannedAt });
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("drive discovery scan failed", Cause.pretty(cause)),
    ),
  );

  yield* Effect.forkScoped(pollTick().pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const retain = Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Ref.update(retainCount, (count) => count + 1);
      yield* pollTick();
    }),
    () => Ref.update(retainCount, (count) => Math.max(0, count - 1)),
  );

  const changes: DriveDiscovery["Service"]["changes"] = Stream.callback<FilesystemDriveList>(
    (queue) =>
      Effect.gen(function* () {
        yield* retain;
        yield* SubscriptionRef.changes(latest).pipe(
          Stream.filter((list): list is FilesystemDriveList => list !== null),
          Stream.runForEach((list) => Queue.offer(queue, list)),
          Effect.forkScoped,
        );
      }),
  );

  return DriveDiscovery.of({ changes });
}).pipe(Effect.withSpan("DriveDiscovery.make"));

export const layer = Layer.effect(DriveDiscovery, make);
