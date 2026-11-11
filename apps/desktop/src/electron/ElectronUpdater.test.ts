// @effect-diagnostics nodeBuiltinImport:off - Exercises AppImage replacement on a real temporary filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { AppImageUpdater } from "electron-updater";
import { afterEach, vi } from "vite-plus/test";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    renameSync: vi.fn(actual.renameSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

const updaterSelection = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("electron-updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("electron-updater")>();
  return {
    AppImageUpdater: actual.AppImageUpdater,
    get autoUpdater() {
      return updaterSelection.current;
    },
  };
});

import * as ElectronUpdater from "./ElectronUpdater.ts";
import { installAppImageUpdate } from "./AppImageInstall.ts";

const oldAppImage = "#!/bin/sh\n# old build\nexit 0\n";
const newAppImage =
  '#!/bin/sh\nprintf \'%s|%s\' "$APPIMAGE_SILENT_INSTALL" "$APPIMAGE_EXIT_AFTER_INSTALL" > "${0%/*}/launched"\n';
const sha512 = (content: string) =>
  NodeCrypto.createHash("sha512").update(content).digest("base64");
const directories: Array<string> = [];

function crossDevice(installerPath: string) {
  const rename = vi.mocked(NodeFS.renameSync).getMockImplementation()!;
  vi.mocked(NodeFS.renameSync).mockImplementation((from, to) => {
    if (from === installerPath) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    rename(from, to);
  });
}

class FixtureAppImageUpdater extends AppImageUpdater {
  override spawnLog = vi.fn(
    (_command: string, _args: Array<string> = [], _env: NodeJS.ProcessEnv = {}) =>
      Promise.resolve(true),
  );
}

