import { it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as DriveDiscovery from "./DriveDiscovery.ts";

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: () =>
    Effect.succeed({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

const TestDriveDiscoveryLive = DriveDiscovery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      Layer.succeed(HostProcessPlatform, "linux"),
      Layer.succeed(HostProcessEnvironment, {}),
    ),
  ),
);

describe("parseLinuxMounts", () => {
  it("decodes octal escapes in mount points", () => {
    const mounts = DriveDiscovery.parseLinuxMounts(
      [
        "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
        "/dev/sdb1 /media/user/My\\040Drive exfat rw 0 0",
        "malformed",
      ].join("\n"),
    );
    expect(mounts).toEqual([
      { source: "/dev/nvme0n1p2", mountPoint: "/", fsType: "ext4" },
      { source: "/dev/sdb1", mountPoint: "/media/user/My Drive", fsType: "exfat" },
    ]);
  });
});

describe("selectLinuxDriveMounts", () => {
  it("keeps block devices, network shares and WSL drives, drops pseudo and system mounts", () => {
    const selected = DriveDiscovery.selectLinuxDriveMounts(
      DriveDiscovery.parseLinuxMounts(
        [
          "sysfs /sys sysfs rw 0 0",
          "proc /proc proc rw 0 0",
          "udev /dev devtmpfs rw 0 0",
          "tmpfs /run tmpfs rw 0 0",
          "/dev/nvme0n1p2 / ext4 rw 0 0",
          "/dev/nvme0n1p1 /boot/efi vfat rw 0 0",
          "/dev/loop3 /snap/core/1234 squashfs ro 0 0",
          "/dev/sdb1 /media/user/USB exfat rw 0 0",
          "/dev/sda1 /mnt/data ext4 rw 0 0",
          "nas:/volume1/media /mnt/nas nfs4 rw 0 0",
          "C:\\134 /mnt/c 9p rw 0 0",
          "overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0",
          "/dev/sdc1 /var/lib/docker ext4 rw 0 0",
        ].join("\n"),
      ),
    );
    expect(selected.map((mount) => [mount.mountPoint, mount.kind])).toEqual([
      ["/", "system"],
      ["/media/user/USB", "fixed"],
      ["/mnt/data", "fixed"],
      ["/mnt/nas", "network"],
      ["/mnt/c", "fixed"],
    ]);
  });

  it("keeps overlay root as the system drive in containers", () => {
    const selected = DriveDiscovery.selectLinuxDriveMounts(
      DriveDiscovery.parseLinuxMounts(
        [
          "overlay / overlay rw 0 0",
          "tmpfs /run tmpfs rw 0 0",
          "/dev/sdb1 /media/usb exfat rw 0 0",
        ].join("\n"),
      ),
    );
    expect(selected.map((mount) => [mount.mountPoint, mount.kind])).toEqual([
      ["/", "system"],
      ["/media/usb", "fixed"],
    ]);
  });

  it("hides separate system partitions such as home, var and usr", () => {
    const selected = DriveDiscovery.selectLinuxDriveMounts(
      DriveDiscovery.parseLinuxMounts(
        [
          "/dev/nvme0n1p2 / ext4 rw 0 0",
          "/dev/nvme0n1p3 /home ext4 rw 0 0",
          "/dev/nvme0n1p4 /var ext4 rw 0 0",
          "/dev/nvme0n1p5 /usr ext4 rw 0 0",
          "/dev/nvme0n1p6 /tmp ext4 rw 0 0",
          "/dev/nvme0n1p1 /efi vfat rw 0 0",
          "/dev/sda1 /mnt/data ext4 rw 0 0",
          "/dev/sdb1 /srv/projects ext4 rw 0 0",
        ].join("\n"),
      ),
    );
    expect(selected.map((mount) => mount.mountPoint)).toEqual(["/", "/mnt/data", "/srv/projects"]);
  });

  it("shows a block device once even when it is bind-mounted in several places", () => {
    const selected = DriveDiscovery.selectLinuxDriveMounts(
      DriveDiscovery.parseLinuxMounts(
        [
          "/dev/mapper/vg-root / ext4 rw 0 0",
          "/dev/mapper/vg-root /home ext4 rw 0 0",
          "/dev/sda1 /mnt/data ext4 rw 0 0",
          "/dev/sda1 /mnt/mirror ext4 rw 0 0",
          "/dev/sda1 /mnt/archive ext4 rw 0 0",
        ].join("\n"),
      ),
    );
    expect(selected.map((mount) => mount.mountPoint)).toEqual(["/", "/mnt/data"]);
  });

  it("dedupes repeated mount points, keeping the last one", () => {
    const selected = DriveDiscovery.selectLinuxDriveMounts([
      { source: "/dev/sda1", mountPoint: "/mnt/x", fsType: "ext4" },
      { source: "/dev/sdb1", mountPoint: "/mnt/x", fsType: "xfs" },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.source).toBe("/dev/sdb1");
  });
});

describe("linuxDefaultLabel", () => {
  it("labels root, WSL drives and plain mount points", () => {
    expect(
      DriveDiscovery.linuxDefaultLabel({ source: "/dev/sda1", mountPoint: "/", fsType: "ext4" }),
    ).toBe("System");
    expect(
      DriveDiscovery.linuxDefaultLabel({ source: "C:\\", mountPoint: "/mnt/c", fsType: "9p" }),
    ).toBe("C:");
    expect(
      DriveDiscovery.linuxDefaultLabel({
        source: "/dev/sdb1",
        mountPoint: "/media/user/Backup",
        fsType: "ext4",
      }),
    ).toBe("Backup");
  });
});

describe("parseDarwinMountOutput", () => {
  it("extracts mount points and fs types, including names with spaces", () => {
    const entries = DriveDiscovery.parseDarwinMountOutput(
      [
        "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
        "devfs on /dev (devfs, local, nobrowse)",
        "/dev/disk4s2 on /Volumes/Time Machine (apfs, local, nodev, nosuid, journaled)",
        "//user@nas._smb._tcp.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)",
      ].join("\n"),
    );
    expect(entries).toEqual([
      { mountPoint: "/", fsType: "apfs" },
      { mountPoint: "/dev", fsType: "devfs" },
      { mountPoint: "/Volumes/Time Machine", fsType: "apfs" },
      { mountPoint: "/Volumes/share", fsType: "smbfs" },
    ]);
    expect(DriveDiscovery.darwinDriveKind("/", "apfs")).toBe("system");
    expect(DriveDiscovery.darwinDriveKind("/Volumes/share", "smbfs")).toBe("network");
    expect(DriveDiscovery.darwinDriveKind("/Volumes/Time Machine", "apfs")).toBe("fixed");
    expect(DriveDiscovery.darwinDriveKind("/Volumes/Unknown", undefined)).toBe("fixed");
  });
});

describe("windows drives", () => {
  it("parses single-object and array PowerShell output", () => {
    expect(
      DriveDiscovery.parseWindowsLogicalDisks(
        '{"DeviceID":"C:","VolumeName":"Windows","DriveType":3}',
      ),
    ).toEqual([{ deviceId: "C:", volumeName: "Windows", driveType: 3, volumeSerialNumber: null }]);
    expect(
      DriveDiscovery.parseWindowsLogicalDisks(
        '[{"DeviceID":"c:","VolumeName":"","DriveType":3},{"DeviceID":"E:","VolumeName":"USB","DriveType":2,"VolumeSerialNumber":"ABCD1234"},{"DeviceID":"bogus"}]',
      ),
    ).toEqual([
      { deviceId: "C:", volumeName: null, driveType: 3, volumeSerialNumber: null },
      { deviceId: "E:", volumeName: "USB", driveType: 2, volumeSerialNumber: "ABCD1234" },
    ]);
    expect(DriveDiscovery.parseWindowsLogicalDisks("not json")).toEqual([]);
  });

  it("builds explorer-style labels and kinds", () => {
    expect(
      DriveDiscovery.windowsDriveCandidate(
        "c",
        { deviceId: "C:", volumeName: null, driveType: 3, volumeSerialNumber: null },
        "C:",
      ),
    ).toEqual({ path: "C:\\", label: "Local Disk (C:)", kind: "system" });
    expect(
      DriveDiscovery.windowsDriveCandidate(
        "E",
        { deviceId: "E:", volumeName: "USB", driveType: 2, volumeSerialNumber: null },
        "C:",
      ),
    ).toEqual({ path: "E:\\", label: "USB (E:)", kind: "removable" });
    expect(
      DriveDiscovery.windowsDriveCandidate(
        "Z",
        { deviceId: "Z:", volumeName: null, driveType: 4, volumeSerialNumber: null },
        "C:",
      ),
    ).toEqual({ path: "Z:\\", label: "Network Drive (Z:)", kind: "network" });
    expect(DriveDiscovery.windowsDriveCandidate("D", undefined, "C:")).toEqual({
      path: "D:\\",
      label: "Local Disk (D:)",
      kind: "fixed",
    });
  });
});

describe("drive identity", () => {
  it("changes when a Darwin volume is remounted at the same path", () => {
    const first = DriveDiscovery.darwinDriveIdentity([
      { path: "/Volumes/Backup", device: 16777229 },
    ]);
    const second = DriveDiscovery.darwinDriveIdentity([
      { path: "/Volumes/Backup", device: 16777234 },
    ]);
    expect(first).not.toBe(second);
  });

  it("changes when a Linux mount keeps its path but swaps source or fs type", () => {
    const first = DriveDiscovery.linuxDriveIdentity([
      { mountPoint: "/mnt/data", source: "/dev/sdb1", fsType: "ext4" },
    ]);
    const swappedSource = DriveDiscovery.linuxDriveIdentity([
      { mountPoint: "/mnt/data", source: "/dev/sdc1", fsType: "ext4" },
    ]);
    const swappedFs = DriveDiscovery.linuxDriveIdentity([
      { mountPoint: "/mnt/data", source: "/dev/sdb1", fsType: "xfs" },
    ]);
    expect(first).not.toBe(swappedSource);
    expect(first).not.toBe(swappedFs);
  });

  it("changes identity when a Windows volume is remapped to the same letter", () => {
    const first = DriveDiscovery.windowsDriveIdentity(
      ["E"],
      [{ deviceId: "E:", volumeName: "USB", driveType: 2, volumeSerialNumber: "1111" }],
    );
    const second = DriveDiscovery.windowsDriveIdentity(
      ["E"],
      [{ deviceId: "E:", volumeName: "Backup", driveType: 2, volumeSerialNumber: "2222" }],
    );
    expect(first).not.toBe(second);
  });
});

describe("sortDriveCandidates", () => {
  it("puts the system drive first and sorts the rest by path", () => {
    const sorted = DriveDiscovery.sortDriveCandidates([
      { path: "/mnt/b", label: "b", kind: "fixed" },
      { path: "/", label: "System", kind: "system" },
      { path: "/mnt/a", label: "a", kind: "removable" },
    ]);
    expect(sorted.map((drive) => drive.path)).toEqual(["/", "/mnt/a", "/mnt/b"]);
  });
});

describe("pickExtraDriveBrowsePath", () => {
  it("keeps a writable mount, otherwise opens the user's folder or the only writable child", () => {
    expect(
      DriveDiscovery.pickExtraDriveBrowsePath({
        mountPoint: "/mnt/data",
        kind: "fixed",
        mountWritable: true,
        writableChildNames: ["work"],
      }),
    ).toEqual({ path: "/mnt/data", writable: true });
    expect(
      DriveDiscovery.pickExtraDriveBrowsePath({
        mountPoint: "/mnt/data",
        kind: "fixed",
        mountWritable: false,
        writableChildNames: ["work"],
      }),
    ).toEqual({ path: "/mnt/data/work", writable: true });
    expect(
      DriveDiscovery.pickExtraDriveBrowsePath({
        mountPoint: "/mnt/data",
        kind: "fixed",
        mountWritable: false,
        writableChildNames: ["shared", "Alice", "work"],
        userName: "alice",
      }),
    ).toEqual({ path: "/mnt/data/Alice", writable: true });
    expect(
      DriveDiscovery.pickExtraDriveBrowsePath({
        mountPoint: "/mnt/data",
        kind: "fixed",
        mountWritable: false,
        writableChildNames: ["work", "shared"],
        userName: "alice",
      }),
    ).toEqual({ path: "/mnt/data", writable: false });
    expect(DriveDiscovery.hostUserName({ LOGNAME: "alice" })).toBe("alice");
    expect(DriveDiscovery.hostUserName({ USER: " " })).toBeUndefined();
    expect(
      DriveDiscovery.pickExtraDriveBrowsePath({
        mountPoint: "/",
        kind: "system",
        mountWritable: false,
        writableChildNames: ["home"],
      }),
    ).toEqual({ path: "/", writable: false });
  });
});

effectIt.layer(TestDriveDiscoveryLive)("DriveDiscovery.changes", (it) => {
  it.effect(
    "emits the current drive list to a new subscriber, system drive first",
    Effect.fn("DriveDiscoveryTest.emitsInitialList")(function* () {
      const discovery = yield* DriveDiscovery.DriveDiscovery;
      const first = yield* discovery.changes.pipe(Stream.take(1), Stream.runCollect);
      const list = first[0];
      expect(list).toBeDefined();
      expect(list!.drives.length).toBeGreaterThan(0);
      expect(list!.drives[0]?.path).toBe("/");
      expect(list!.drives[0]?.kind).toBe("system");
    }),
  );
});
