import { describe, expect, it } from "@effect/vitest";

import {
  applyDiskSpaceReadings,
  EMPTY_DISK_SPACE,
  sameDiskSpaceLevels,
  type DiskSpaceReading,
} from "./DiskSpace.ts";

const GiB = 1024 ** 3;
const reading = (
  roles: DiskSpaceReading["roles"],
  availableGiB: number,
  totalGiB = 1_000,
): DiskSpaceReading => ({
  path: `/${roles.join("-")}`,
  roles,
  availableBytes: availableGiB * GiB,
  totalBytes: totalGiB * GiB,
});

describe("applyDiskSpaceReadings", () => {
  it("reports the worst volume, holds each level through small recoveries, and pushes only on level changes", () => {
    const first = applyDiskSpaceReadings(EMPTY_DISK_SPACE, [
      reading(["t3Home"], 4),
      reading(["worktrees"], 15),
    ]);
    expect(first.level).toBe("critical");
    expect(first.volumes.map((volume) => volume.level)).toEqual(["critical", "low"]);

    // Just above the 5 GiB floor: still critical, and the byte change alone is not news.
    const hovering = applyDiskSpaceReadings(first, [
      reading(["t3Home"], 5.2),
      reading(["worktrees"], 15),
    ]);
    expect(hovering.level).toBe("critical");
    expect(sameDiskSpaceLevels(first, hovering)).toBe(true);

    const recovered = applyDiskSpaceReadings(hovering, [
      reading(["t3Home"], 100),
      reading(["worktrees"], 15),
    ]);
    const partial = applyDiskSpaceReadings(first, [reading(["worktrees"], 100)]);
    expect(partial).toMatchObject({ level: "critical", volumes: [{ roles: ["t3Home"] }] });
    const moved = applyDiskSpaceReadings(first, [
      reading(["t3Home"], 100),
      { ...reading(["worktrees"], 21), path: "/new-worktrees" },
    ]);
    expect(moved.level).toBe("ok");
    const replaced = applyDiskSpaceReadings(first, [
      reading(["t3Home"], 4),
      { ...reading(["worktrees"], 15), path: "/new-worktrees" },
    ]);
    expect(sameDiskSpaceLevels(first, replaced)).toBe(false);
    expect(recovered).toMatchObject({ level: "low", volumes: [{ roles: ["worktrees"] }] });
    expect(sameDiskSpaceLevels(hovering, recovered)).toBe(false);
  });

  it("keeps the last state when no directory could be read", () => {
    const low = applyDiskSpaceReadings(EMPTY_DISK_SPACE, [reading(["t3Home", "worktrees"], 15)]);
    expect(applyDiskSpaceReadings(low, [])).toBe(low);
  });
});
