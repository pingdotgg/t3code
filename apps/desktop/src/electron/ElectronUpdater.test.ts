// @effect-diagnostics nodeBuiltinImport:off - Native synchronous fixtures exercise updater event and relaunch ordering.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import type { AppImageUpdater as AppImageUpdaterType } from "electron-updater";

const { getUpdater } = vi.hoisted(() => ({ getUpdater: vi.fn<() => AppImageUpdaterType>() }));
vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return getUpdater();
  },
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

const require = NodeModule.createRequire(import.meta.url);
const { AppImageUpdater } = require("electron-updater") as typeof import("electron-updater");

// Exercise the real synchronous installer without Electron's deferred app.quit lifecycle.
class FixtureUpdater extends AppImageUpdater {
  readonly download: string;

  constructor(download: string) {
    super(null, { version: "0.1.7" });
    this.download = download;
    this.logger = null;
  }

  protected override get installerPath() {
    return this.download;
  }

  override quitAndInstall(isSilent = false, isForceRunAfter = false) {
    this.doInstall({ isSilent, isForceRunAfter, isAdminRightsRequired: false });
  }

  protected override spawnLog(destination: string) {
    assert.equal(
      NodeChildProcess.execFileSync(process.env.APPIMAGE!, { encoding: "utf8" }),
      "updated\n",
    );
    assert.equal(NodeChildProcess.execFileSync(destination, { encoding: "utf8" }), "updated\n");
    return Promise.resolve(true);
  }
}

function fixture(oldName: string, newName: string) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-launcher-"));
  const oldPath = NodePath.join(directory, oldName);
  const newPath = NodePath.join(directory, newName);
  const cache = NodePath.join(directory, "cache");
  NodeFS.mkdirSync(cache);
  const download = NodePath.join(cache, newName);
  NodeFS.writeFileSync(oldPath, "#!/bin/sh\necho old\n", { mode: 0o755 });
  NodeFS.writeFileSync(download, "#!/bin/sh\necho updated\n", { mode: 0o755 });
  const launcher = NodePath.join(directory, "launcher.AppImage");
  NodeFS.symlinkSync(oldPath, launcher);
  const updater = new FixtureUpdater(download);
  getUpdater.mockReturnValue(updater);
  const originalAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = oldPath;
  return {
    directory,
    oldPath,
    newPath,
    download,
    launcher,
    updater,
    [Symbol.dispose]() {
      if (originalAppImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = originalAppImage;
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native shell fixtures require a Linux host.
describe.skipIf(process.platform !== "linux")("AppImage launch paths", () => {
  it.live("keeps a launcher through the versioned-to-stable transition", () =>
    Effect.gen(function* () {
      using f = fixture("T3-Code-0.1.7-arm64.AppImage", "T3-Code-arm64.AppImage");
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false });
      assert.equal(NodeChildProcess.execFileSync(f.launcher, { encoding: "utf8" }), "updated\n");
      assert.equal(NodeFS.statSync(f.oldPath).mode & 0o777, 0o755);
      assert.equal(NodeFS.readFileSync(f.newPath, "utf8"), "#!/bin/sh\necho updated\n");
      assert.equal(f.updater.listenerCount("appimage-filename-updated"), 0);
    }),
  );

  it.live("keeps the transition alias through an in-place stable update", () =>
    Effect.gen(function* () {
      using f = fixture("My T3-0.1.7.AppImage", "T3-Code-x86_64.AppImage");
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      const env = yield* HostProcess.Environment;
      env.APPIMAGE = f.newPath;
      const nextDownload = NodePath.join(f.directory, "cache", "T3-Code-x86_64.AppImage");
      NodeFS.writeFileSync(nextDownload, "#!/bin/sh\necho updated\n", { mode: 0o755 });
      getUpdater.mockReturnValue(new FixtureUpdater(nextDownload));
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      assert.equal(NodeChildProcess.execFileSync(f.launcher, { encoding: "utf8" }), "updated\n");
      assert.equal(NodeFS.readlinkSync(f.oldPath), NodePath.basename(f.newPath));
    }),
  );

  it.live("does not build alias chains between versioned releases", () =>
    Effect.gen(function* () {
      using f = fixture("T3-Code-0.1.7.AppImage", "T3-Code-0.1.8.AppImage");
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false });
      assert.isFalse(NodeFS.existsSync(f.oldPath));
      assert.throws(() => NodeFS.lstatSync(f.oldPath));
      assert.equal(NodeChildProcess.execFileSync(f.newPath, { encoding: "utf8" }), "updated\n");
    }),
  );

  it.live("preserves a custom versionless filename in place", () =>
    Effect.gen(function* () {
      using f = fixture("My T3.AppImage", "T3-Code-x86_64.AppImage");
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false });
      assert.equal(NodeChildProcess.execFileSync(f.launcher, { encoding: "utf8" }), "updated\n");
      assert.isFalse(NodeFS.existsSync(f.newPath));
    }),
  );

  it.live("leaves the alias usable after a relaunch failure and re-download retry", () =>
    Effect.gen(function* () {
      using f = fixture("T3-Code-0.1.7.AppImage", "T3-Code-x86_64.AppImage");
      NodeFS.writeFileSync(f.download, "#!/bin/sh\nexit 1\n");
      const result = yield* Effect.exit(
        ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(NodeFS.readFileSync(f.oldPath, "utf8"), "#!/bin/sh\nexit 1\n");
      assert.equal(f.updater.listenerCount("appimage-filename-updated"), 0);
      NodeFS.writeFileSync(f.download, "#!/bin/sh\necho updated\n", { mode: 0o755 });
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false });
      assert.equal(NodeChildProcess.execFileSync(f.launcher, { encoding: "utf8" }), "updated\n");
    }),
  );

  it.live("does not overwrite a path recreated during installation or abort relaunch", () =>
    Effect.gen(function* () {
      using f = fixture("T3-Code-0.1.7.AppImage", "T3-Code-x86_64.AppImage");
      f.updater.on("appimage-filename-updated", () =>
        NodeFS.writeFileSync(f.oldPath, "other file"),
      );
      yield* ElectronUpdater.make.quitAndInstall({ isSilent: true, isForceRunAfter: false });
      assert.equal(NodeFS.readFileSync(f.oldPath, "utf8"), "other file");
      assert.equal(NodeChildProcess.execFileSync(f.newPath, { encoding: "utf8" }), "updated\n");
    }),
  );
});
