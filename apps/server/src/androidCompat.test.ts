import { describe, expect, it } from "vite-plus/test";

import { patchAndroidHardlinkFallback } from "./androidCompat.ts";

type PatchableFs = NonNullable<Parameters<typeof patchAndroidHardlinkFallback>[1]>;

const COPYFILE_EXCL = 1;

const errnoError = (code: string) =>
  Object.assign(new Error(`link ${code}`), { code, syscall: "link" });

function createFakeFs(getLinkError: () => NodeJS.ErrnoException | null) {
  const copyCalls: Array<{
    readonly method: "copyFile" | "copyFileSync" | "promises.copyFile";
    readonly src: string;
    readonly dest: string;
    readonly mode: number | undefined;
  }> = [];
  let linkCalls = 0;

  const fs: PatchableFs = {
    constants: { COPYFILE_EXCL },
    link(_src, _dest, callback) {
      linkCalls += 1;
      callback(getLinkError());
    },
    linkSync() {
      linkCalls += 1;
      const err = getLinkError();
      if (err) throw err;
    },
    copyFile(src, dest, mode, callback) {
      copyCalls.push({ method: "copyFile", src: String(src), dest: String(dest), mode });
      callback(null);
    },
    copyFileSync(src, dest, mode) {
      copyCalls.push({ method: "copyFileSync", src: String(src), dest: String(dest), mode });
    },
    promises: {
      async link() {
        linkCalls += 1;
        const err = getLinkError();
        if (err) throw err;
      },
      async copyFile(src, dest, mode) {
        copyCalls.push({
          method: "promises.copyFile",
          src: String(src),
          dest: String(dest),
          mode,
        });
      },
    },
  };

  return { fs, copyCalls, getLinkCalls: () => linkCalls };
}

describe("patchAndroidHardlinkFallback", () => {
  it("does nothing on non-android platforms", () => {
    const { fs } = createFakeFs(() => errnoError("EACCES"));
    const originalLink = fs.link;
    const originalLinkSync = fs.linkSync;
    const originalPromisesLink = fs.promises.link;

    patchAndroidHardlinkFallback("linux", fs);
    patchAndroidHardlinkFallback("darwin", fs);

    expect(fs.link).toBe(originalLink);
    expect(fs.linkSync).toBe(originalLinkSync);
    expect(fs.promises.link).toBe(originalPromisesLink);
  });

  it("falls back to exclusive copyFile on EACCES and EPERM", async () => {
    let error: NodeJS.ErrnoException | null = errnoError("EACCES");
    const { fs, copyCalls } = createFakeFs(() => error);

    patchAndroidHardlinkFallback("android", fs);

    await new Promise<void>((resolve, reject) => {
      fs.link("a", "b", (err) => (err ? reject(err) : resolve()));
    });
    fs.linkSync("c", "d");
    await fs.promises.link("e", "f");

    error = errnoError("EPERM");
    await new Promise<void>((resolve, reject) => {
      fs.link("g", "h", (err) => (err ? reject(err) : resolve()));
    });
    fs.linkSync("i", "j");
    await fs.promises.link("k", "l");

    expect(copyCalls).toEqual([
      { method: "copyFile", src: "a", dest: "b", mode: COPYFILE_EXCL },
      { method: "copyFileSync", src: "c", dest: "d", mode: COPYFILE_EXCL },
      { method: "promises.copyFile", src: "e", dest: "f", mode: COPYFILE_EXCL },
      { method: "copyFile", src: "g", dest: "h", mode: COPYFILE_EXCL },
      { method: "copyFileSync", src: "i", dest: "j", mode: COPYFILE_EXCL },
      { method: "promises.copyFile", src: "k", dest: "l", mode: COPYFILE_EXCL },
    ]);
  });

  it("propagates non-SELinux errors without falling back to copyFile", async () => {
    const error = errnoError("EEXIST");
    const { fs, copyCalls } = createFakeFs(() => error);

    patchAndroidHardlinkFallback("android", fs);

    const callbackErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      fs.link("a", "b", resolve);
    });
    expect(callbackErr).toBe(error);
    expect(() => fs.linkSync("a", "b")).toThrow(error);
    await expect(fs.promises.link("a", "b")).rejects.toBe(error);
    expect(copyCalls).toEqual([]);
  });

  it("is idempotent when called multiple times", () => {
    const { fs, getLinkCalls } = createFakeFs(() => null);

    patchAndroidHardlinkFallback("android", fs);
    const patchedLinkSync = fs.linkSync;
    patchAndroidHardlinkFallback("android", fs);

    expect(fs.linkSync).toBe(patchedLinkSync);
    fs.linkSync("a", "b");
    expect(getLinkCalls()).toBe(1);
  });
});
