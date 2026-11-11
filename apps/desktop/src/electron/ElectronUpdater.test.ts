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
import * as Tracer from "effect/Tracer";
import { AppImageUpdater } from "electron-updater";
import { afterEach, vi } from "vite-plus/test";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    realpathSync: vi.fn(actual.realpathSync),
    rmSync: vi.fn(actual.rmSync),
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
import { installAppImageUpdate, verifyAppImageInstalls } from "./AppImageInstall.ts";

function crossDevice(installerPath: string) {
  const rename = vi.mocked(NodeFS.renameSync).getMockImplementation()!;
  vi.mocked(NodeFS.renameSync).mockImplementation((from, to) => {
    if (from === installerPath) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    rename(from, to);
  });
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installAppImageUpdate", () => {
  const oldAppImage = "#!/bin/sh\n# old build\nexit 0\n";
  const newAppImage = `#!/bin/sh\n# new build\nexit 0\n#${"x".repeat(4096)}\n`;
  const sha512 = (content: string) =>
    NodeCrypto.createHash("sha512").update(content).digest("base64");
  const directories: Array<string> = [];

  function fixture(appImageName = "T3-Code.AppImage") {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-install-"));
    directories.push(root);
    const applications = NodePath.join(root, "Applications");
    const pending = NodePath.join(root, "cache", "pending");
    NodeFS.mkdirSync(applications);
    NodeFS.mkdirSync(pending, { recursive: true });
    const appImageFile = NodePath.join(applications, appImageName);
    const installerPath = NodePath.join(pending, "T3-Code-1.2.3-x86_64.AppImage");
    NodeFS.writeFileSync(appImageFile, oldAppImage, { mode: 0o755 });
    NodeFS.writeFileSync(installerPath, newAppImage, { mode: 0o644 });
    return { root, applications, appImageFile, installerPath };
  }

  afterEach(() => {
    vi.mocked(NodeFS.fsyncSync).mockReset();
    vi.mocked(NodeFS.renameSync).mockReset();
    vi.mocked(NodeFS.realpathSync).mockReset();
    vi.mocked(NodeFS.rmSync).mockReset();
    for (const directory of directories.splice(0)) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      installed: "T3-Code.AppImage",
      destination: "T3-Code.AppImage",
      releaseSize: undefined,
      across: false,
    },
    {
      installed: "T3-Code-1.2.2-x86_64.AppImage",
      destination: "T3-Code-1.2.3-x86_64.AppImage",
      releaseSize: Buffer.byteLength(newAppImage),
      across: true,
    },
  ])("replaces $installed with a verified executable at $destination", (names) => {
    const input = fixture(names.installed);
    if (names.across) crossDevice(input.installerPath);
    let copies = 0;
    const destination = installAppImageUpdate({
      ...input,
      sha512: sha512(newAppImage),
      size: names.releaseSize,
      copyFile: (from, to) => {
        copies += 1;
        assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
        const stageDirectory = NodePath.dirname(to);
        assert.equal(NodePath.dirname(stageDirectory), input.applications);
        assert.equal(NodeFS.statSync(stageDirectory).mode & 0o777, 0o700);
        NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
      },
    });

    assert.equal(copies, names.across ? 1 : 0);
    assert.equal(destination, NodePath.join(input.applications, names.destination));
    assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
    assert.equal(NodeFS.statSync(destination).mode & 0o777, 0o755);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [names.destination]);
    assert.isFalse(NodeFS.existsSync(input.installerPath));
  });

  it("keeps the installed app and cached download when a partial copy runs out of space", () => {
    const input = fixture();
    crossDevice(input.installerPath);

    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512(newAppImage),
          copyFile: (from, to) => {
            NodeFS.writeFileSync(to, NodeFS.readFileSync(from).subarray(0, 1024));
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          },
        }),
      /ENOSPC/,
    );

    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
    assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), newAppImage);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [
      NodePath.basename(input.appImageFile),
    ]);
  });

  it("rejects empty, truncated, wrong-size and same-length corrupt updates before replacing the app", () => {
    const cases = [
      { source: "", stage: "", digest: sha512(""), size: undefined },
      { source: newAppImage, stage: "", digest: sha512(""), size: undefined },
      { source: newAppImage, stage: "short", digest: sha512("short"), size: undefined },
      {
        source: newAppImage,
        stage: newAppImage,
        digest: sha512(newAppImage),
        size: Buffer.byteLength(newAppImage) + 1,
      },
      {
        source: newAppImage,
        stage: newAppImage.replace("new", "bad"),
        digest: sha512(newAppImage),
        size: undefined,
      },
    ];
    for (const { source, stage, digest, size } of cases) {
      const input = fixture();
      crossDevice(input.installerPath);
      NodeFS.writeFileSync(input.installerPath, source);

      assert.throws(() =>
        installAppImageUpdate({
          ...input,
          sha512: digest,
          size,
          copyFile: (_from, to) => NodeFS.writeFileSync(to, stage),
        }),
      );

      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
      assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), source);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [
        NodePath.basename(input.appImageFile),
      ]);
    }
  });

  it.each(["fsyncSync", "renameSync"] as const)(
    "keeps the old app when %s fails before commit",
    (operation) => {
      const input = fixture();
      vi.mocked(NodeFS[operation]).mockImplementationOnce(() => {
        throw new Error("cannot commit update");
      });

      assert.throws(
        () => installAppImageUpdate({ ...input, sha512: sha512(newAppImage) }),
        /cannot commit update/,
      );

      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
      assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), newAppImage);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [
        NodePath.basename(input.appImageFile),
      ]);
    },
  );

  it.each(["same path", "symlink", "mount alias"] as const)(
    "keeps the committed destination when the cache reaches it through %s",
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
        ...input,
        installerPath,
        sha512: sha512(newAppImage),
      });

      assert.equal(
        destination,
        NodePath.join(input.applications, NodePath.basename(installerPath)),
      );
      assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
      assert.equal(NodeFS.readFileSync(installerPath, "utf8"), newAppImage);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(installerPath)]);
    },
  );

  it("still succeeds when removing the cached download fails after commit", () => {
    const input = fixture();
    crossDevice(input.installerPath);
    const remove = vi.mocked(NodeFS.rmSync).getMockImplementation()!;
    vi.mocked(NodeFS.rmSync).mockImplementation((path, options) => {
      if (path === input.installerPath) throw new Error("cache cleanup failed");
      remove(path, options);
    });

    const destination = installAppImageUpdate({ ...input, sha512: sha512(newAppImage) });

    assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
    assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), newAppImage);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(destination)]);
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "AppImage updater integration",
  () => {
    const oldAppImage = "#!/bin/sh\n# old build\nexit 0\n";
    const newAppImage =
      '#!/bin/sh\nprintf \'%s|%s\' "$APPIMAGE_SILENT_INSTALL" "$APPIMAGE_EXIT_AFTER_INSTALL" > "${0%/*}/launched"\n';
    const directories: Array<string> = [];

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
      const marker = NodePath.join(applications, "launched");
      NodeFS.writeFileSync(appImageFile, oldAppImage, { mode: 0o755 });
      NodeFS.writeFileSync(installerPath, newAppImage, { mode: 0o755 });
      // Make the upstream unlink-then-move installer fail like a cross-device ENOSPC.
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
        downloadedFileInfo: {
          sha512: NodeCrypto.createHash("sha512").update(newAppImage).digest("base64"),
          isAdminRightsRequired: false,
        },
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
        appImageFile,
        installerPath,
        marker,
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
      vi.mocked(NodeFS.renameSync).mockReset();
      updaterSelection.current = undefined;
      vi.unstubAllEnvs();
      for (const directory of directories.splice(0)) {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    });

    it.effect(
      "sends dependency logs to the configured logger and restores the previous logger",
      () =>
        Effect.gen(function* () {
          const input = fixture();
          const previousLogger = input.updater.logger;
          const message = "Downloading update from https://example.test/private/AppImage";
          const records: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
          const captureLogs = Logger.make(({ message, fiber }) => {
            records.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
          });
          const spans: Array<Tracer.NativeSpan> = [];
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          });

          yield* Effect.gen(function* () {
            const updater = yield* ElectronUpdater.ElectronUpdater;
            yield* updater.setAutoDownload(false);
            input.updater.logger?.info(message);
          }).pipe(
            Effect.provide(
              ElectronUpdater.layer.pipe(
                Layer.provide(Logger.layer([captureLogs], { mergeWithExisting: false })),
              ),
            ),
            Effect.withTracer(tracer),
          );

          assert.strictEqual(input.updater.logger, previousLogger);
          assert.deepEqual(records, [
            { message: [message], annotations: { component: "desktop-updater" } },
          ]);
          const span = spans.find((span) => span.name === "desktop.updater");
          assert.isDefined(span);
          assert.deepEqual(Object.fromEntries(span!.attributes), {
            component: "desktop-updater",
            level: "logInfo",
          });
        }),
    );

    it.effect.each([
      "partial copy ENOSPC",
      "same-size corruption",
      "incorrect release size",
    ] as const)("preserves the installed app and cache without launching after %s", (failure) =>
      Effect.gen(function* () {
        const input = fixture();
        if (failure === "partial copy ENOSPC") {
          crossDevice(input.installerPath);
          verifyAppImageInstalls(input.updater, (from, to) => {
            NodeFS.writeFileSync(to, NodeFS.readFileSync(from).subarray(0, 12));
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          });
        } else {
          if (failure === "same-size corruption") {
            NodeFS.writeFileSync(input.installerPath, newAppImage.replace("printf", "broken"));
          } else {
            input.downloadedUpdateHelper.fileInfo.info.size += 1;
          }
          yield* activateUpdater;
        }
        const cached = NodeFS.readFileSync(input.installerPath, "utf8");

        assert.isFalse(input.updater.install(true, false));

        assert.equal(input.errors.mock.calls.length, 1);
        assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
        assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), cached);
        assert.equal(input.renamed.mock.calls.length, 0);
        assert.equal(input.updater.spawnLog.mock.calls.length, 0);
        assert.isFalse(NodeFS.existsSync(input.marker));
      }),
    );

    it.effect(
      "renames a versioned AppImage before forcing a relaunch with silent-install flags",
      () =>
        Effect.gen(function* () {
          const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
          const destination = NodePath.join(
            NodePath.dirname(input.appImageFile),
            NodePath.basename(input.installerPath),
          );
          const launchedContents: Array<string> = [];
          input.updater.spawnLog.mockImplementation((command) => {
            launchedContents.push(NodeFS.readFileSync(command, "utf8"));
            return Promise.resolve(true);
          });
          yield* activateUpdater;

          assert.isTrue(input.updater.install(true, true));

          assert.deepEqual(launchedContents, [newAppImage]);
          assert.equal(NodeFS.statSync(destination).mode & 0o777, 0o755);
          assert.isFalse(NodeFS.existsSync(input.appImageFile));
          assert.deepEqual(input.renamed.mock.calls, [[destination]]);
          assert.equal(input.updater.spawnLog.mock.calls.length, 1);
          const [command, args, env = {}] = input.updater.spawnLog.mock.calls[0]!;
          assert.equal(command, destination);
          assert.deepEqual(args, []);
          assert.equal(env.APPIMAGE_SILENT_INSTALL, "true");
          assert.isUndefined(env.APPIMAGE_EXIT_AFTER_INSTALL);
          assert.equal(input.errors.mock.calls.length, 0);
        }),
    );

    it.effect(
      "preserves a custom filename and synchronously runs the exit-after-install entrypoint",
      () =>
        Effect.gen(function* () {
          const input = fixture("My-T3.AppImage");
          yield* activateUpdater;

          assert.isTrue(input.updater.install(true, false));

          assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), newAppImage);
          assert.equal(NodeFS.readFileSync(input.marker, "utf8"), "true|true");
          assert.equal(input.renamed.mock.calls.length, 0);
          assert.equal(input.updater.spawnLog.mock.calls.length, 0);
          assert.equal(input.errors.mock.calls.length, 0);
        }),
    );
  },
);
