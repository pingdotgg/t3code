import { describe, expect, it } from "vite-plus/test";

import { installStaleAppImageMountScrub, stripStaleAppImageMounts } from "./appImageStaleMounts.ts";

const CURRENT = "/tmp/.mount_cur";

describe("stripStaleAppImageMounts", () => {
  it("drops earlier launches' mount segments and keeps the current APPDIR's", () => {
    const result = stripStaleAppImageMounts({
      APPIMAGE: "/home/me/T3-Code.AppImage",
      APPDIR: CURRENT,
      PATH: `${CURRENT}/usr/bin:/tmp/.mount_abc/usr/bin:/usr/local/bin:/tmp/.mount_def/usr/sbin:/usr/bin`,
      LD_LIBRARY_PATH: `/tmp/.mount_abc/usr/lib:${CURRENT}/usr/lib:/opt/lib`,
      XDG_DATA_DIRS: `/tmp/.mount_abc/usr/share:/usr/share:${CURRENT}/usr/share`,
      HOME: "/home/me",
    });

    expect(result.PATH).toBe(`${CURRENT}/usr/bin:/usr/local/bin:/usr/bin`);
    expect(result.LD_LIBRARY_PATH).toBe(`${CURRENT}/usr/lib:/opt/lib`);
    expect(result.XDG_DATA_DIRS).toBe(`/usr/share:${CURRENT}/usr/share`);
    expect(result.HOME).toBe("/home/me");
  });

  it("treats a trailing slash on APPDIR and the bare mount root as the current mount", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: `${CURRENT}/`,
      PATH: `${CURRENT}:/tmp/.mount_abc:/tmp/.mount_cur2/usr/bin:/usr/bin`,
    });

    expect(result.PATH).toBe(`${CURRENT}:/usr/bin`);
  });

  it("removes every mount segment when APPDIR is missing", () => {
    const result = stripStaleAppImageMounts({
      APPIMAGE: "/home/me/T3-Code.AppImage",
      PATH: "/tmp/.mount_abc/usr/bin:/usr/bin",
      LD_LIBRARY_PATH: "/tmp/.mount_abc/usr/lib",
    });

    expect(result.PATH).toBe("/usr/bin");
    expect(result).not.toHaveProperty("LD_LIBRARY_PATH");
  });

  it("classifies segments by their normalized path but keeps them verbatim", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: CURRENT,
      PATH: `${CURRENT}/../.mount_old/usr/bin:${CURRENT}/usr/bin:${CURRENT}/usr/../bin`,
    });

    expect(result.PATH).toBe(`${CURRENT}/usr/bin:${CURRENT}/usr/../bin`);
  });

  it("matches mounts under a non-default TMPDIR", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: "/var/tmp/.mount_cur",
      PATH: "/var/tmp/.mount_old/usr/bin:/var/tmp/.mount_cur/usr/bin:/usr/bin",
    });

    expect(result.PATH).toBe("/var/tmp/.mount_cur/usr/bin:/usr/bin");
  });

  it("preserves empty segments, order and absent variables", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: CURRENT,
      PATH: "/usr/bin::/tmp/.mount_abc/usr/bin:/bin:",
      XDG_DATA_DIRS: "",
    });

    expect(result.PATH).toBe("/usr/bin::/bin:");
    expect(result.XDG_DATA_DIRS).toBe("");
    expect(result).not.toHaveProperty("LD_LIBRARY_PATH");
  });

  it("keeps a variable whose only survivors are empty segments", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: CURRENT,
      PATH: ":/tmp/.mount_old/usr/bin",
      XDG_DATA_DIRS: "/tmp/.mount_old/usr/share:/tmp/.mount_older/usr/share",
    });

    expect(result.PATH).toBe(":");
    expect(result).not.toHaveProperty("XDG_DATA_DIRS");
  });

  it("splits LD_LIBRARY_PATH on semicolons too, but not PATH", () => {
    const result = stripStaleAppImageMounts({
      APPDIR: CURRENT,
      LD_LIBRARY_PATH: "/usr/lib;/tmp/.mount_old/usr/lib:/opt/lib;/tmp/.mount_older/usr/lib",
      PATH: "/usr/bin;/opt/bin:/usr/local/bin",
    });

    expect(result.LD_LIBRARY_PATH).toBe("/usr/lib:/opt/lib");
    expect(result.PATH).toBe("/usr/bin;/opt/bin:/usr/local/bin");
  });

  it("leaves a non-AppImage env untouched", () => {
    const env = {
      PATH: "/tmp/.mount_abc/usr/bin:/usr/bin",
      LD_LIBRARY_PATH: "/tmp/.mount_abc/usr/lib",
    };

    expect(stripStaleAppImageMounts(env)).toBe(env);
    expect(env.PATH).toBe("/tmp/.mount_abc/usr/bin:/usr/bin");
  });
});

describe("installStaleAppImageMountScrub", () => {
  it("rewrites the env in place and deletes variables left with only stale mounts", () => {
    const env: NodeJS.ProcessEnv = {
      APPDIR: CURRENT,
      PATH: `/tmp/.mount_abc/usr/bin:${CURRENT}/usr/bin:/usr/bin`,
      LD_LIBRARY_PATH: "/tmp/.mount_abc/usr/lib",
      XDG_DATA_DIRS: "/usr/share",
    };

    installStaleAppImageMountScrub(env);

    expect(env).toEqual({
      APPDIR: CURRENT,
      PATH: `${CURRENT}/usr/bin:/usr/bin`,
      XDG_DATA_DIRS: "/usr/share",
    });
  });
});
