import {
  diskSpaceLevel,
  type DiskSpaceLevel,
  type HostGpu,
  type HostResourcesSnapshot,
  type HostVolume,
  type ServerDiskSpace,
} from "@t3tools/contracts";

export type MachineVolumeTone = "default" | "warning" | "danger";

const TONE_BY_LEVEL: Record<DiskSpaceLevel, MachineVolumeTone> = {
  ok: "default",
  low: "warning",
  critical: "danger",
};

export function machineVolumeTone(
  volume: Pick<HostVolume, "availableBytes" | "totalBytes">,
): MachineVolumeTone {
  return TONE_BY_LEVEL[diskSpaceLevel(volume)];
}

/** Share of the volume no longer available to the user, including root-reserved blocks. */
export function machineVolumeUsedShare(volume: Pick<HostVolume, "availableBytes" | "totalBytes">) {
  if (volume.totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - volume.availableBytes / volume.totalBytes));
}

export function machineMemoryUsedShare(
  snapshot: Pick<HostResourcesSnapshot, "availableMemoryBytes" | "totalMemoryBytes">,
) {
  if (snapshot.totalMemoryBytes <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - snapshot.availableMemoryBytes / snapshot.totalMemoryBytes));
}

export function machineVolumeLabel(volume: Pick<HostVolume, "mountPoint" | "name">) {
  return volume.name.trim() || volume.mountPoint;
}

const GB = 1024 ** 3;

/** Whole gigabytes once there are ten or more, so the label does not change every sample. */
function formatMachineGigabytes(bytes: number): string {
  const gigabytes = bytes / GB;
  return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
}

export interface MachineDiskSpaceWarning {
  readonly tone: "warning" | "danger";
  readonly text: string;
}

const ROLE_VOLUME_LABEL = { t3Home: "the T3 data volume", worktrees: "the worktrees volume" };

/** One line per low volume, worst first. */
export function machineDiskSpaceWarnings(
  environmentLabel: string,
  diskSpace: ServerDiskSpace | undefined,
): ReadonlyArray<MachineDiskSpaceWarning> {
  if (diskSpace === undefined || diskSpace.level === "ok") return [];
  return [...diskSpace.volumes]
    .sort((left, right) => (left.level === right.level ? 0 : left.level === "critical" ? -1 : 1))
    .map((volume) => ({
      tone: volume.level === "critical" ? ("danger" as const) : ("warning" as const),
      text: `${environmentLabel}: ${formatMachineGigabytes(volume.availableBytes)} free on ${
        volume.roles.includes("t3Home") ? ROLE_VOLUME_LABEL.t3Home : ROLE_VOLUME_LABEL.worktrees
      }`,
    }));
}

export interface MachineSummaryPart {
  readonly text: string;
  readonly tone: MachineVolumeTone;
}

/**
 * CPU, memory, and free space on the T3 volume for a one-line overview. Fields the server did not
 * report are left out rather than shown as zero; null means there is nothing to show.
 */
export function machineSummaryParts(
  snapshot: Pick<
    HostResourcesSnapshot,
    "cpuUtilization" | "availableMemoryBytes" | "totalMemoryBytes" | "storage"
  >,
): ReadonlyArray<MachineSummaryPart> | null {
  const parts: Array<MachineSummaryPart> = [];
  if (snapshot.cpuUtilization !== null) {
    parts.push({ text: `CPU ${Math.round(snapshot.cpuUtilization * 100)}%`, tone: "default" });
  }
  if (snapshot.totalMemoryBytes > 0) {
    const used = snapshot.totalMemoryBytes - snapshot.availableMemoryBytes;
    parts.push({
      text: `RAM ${formatMachineGigabytes(Math.max(0, used))} / ${formatMachineGigabytes(snapshot.totalMemoryBytes)}`,
      tone: "default",
    });
  }
  const t3Volume = snapshot.storage?.volumes.find((volume) => volume.roles.includes("t3Home"));
  if (t3Volume !== undefined && t3Volume.totalBytes > 0) {
    parts.push({
      text: `${formatMachineGigabytes(t3Volume.availableBytes)} free`,
      tone: machineVolumeTone(t3Volume),
    });
  }
  return parts.length === 0 ? null : parts;
}

export function machineCpuDetail(
  snapshot: Pick<HostResourcesSnapshot, "cpuCount" | "cpuModel" | "loadAverage">,
): string {
  const load = snapshot.loadAverage;
  return [
    snapshot.cpuModel,
    `${snapshot.cpuCount} ${snapshot.cpuCount === 1 ? "core" : "cores"}`,
    load
      ? `load ${[load.one, load.five, load.fifteen].map((value) => value.toFixed(2)).join(" ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Old servers send no `storage`; that reads as unsupported, never as an empty machine. */
export function machineStorageState(snapshot: Pick<HostResourcesSnapshot, "storage">) {
  const storage = snapshot.storage;
  if (storage === undefined) return { kind: "unsupported" } as const;
  return {
    kind: storage.volumes.length === 0 ? ("empty" as const) : ("volumes" as const),
    volumes: storage.volumes,
    notice: storage.unavailableReason ?? null,
  };
}

/** Old servers send no `gpu`; that reads as unsupported, never as a machine without a GPU. */
export function machineGpuState(snapshot: Pick<HostResourcesSnapshot, "gpu">) {
  const gpu = snapshot.gpu;
  if (gpu === undefined) return { kind: "unsupported" } as const;
  return {
    kind: gpu.gpus.length === 0 ? ("empty" as const) : ("gpus" as const),
    gpus: gpu.gpus,
    notice: gpu.unavailableReason ?? null,
  };
}

/** Without a VRAM total the GPU shares system memory; its used figure is what the driver holds. */
export function machineGpuMemory(gpu: HostGpu) {
  if (gpu.memoryTotalBytes !== undefined) {
    return {
      kind: "dedicated" as const,
      totalBytes: gpu.memoryTotalBytes,
      usedBytes: gpu.memoryUsedBytes,
      share:
        gpu.memoryUsedBytes === undefined || gpu.memoryTotalBytes <= 0
          ? undefined
          : Math.min(1, gpu.memoryUsedBytes / gpu.memoryTotalBytes),
    };
  }
  if (gpu.memoryUsedBytes !== undefined) {
    return { kind: "unified" as const, usedBytes: gpu.memoryUsedBytes };
  }
  return { kind: "unreported" as const };
}
