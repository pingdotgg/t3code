import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { HostVolumeRole } from "./resourceTelemetry.ts";

export const DiskSpaceLevel = Schema.Literals(["ok", "low", "critical"]);
export type DiskSpaceLevel = typeof DiskSpaceLevel.Type;

const GiB = 1024 ** 3;

const LEVEL_SEVERITY: Record<DiskSpaceLevel, number> = { ok: 0, low: 1, critical: 2 };

export function diskSpaceLevelSeverity(level: DiskSpaceLevel): number {
  return LEVEL_SEVERITY[level];
}

/**
 * Judged on space the server's user can still write, not percent used: ext4 reserves blocks for
 * root, and 5% of a large disk is still plenty. Small volumes scale the floors down. `margin`
 * raises both floors, which is how a level is left only well clear of where it was entered.
 */
export function diskSpaceLevel(
  volume: { readonly availableBytes: number; readonly totalBytes: number },
  margin = 1,
): DiskSpaceLevel {
  if (volume.totalBytes <= 0) return "ok";
  if (volume.availableBytes < Math.min(5 * GiB, volume.totalBytes * 0.05) * margin) {
    return "critical";
  }
  if (volume.availableBytes < Math.min(20 * GiB, volume.totalBytes * 0.15) * margin) return "low";
  return "ok";
}

/** A level improves only once free space clears its floor by this factor, so it never flaps. */
const DISK_SPACE_RECOVERY_MARGIN = 1.1;

/** Worsening applies at once; improving waits until the reading clears the recovery margin. */
export function nextDiskSpaceLevel(
  previous: DiskSpaceLevel,
  volume: { readonly availableBytes: number; readonly totalBytes: number },
): DiskSpaceLevel {
  const raw = diskSpaceLevel(volume);
  if (LEVEL_SEVERITY[raw] >= LEVEL_SEVERITY[previous]) return raw;
  const relaxed = diskSpaceLevel(volume, DISK_SPACE_RECOVERY_MARGIN);
  return LEVEL_SEVERITY[relaxed] < LEVEL_SEVERITY[previous] ? relaxed : previous;
}

export const ServerDiskSpaceVolume = Schema.Struct({
  /** The T3 directory read on this volume, not its mount point. */
  path: Schema.String,
  roles: Schema.Array(HostVolumeRole),
  level: DiskSpaceLevel,
  availableBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type ServerDiskSpaceVolume = typeof ServerDiskSpaceVolume.Type;

/** `volumes` lists only the volumes below `ok`, so a healthy disk sends nothing that changes. */
export const ServerDiskSpace = Schema.Struct({
  level: DiskSpaceLevel,
  volumes: Schema.Array(ServerDiskSpaceVolume),
});
export type ServerDiskSpace = typeof ServerDiskSpace.Type;