function fixture(appImageName = "T3-Code.AppImage") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-updater-"));
  directories.push(root);
  const applications = NodePath.join(root, "Applications");
  const pending = NodePath.join(root, "cache", "pending");
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(applications);
  NodeFS.mkdirSync(pending, { recursive: true });
  NodeFS.mkdirSync(bin);
  const appImageFile = NodePath.join(applications, appImageName);
  const installerPath = NodePath.join(pending, "T3-Code-1.2.3-x86_64.AppImage");
  NodeFS.writeFileSync(appImageFile, oldAppImage, { mode: 0o755 });
  NodeFS.writeFileSync(installerPath, newAppImage, { mode: 0o644 });
  // The stock installer unlinks the app, then `mv`s; make that move fail like a cross-device ENOSPC.
  NodeFS.writeFileSync(NodePath.join(bin, "mv"), '#!/bin/sh\nprintf partial > "$3"\nexit 1\n', {
    mode: 0o755,
  });
  vi.stubEnv("PATH", `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("APPIMAGE", appImageFile);
  vi.stubEnv("APPIMAGE_EXIT_AFTER_INSTALL", undefined);

  const updater = new FixtureAppImageUpdater(null, {
    version: "1.2.2",
    name: "T3 Code",
    isPackaged: true,
    appUpdateConfigPath: NodePath.join(root, "app-update.yml"),
    userDataPath: root,
    baseCachePath: NodePath.join(root, "cache"),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    onQuit: vi.fn(),
  });
  updater.logger = null;
  const downloadedUpdateHelper = {
    file: installerPath,
    downloadedFileInfo: { sha512: sha512(newAppImage), isAdminRightsRequired: false },
    fileInfo: { info: { size: Buffer.byteLength(newAppImage) } },
  };
  Object.assign(updater, { downloadedUpdateHelper });
  const errors = vi.fn();
  const renamed = vi.fn();
  updater.on("error", errors);
  updater.on("appimage-filename-updated", renamed);
  updaterSelection.current = updater;
  return {
    updater,
    root,
    applications,
    appImageFile,
    installerPath,
    marker: NodePath.join(applications, "launched"),
    downloadedUpdateHelper,
    errors,
    renamed,
  };
}

const activateUpdater = Effect.gen(function* () {
  const updater = yield* ElectronUpdater.ElectronUpdater;
  yield* updater.setAutoDownload(false);
}).pipe(Effect.provide(ElectronUpdater.layer));

afterEach(() => {
  vi.mocked(NodeFS.copyFileSync).mockReset();
  vi.mocked(NodeFS.renameSync).mockReset();
  vi.mocked(NodeFS.realpathSync).mockReset();
  updaterSelection.current = undefined;
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("AppImage updater", () => {
  it.effect("sends dependency logs to the Effect logger and restores the previous logger", () =>
    Effect.gen(function* () {
      const input = fixture();
      const previousLogger = input.updater.logger;
      const records: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
      const captureLogs = Logger.make(({ message, fiber }) => {
        records.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
      });

      yield* Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setAutoDownload(false);
        input.updater.logger?.info("Downloading update");
      }).pipe(
        Effect.provide(
          ElectronUpdater.layer.pipe(
            Layer.provide(Logger.layer([captureLogs], { mergeWithExisting: false })),
          ),
        ),
      );

      assert.strictEqual(input.updater.logger, previousLogger);
      assert.deepEqual(records, [
        { message: ["Downloading update"], annotations: { component: "desktop-updater" } },
      ]);
    }),
  );

  it.effect.each([
    "partial cross-device copy",
    "silently truncated cross-device copy",
    "same-size corruption",
    "incorrect release size",
  ] as const)("keeps the installed app and cached download after a %s", (failure) =>
    Effect.gen(function* () {
      const input = fixture();
      if (
        failure === "partial cross-device copy" ||
        failure === "silently truncated cross-device copy"
      ) {
        crossDevice(input.installerPath);
        vi.mocked(NodeFS.copyFileSync).mockImplementation((from, to) => {
          NodeFS.writeFileSync(to, NodeFS.readFileSync(from).subarray(0, 12));
          if (failure === "partial cross-device copy") {
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          }
        });
      } else if (failure === "same-size corruption") {
        NodeFS.writeFileSync(input.installerPath, newAppImage.replace("printf", "broken"));
      } else {
        input.downloadedUpdateHelper.fileInfo.info.size += 1;
      }
      const cached = NodeFS.readFileSync(input.installerPath, "utf8");
      yield* activateUpdater;

      assert.isFalse(input.updater.install(true, false));

      assert.equal(input.errors.mock.calls.length, 1);
      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
      assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), cached);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [
        NodePath.basename(input.appImageFile),
      ]);
      assert.equal(input.updater.spawnLog.mock.calls.length, 0);
    }),
  );

  it.effect("renames a versioned AppImage and force-relaunches it with silent-install flags", () =>
    Effect.gen(function* () {
      const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
      const destination = NodePath.join(input.applications, NodePath.basename(input.installerPath));
      yield* activateUpdater;

      assert.isTrue(input.updater.install(true, true));

      assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
      assert.equal(NodeFS.statSync(destination).mode & 0o777, 0o755);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(destination)]);
      assert.isFalse(NodeFS.existsSync(input.installerPath));
      assert.deepEqual(input.renamed.mock.calls, [[destination]]);
      const [command, args, env = {}] = input.updater.spawnLog.mock.calls[0]!;
      assert.equal(command, destination);
      assert.deepEqual(args, []);
      assert.equal(env.APPIMAGE_SILENT_INSTALL, "true");
      assert.isUndefined(env.APPIMAGE_EXIT_AFTER_INSTALL);
      assert.equal(input.errors.mock.calls.length, 0);
    }),
  );

  it.effect("copies a custom-named AppImage across filesystems and runs exit-after-install", () =>
    Effect.gen(function* () {
      const input = fixture("My-T3.AppImage");
      crossDevice(input.installerPath);
      yield* activateUpdater;

      assert.isTrue(input.updater.install(true, false));

      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), newAppImage);
      assert.equal(NodeFS.statSync(input.appImageFile).mode & 0o777, 0o755);
      assert.equal(NodeFS.readFileSync(input.marker, "utf8"), "true|true");
      assert.isFalse(NodeFS.existsSync(input.installerPath));
      assert.deepEqual(NodeFS.readdirSync(input.applications).sort(), [
        "My-T3.AppImage",
        "launched",
      ]);
      assert.equal(input.renamed.mock.calls.length, 0);
      assert.equal(input.updater.spawnLog.mock.calls.length, 0);
      assert.equal(input.errors.mock.calls.length, 0);
    }),
  );

  it.each(["same path", "symlink", "mount alias"] as const)(
    "keeps the installed update when the download reaches it through a %s",
    (aliasKind) => {
      const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
      let cacheDirectory = input.applications;
      if (aliasKind !== "same path") {
        cacheDirectory = NodePath.join(input.root, "alias");
        NodeFS.symlinkSync(input.applications, cacheDirectory);
      }
      const installerPath = NodePath.join(cacheDirectory, NodePath.basename(input.installerPath));
      NodeFS.renameSync(input.installerPath, installerPath);
      if (aliasKind === "mount alias") {
        // Bind mounts share directory entries without realpath resolving their aliases.
        vi.mocked(NodeFS.realpathSync).mockImplementation(((path: NodeFS.PathLike) =>
          NodePath.resolve(String(path))) as typeof NodeFS.realpathSync);
      }

      const destination = installAppImageUpdate({
        appImageFile: input.appImageFile,
        installerPath,
        sha512: sha512(newAppImage),
      });

      assert.equal(
        destination,
        NodePath.join(input.applications, NodePath.basename(installerPath)),
      );
      assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(installerPath)]);
    },
  );
});
