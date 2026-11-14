import type { HostResourcesSnapshot, HostVolume } from "@t3tools/contracts";

export type MachineVolumeTone = "default" | "warning" | "danger";

const GiB = 1024 ** 3;

/**
 * Judged on space the server's user can still write, not percent used: ext4 reserves blocks for
 * root, and 5% of a large disk is still plenty. Small volumes scale the floors down.
 */
export function machineVolumeTone(
  volume: Pick<HostVolume, "availableBytes" | "totalBytes">,
): MachineVolumeTone {
  if (volume.totalBytes <= 0) return "default";
  if (volume.availableBytes < Math.min(5 * GiB, volume.totalBytes * 0.05)) return "danger";
  if (volume.availableBytes < Math.min(20 * GiB, volume.totalBytes * 0.15)) return "warning";
  return "default";
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
