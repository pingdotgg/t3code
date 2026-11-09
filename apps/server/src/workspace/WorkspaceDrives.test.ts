// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { list, parseLinuxMountPaths } from "./WorkspaceDrives.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

it.effect("does not let an unresponsive drive block the drive selector", () =>
  Effect.gen(function* () {
    const cwd = yield* HostProcess.WorkingDirectory;
    const directoryStat = yield* Effect.promise(() => NodeFSP.stat(cwd));
    using _stat = vi.spyOn(NodeFSP, "stat").mockImplementation(async (drive) => {
      if (drive === "C:\\") return directoryStat;
      if (drive === "Z:\\") return new Promise<never>(() => {});
      throw Object.assign(new Error("Drive unavailable"), { code: "ENOENT" });
    });
    const listing = yield* list().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(listing)).toEqual([{ name: "C:", fullPath: "C:\\" }]);
  }),
);

describe("parseLinuxMountPaths", () => {
  it("decodes escaped names without interpreting decoded backslashes twice", () => {
    expect(
      parseLinuxMountPaths(
        [
          "1 0 8:1 / /mnt/My\\040Drive rw - exfat /dev/sdb1 rw",
          "2 0 8:2 / /mnt/back\\134040slash rw - ext4 /dev/sdc1 rw",
          "3 0 8:3 / /mnt/tab\\011name rw - ext4 /dev/sdd1 rw",
        ].join("\n"),
      ),
    ).toEqual(["/mnt/My Drive", "/mnt/back\\040slash", "/mnt/tab\tname"]);
  });

  it("deduplicates mount paths and skips malformed and virtual mounts", () => {
    expect(
      parseLinuxMountPaths(
        [
          "1 0 8:1 / /mnt/usb rw shared:1 master:2 - ext4 /dev/sdb1 rw",
          "2 0 8:1 / /mnt/usb rw - ext4 /dev/sdb1 rw",
          "3 0 0:2 / /sys rw - sysfs sysfs rw",
          "4 0 0:3 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
          "broken mount line",
        ].join("\n"),
      ),
    ).toEqual(["/mnt/usb"]);
  });

  it("includes network and FUSE mounts outside conventional mount directories", () => {
    expect(
      parseLinuxMountPaths(
        [
          "1 0 0:1 / /projects/team rw - cifs //server/team rw",
          "2 0 0:2 / /work/cloud rw - fuse.sshfs user@server:/work rw",
        ].join("\n"),
      ),
    ).toEqual(["/projects/team", "/work/cloud"]);
  });
});
