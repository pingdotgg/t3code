// @effect-diagnostics nodeBuiltinImport:off -- Real files exercise the CommonJS updater installation boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AppImageUpdater } from "electron-updater/out/AppImageUpdater.js";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The dependency uses CommonJS; spy on the same Node modules it loads.
const require = NodeModule.createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const childProcess = require("node:child_process") as typeof import("node:child_process");
const roots: string[] = [];
const oldBinary = "working AppImage";
const newBinary = "verified replacement AppImage";

class TestUpdater extends AppImageUpdater {
  override spawnLog = vi.fn(async () => true);

  async prepare(installer: string, sha512: string) {
    this.downloadedUpdateHelper = new DownloadedUpdateHelper(NodePath.dirname(installer));
    await this.downloadedUpdateHelper.setDownloadedFile(
      installer,
      null,
      { version: "1.1.0", files: [], path: "", sha512, releaseDate: "2026-09-08" },
      {
        url: new URL("https://example.com/update.AppImage"),
        info: { url: "update.AppImage", sha512 },
      },
      NodePath.basename(installer),
      false,
    );
  }
}

async function fixture(name = "t3code.AppImage") {
  const root = fs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-"));
  roots.push(root);
  const installed = NodePath.join(root, name);
  const cache = NodePath.join(root, "cache");
  fs.mkdirSync(cache);
  const installer = NodePath.join(cache, "T3-Code-1.1.0.AppImage");
  fs.writeFileSync(installed, oldBinary, { mode: 0o755 });
  fs.writeFileSync(installer, newBinary, { mode: 0o755 });
  vi.stubEnv("APPIMAGE", installed);
  const updater = new TestUpdater(null, { version: "1.0.0" });
  updater.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const errors = vi.fn();
  updater.on("error", errors);
  await updater.prepare(
    installer,
    NodeCrypto.createHash("sha512").update(newBinary).digest("base64"),
  );
  return { root, installed, installer, updater, errors };
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setImmediate"] }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AppImage installation", () => {
  // eslint-disable-next-line t3code/no-global-process-runtime -- Directory fsync is a Linux installation boundary.
  it.skipIf(NodeOS.platform() !== "linux").each([false, true])(
    "syncs the renamed directory before cleanup and relaunch (sync failure: %s)",
    async (failSync) => {
      const { installed, installer, updater, errors, root } =
        await fixture("T3-Code-1.0.0.AppImage");
      const destination = NodePath.join(root, NodePath.basename(installer));
      const sync = fs.fsyncSync;
      let directoryFd: number | undefined;
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory()) {
          directoryFd = fd;
          expect(fs.fstatSync(fd).ino).toBe(fs.statSync(root).ino);
          expect(fs.readFileSync(destination, "utf8")).toBe(newBinary);
          expect(fs.readFileSync(installed, "utf8")).toBe(oldBinary);
          expect(fs.readFileSync(installer, "utf8")).toBe(newBinary);
          expect(updater.spawnLog).not.toHaveBeenCalled();
          expect(updater.logger?.info).not.toHaveBeenCalledWith(
            expect.stringContaining("Installed verified"),
          );
          if (failSync) throw new Error("directory sync failed");
        }
        sync(fd);
      });

      updater.quitAndInstall(true, true);

      const closedFd = directoryFd;
      expect(closedFd).toBeDefined();
      if (closedFd !== undefined) expect(() => fs.fstatSync(closedFd)).toThrow();
      expect(errors).toHaveBeenCalledTimes(failSync ? 1 : 0);
      expect(updater.spawnLog).toHaveBeenCalledTimes(failSync ? 0 : 1);
      expect(vi.getTimerCount()).toBe(failSync ? 0 : 1);
      expect(fs.existsSync(installed)).toBe(failSync);
      expect(fs.existsSync(installer)).toBe(failSync);
    },
  );

  it.each(["empty", "corrupt", "ENOSPC"])(
    "preserves the old executable after a %s copy",
    async (fault) => {
      const { installed, installer, updater, errors, root } = await fixture();
      const badCopy = (destination: import("node:fs").PathLike) => {
        fs.writeFileSync(destination, fault === "corrupt" ? "x".repeat(newBinary.length) : "");
        if (fault === "ENOSPC")
          throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      };
      vi.spyOn(fs, "copyFileSync").mockImplementation((_source, destination) =>
        badCopy(destination),
      );
      // Reproduce the reported successful-but-empty cross-filesystem mv on the unpatched updater.
      vi.spyOn(childProcess, "execFileSync").mockImplementation((command, args) => {
        if (command !== "mv" || !Array.isArray(args)) throw new Error("Unexpected process launch");
        badCopy(String(args[2]));
        fs.unlinkSync(installer);
        return Buffer.alloc(0);
      });

      updater.quitAndInstall(true, true);

      expect(fs.readFileSync(installed, "utf8")).toBe(oldBinary);
      expect(fs.readFileSync(installer, "utf8")).toBe(newBinary);
      expect(updater.spawnLog).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(errors).toHaveBeenCalledOnce();
      expect(fs.readdirSync(root).sort()).toEqual(["cache", "t3code.AppImage"]);
    },
  );

  it.each(["t3code.AppImage", "T3-Code-1.0.0.AppImage"])(
    "atomically installs and relaunches %s",
    async (name) => {
      const { installed, installer, updater } = await fixture(name);
      const destination =
        name === "t3code.AppImage"
          ? installed
          : NodePath.join(NodePath.dirname(installed), NodePath.basename(installer));
      const rename = fs.renameSync;
      const swapped = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        expect(fs.readFileSync(installed, "utf8")).toBe(oldBinary);
        expect(fs.readFileSync(source, "utf8")).toBe(newBinary);
        expect(fs.statSync(source).dev).toBe(fs.statSync(NodePath.dirname(String(target))).dev);
        rename(source, target);
      });
      const renamed = vi.fn();
      updater.on("appimage-filename-updated", renamed);

      expect(updater.install(true, true)).toBe(true);

      expect(swapped).toHaveBeenCalledOnce();
      expect(fs.readFileSync(destination, "utf8")).toBe(newBinary);
      // eslint-disable-next-line t3code/no-global-process-runtime -- Check permissions on the real fixture filesystem.
      if (NodeOS.platform() !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
      expect(updater.spawnLog).toHaveBeenCalledWith(
        destination,
        [],
        expect.objectContaining({ APPIMAGE_SILENT_INSTALL: "true" }),
      );
      expect(renamed.mock.calls).toEqual(destination === installed ? [] : [[destination]]);
    },
  );

  it("keeps the executable and download retryable when the atomic rename fails", async () => {
    const { installed, installer, updater, errors } = await fixture();
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    });

    updater.quitAndInstall(true, true);

    expect(fs.readFileSync(installed, "utf8")).toBe(oldBinary);
    expect(fs.readFileSync(installer, "utf8")).toBe(newBinary);
    expect(errors).toHaveBeenCalledOnce();
    expect(updater.spawnLog).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    rename.mockRestore();
    expect(updater.install(true, true)).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toBe(newBinary);
  });
});
