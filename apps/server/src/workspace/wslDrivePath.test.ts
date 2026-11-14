import { describe, expect, it } from "vite-plus/test";

import { isPathOnDrvfsMount } from "./wslDrivePath.ts";

const wsl2Mounts = [
  "/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0",
  "C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0",
  "D:\\134 /mnt/my\\040drive 9p rw,noatime,aname=drvfs;path=D:\\;uid=1000 0 0",
  "/dev/sdd /mnt/c/src/ext4 ext4 rw,relatime 0 0",
  "drvfs /mnt/wsl1 drvfs rw,noatime 0 0",
  "share /mnt/share 9p rw,trans=virtio 0 0",
].join("\n");

describe("isPathOnDrvfsMount", () => {
  it.each([
    ["/mnt/c", true],
    ["/mnt/c/src/t3code", true],
    ["/mnt/my drive/repo", true],
    ["/mnt/wsl1/repo", true],
    ["/home/me/t3code", false],
    ["/mnt/cc/repo", false],
    ["/mnt/c/src/ext4/repo", false],
    ["/mnt/share/repo", false],
  ])("%s -> %s", (path, expected) => {
    expect(isPathOnDrvfsMount(wsl2Mounts, path)).toBe(expected);
  });

  it("treats unreadable mounts as not a drive mount", () => {
    expect(isPathOnDrvfsMount("", "/mnt/c/src")).toBe(false);
  });
});
