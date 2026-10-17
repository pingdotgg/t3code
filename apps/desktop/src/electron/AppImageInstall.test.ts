// @effect-diagnostics nodeBuiltinImport:off - Installs stand-in AppImages in a throwaway directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import { AppImageUpdater } from "electron-updater";
import { afterEach, vi } from "vite-plus/test";

import { installAppImageUpdate, verifyAppImageInstalls } from "./AppImageInstall.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    realpathSync: vi.fn(actual.realpathSync),
    statSync: vi.fn(actual.statSync),
  };
});

const OLD_APPIMAGE = "#!/bin/sh\n# old build\nexit 0\n";
const NEW_APPIMAGE = `#!/bin/sh\n# new build\nexit 0\n#${"x".repeat(64 * 1024)}\n`;
const sha512 = (content: string) =>
  NodeCrypto.createHash("sha512").update(content).digest("base64");

const work: Array<string> = [];
afterEach(() => {
  vi.mocked(NodeFS.realpathSync).mockReset();
  vi.mocked(NodeFS.statSync).mockReset();
  vi.mocked(NodeFS.fsyncSync).mockReset();
  vi.mocked(NodeFS.renameSync).mockClear();
  for (const directory of work.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture(appImageName = "T3-Code.AppImage") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-install-"));
  work.push(root);
  const applications = NodePath.join(root, "Applications");
  const pending = NodePath.join(root, "cache", "pending");
  NodeFS.mkdirSync(applications, { recursive: true });
  NodeFS.mkdirSync(pending, { recursive: true });
  const appImageFile = NodePath.join(applications, appImageName);
  NodeFS.writeFileSync(appImageFile, OLD_APPIMAGE, { mode: 0o755 });
  const installerPath = NodePath.join(pending, "T3-Code-1.2.3-x86_64.AppImage");
  NodeFS.writeFileSync(installerPath, NEW_APPIMAGE, { mode: 0o644 });
  return { root, applications, appImageFile, installerPath };
}

// A cross-filesystem copy that runs out of space part of the way through.
const copyThatRunsOutOfSpace = (from: string, to: string) => {
  NodeFS.writeFileSync(to, NodeFS.readFileSync(from).subarray(0, 1024));
  throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installAppImageUpdate", () => {
  it("keeps the old app if syncing the stage fails", () => {
    const input = fixture();
    vi.mocked(NodeFS.fsyncSync).mockImplementationOnce(() => {
      throw new Error("stage sync failed");
    });
    assert.throws(
      () => installAppImageUpdate({ ...input, sha512: sha512(NEW_APPIMAGE) }),
      /stage sync failed/,
    );
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
    assert.deepEqual(NodeFS.readdirSync(input.applications), ["T3-Code.AppImage"]);
  });

  it("warns when directory sync fails after commit without failing the install", () => {
    const input = fixture();
    const warn = vi.fn();
    vi.mocked(NodeFS.fsyncSync)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("directory sync unsupported");
      });
    const destination = installAppImageUpdate({
      ...input,
      sha512: sha512(NEW_APPIMAGE),
      logger: { info: () => {}, error: () => {}, warn },
    });
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
    assert.isTrue(
      warn.mock.calls.some(([message]) => String(message).includes("directory sync unsupported")),
    );
  });

  it("keeps the old app and cache if the rename fails", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    NodeFS.mkdirSync(NodePath.join(input.applications, NodePath.basename(input.installerPath)));
    assert.throws(
      () => installAppImageUpdate({ ...input, sha512: sha512(NEW_APPIMAGE) }),
      /EISDIR|ENOTDIR|EEXIST/,
    );
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
    assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), NEW_APPIMAGE);
    assert.lengthOf(NodeFS.readdirSync(input.applications), 2);
  });
  it("syncs the verified stage before rename and the parent directory after", () => {
    const input = fixture();
    vi.mocked(NodeFS.fsyncSync).mockClear();
    vi.mocked(NodeFS.renameSync).mockClear();
    installAppImageUpdate({
      ...input,
      sha512: sha512(NEW_APPIMAGE),
      size: Buffer.byteLength(NEW_APPIMAGE),
    });
    const syncs = vi.mocked(NodeFS.fsyncSync).mock.invocationCallOrder;
    const rename = vi.mocked(NodeFS.renameSync).mock.invocationCallOrder[0];
    assert.lengthOf(syncs, 2);
    assert.isBelow(syncs[0]!, rename!);
    assert.isAbove(syncs[1]!, rename!);
  });
  it("stages on the destination filesystem, not in the download cache", () => {
    const input = fixture();
    installAppImageUpdate({
      ...input,
      sha512: sha512(NEW_APPIMAGE),
      copyFile: (from, to) => {
        assert.isFalse(NodePath.relative(input.applications, to).startsWith(".."));
        assert.notEqual(to, input.appImageFile);
        NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
      },
    });
  });

  it("stages a custom name that is near the filename length limit", () => {
    // 250 bytes is a valid name, but the name plus a suffix is not.
    const name = `${"T".repeat(241)}.AppImage`;
    assert.equal(Buffer.byteLength(name), 250);
    const input = fixture(name);
    const destination = installAppImageUpdate({
      ...input,
      sha512: sha512(NEW_APPIMAGE),
      copyFile: (from, to) => {
        const stage = NodePath.dirname(to);
        assert.equal(NodePath.dirname(stage), input.applications);
        assert.isTrue(NodePath.basename(stage).startsWith("."));
        NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
      },
    });
    assert.equal(destination, input.appImageFile);
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), NEW_APPIMAGE);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [name]);
  });

  it("does not follow or remove a pre-existing staging symlink", () => {
    const input = fixture();
    const sentinel = NodePath.join(input.root, "sentinel");
    NodeFS.mkdirSync(sentinel);
    NodeFS.writeFileSync(NodePath.join(sentinel, "keep"), "keep me");
    // Plant a link at each fixed name a predictable stage could use.
    const planted = [".t3code-update", ".t3code-update-", ".T3-Code.AppImage.update"].map((name) =>
      NodePath.join(input.applications, name),
    );
    for (const link of planted) NodeFS.symlinkSync(sentinel, link);
    let stage = "";
    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512(NEW_APPIMAGE),
          copyFile: (from, to) => {
            stage = NodePath.dirname(to);
            assert.isTrue(NodeFS.lstatSync(stage).isDirectory());
            assert.notInclude(planted, stage);
            copyThatRunsOutOfSpace(from, to);
          },
        }),
      /ENOSPC/,
    );
    assert.deepEqual(NodeFS.readdirSync(sentinel), ["keep"]);
    for (const link of planted) assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
    assert.isFalse(NodeFS.existsSync(stage));
  });

  it("gives overlapping attempts separate stages and cleans only its own", () => {
    const input = fixture();
    let outerStage = "";
    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512(NEW_APPIMAGE),
          copyFile: (from, to) => {
            outerStage = to;
            NodeFS.copyFileSync(from, to);
            assert.throws(
              () =>
                installAppImageUpdate({
                  ...input,
                  sha512: sha512(NEW_APPIMAGE),
                  copyFile: (_from, inner) => {
                    assert.notEqual(inner, outerStage);
                    throw new Error("inner copy failed");
                  },
                }),
              /inner copy failed/,
            );
            assert.equal(NodeFS.readFileSync(outerStage, "utf8"), NEW_APPIMAGE);
            throw new Error("outer copy failed");
          },
        }),
      /outer copy failed/,
    );
    assert.deepEqual(NodeFS.readdirSync(input.applications), ["T3-Code.AppImage"]);
  });

  it("keeps a committed versioned destination that is also the cached installer", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const installerPath = NodePath.join(input.applications, NodePath.basename(input.installerPath));
    NodeFS.renameSync(input.installerPath, installerPath);
    const destination = installAppImageUpdate({
      ...input,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });
    assert.equal(destination, installerPath);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
    assert.isFalse(NodeFS.existsSync(input.appImageFile));
  });

  it("keeps the destination when the cache uses a symlinked parent directory", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const alias = NodePath.join(input.root, "linked-applications");
    NodeFS.symlinkSync(input.applications, alias);
    const installerPath = NodePath.join(alias, NodePath.basename(input.installerPath));
    NodeFS.renameSync(input.installerPath, installerPath);
    const destination = installAppImageUpdate({
      ...input,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
  });

  // A bind mount needs privileges. A macOS firmlink is the same kind of alias,
  // one directory entry under two paths that realpath keeps apart.
  it.skipIf(!NodeFS.existsSync("/System/Volumes/Data/private"))(
    "keeps the destination when the cache reaches it through a mount alias",
    () => {
      const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
      const alias = NodePath.join("/System/Volumes/Data", NodeFS.realpathSync(input.applications));
      const installerPath = NodePath.join(alias, NodePath.basename(input.installerPath));
      NodeFS.renameSync(input.installerPath, installerPath);
      const entry = NodePath.join(input.applications, NodePath.basename(installerPath));
      assert.notEqual(NodeFS.realpathSync(installerPath), NodeFS.realpathSync(entry));
      assert.equal(NodeFS.statSync(installerPath).ino, NodeFS.statSync(entry).ino);
      const destination = installAppImageUpdate({
        ...input,
        installerPath,
        sha512: sha512(NEW_APPIMAGE),
      });
      assert.equal(destination, entry);
      assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
      assert.isFalse(NodeFS.existsSync(input.appImageFile));
    },
  );

  it("keeps the destination when the cache is an alias that realpath does not resolve", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const alias = NodePath.join(input.root, "alias");
    NodeFS.symlinkSync(input.applications, alias);
    const installerPath = NodePath.join(alias, NodePath.basename(input.installerPath));
    NodeFS.renameSync(input.installerPath, installerPath);
    const entry = NodePath.join(input.applications, NodePath.basename(installerPath));
    // A mount alias keeps the two paths apart, which a symlink does not.
    vi.mocked(NodeFS.realpathSync).mockImplementation(((path: NodeFS.PathLike) =>
      NodePath.resolve(String(path))) as unknown as typeof NodeFS.realpathSync);
    const destination = installAppImageUpdate({
      ...input,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });
    assert.equal(destination, entry);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
  });

  it("still removes the cached installer when only the inode number matches", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const entry = NodePath.join(input.applications, NodePath.basename(input.installerPath));
    const stat = vi.mocked(NodeFS.statSync).getMockImplementation() as (
      ...args: Array<unknown>
    ) => NodeFS.BigIntStats;
    vi.mocked(NodeFS.statSync).mockImplementation(((path: NodeFS.PathLike, options?: unknown) => {
      const result = stat(path, options);
      if (String(path) === input.installerPath && typeof result.dev === "bigint") {
        const destinationStats = stat(entry, options);
        return { ...result, dev: result.dev + 1n, ino: destinationStats.ino };
      }
      return result;
    }) as unknown as typeof NodeFS.statSync);
    const destination = installAppImageUpdate({ ...input, sha512: sha512(NEW_APPIMAGE) });
    assert.equal(destination, entry);
    assert.isFalse(NodeFS.existsSync(input.installerPath));
  });

  it("keeps the destination when the same path reports different inode numbers", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const installerPath = NodePath.join(input.applications, NodePath.basename(input.installerPath));
    NodeFS.renameSync(input.installerPath, installerPath);
    const stat = vi.mocked(NodeFS.statSync).getMockImplementation() as (
      ...args: Array<unknown>
    ) => NodeFS.BigIntStats;
    let inodeOffset = 0n;
    vi.mocked(NodeFS.statSync).mockImplementation(((path: NodeFS.PathLike, options?: unknown) => {
      const result = stat(path, options);
      if (String(path) === installerPath && typeof result.ino === "bigint") {
        return { ...result, ino: result.ino + inodeOffset++ };
      }
      return result;
    }) as unknown as typeof NodeFS.statSync);
    const destination = installAppImageUpdate({
      ...input,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });
    assert.equal(destination, installerPath);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
    assert.isFalse(NodeFS.existsSync(input.appImageFile));
  });

  it("rejects an empty source even when its digest matches", () => {
    const input = fixture();
    NodeFS.writeFileSync(input.installerPath, "");
    assert.throws(() => installAppImageUpdate({ ...input, sha512: sha512("") }), /invalid size/);
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
  });

  it("rejects an empty stage even when its digest matches", () => {
    const input = fixture();
    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512(""),
          copyFile: (_from, to) => NodeFS.writeFileSync(to, ""),
        }),
      /invalid size/,
    );
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
  });

  it("compares the stage length with the source even when its digest matches", () => {
    const input = fixture();
    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512("short"),
          copyFile: (_from, to) => NodeFS.writeFileSync(to, "short"),
        }),
      /invalid size/,
    );
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
  });

  it("checks the release size when supplied", () => {
    const input = fixture();
    assert.throws(
      () =>
        installAppImageUpdate({
          ...input,
          sha512: sha512(NEW_APPIMAGE),
          size: Buffer.byteLength(NEW_APPIMAGE) + 1,
        }),
      /invalid size/,
    );
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
  });

  it("keeps the old AppImage when copying the update runs out of space", () => {
    const { applications, appImageFile, installerPath } = fixture();

    assert.throws(
      () =>
        installAppImageUpdate({
          appImageFile,
          installerPath,
          sha512: sha512(NEW_APPIMAGE),
          copyFile: copyThatRunsOutOfSpace,
        }),
      /ENOSPC/,
    );

    assert.equal(NodeFS.readFileSync(appImageFile, "utf8"), OLD_APPIMAGE);
    assert.deepEqual(NodeFS.readdirSync(applications), ["T3-Code.AppImage"]);
    assert.isTrue(NodeFS.existsSync(installerPath));
  });

  it("keeps the old AppImage when the copied update does not match the download", () => {
    const { applications, appImageFile, installerPath } = fixture();

    assert.throws(
      () =>
        installAppImageUpdate({
          appImageFile,
          installerPath,
          sha512: sha512(NEW_APPIMAGE),
          copyFile: (_from, to) => NodeFS.writeFileSync(to, NEW_APPIMAGE.replace("new", "bad")),
        }),
      /does not match/,
    );

    assert.equal(NodeFS.readFileSync(appImageFile, "utf8"), OLD_APPIMAGE);
    assert.deepEqual(NodeFS.readdirSync(applications), ["T3-Code.AppImage"]);
  });

  it("replaces a custom-named AppImage and removes the download", () => {
    const { applications, appImageFile, installerPath } = fixture();

    const destination = installAppImageUpdate({
      appImageFile,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });

    assert.equal(destination, appImageFile);
    assert.equal(NodeFS.readFileSync(appImageFile, "utf8"), NEW_APPIMAGE);
    assert.equal(NodeFS.statSync(appImageFile).mode & 0o777, 0o755);
    assert.deepEqual(NodeFS.readdirSync(applications), ["T3-Code.AppImage"]);
    assert.isFalse(NodeFS.existsSync(installerPath));
  });

  it("installs a versioned AppImage under the update's name", () => {
    const { applications, appImageFile, installerPath } = fixture("T3-Code-1.2.2-x86_64.AppImage");

    const destination = installAppImageUpdate({
      appImageFile,
      installerPath,
      sha512: sha512(NEW_APPIMAGE),
    });

    assert.equal(destination, NodePath.join(applications, "T3-Code-1.2.3-x86_64.AppImage"));
    assert.deepEqual(NodeFS.readdirSync(applications), ["T3-Code-1.2.3-x86_64.AppImage"]);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), NEW_APPIMAGE);
    assert.equal(NodeFS.statSync(destination).mode & 0o777, 0o755);
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("verifyAppImageInstalls", () => {
  // Runs electron-updater's own install entry point with a stand-in app.
  // Its quit handler exercises the non-relaunch branch. The desktop app
  // disables install on quit and uses explicit quitAndInstall instead.
  function makeUpdater(input: ReturnType<typeof fixture>) {
    let quitHandler: ((exitCode: number) => void) | undefined;
    const updater = new AppImageUpdater(null, {
      version: "1.2.2",
      name: "t3code",
      isPackaged: true,
      appUpdateConfigPath: NodePath.join(input.root, "app-update.yml"),
      userDataPath: input.root,
      baseCachePath: NodePath.join(input.root, "cache"),
      whenReady: () => Promise.resolve(),
      quit: () => undefined,
      relaunch: () => undefined,
      onQuit: (handler: (exitCode: number) => void) => {
        quitHandler = handler;
      },
    });
    updater.logger = null;
    Object.assign(updater, {
      downloadedUpdateHelper: {
        file: input.installerPath,
        downloadedFileInfo: { sha512: sha512(NEW_APPIMAGE), isAdminRightsRequired: false },
      },
    });
    const errors: Array<string> = [];
    updater.on("error", (error: Error) => errors.push(error.message));
    return {
      updater,
      errors,
      quit: (exitCode = 0) => {
        (updater as unknown as { addQuitHandler(): void }).addQuitHandler();
        assert.isDefined(quitHandler);
        quitHandler?.(exitCode);
      },
    };
  }

  function withAppImageEnv<A>(input: { appImageFile: string; bin: string }, run: () => A): A {
    const previous = {
      APPIMAGE: process.env.APPIMAGE,
      PATH: process.env.PATH,
      APPIMAGE_EXIT_AFTER_INSTALL: process.env.APPIMAGE_EXIT_AFTER_INSTALL,
    };
    delete process.env.APPIMAGE_EXIT_AFTER_INSTALL;
    process.env.APPIMAGE = input.appImageFile;
    process.env.PATH = `${input.bin}:${process.env.PATH ?? ""}`;
    try {
      return run();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  // electron-updater moves the download with `mv`; this one runs out of space.
  function failingMv(root: string) {
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "mv"),
      '#!/bin/sh\nhead -c 1024 "$2" > "$3"\necho "mv: error writing: No space left on device" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    return bin;
  }

  it("keeps the old AppImage when moving the update into place fails", () => {
    const input = fixture();
    const { updater, errors } = makeUpdater(input);
    verifyAppImageInstalls(updater, copyThatRunsOutOfSpace);

    const installed = withAppImageEnv(
      { appImageFile: input.appImageFile, bin: failingMv(input.root) },
      () => updater.install(true, false),
    );

    assert.isFalse(installed);
    assert.lengthOf(errors, 1);
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
    assert.isTrue(NodeFS.existsSync(input.installerPath));
  });

  it("installs the verified update and runs it", () => {
    const input = fixture();
    const { updater, errors } = makeUpdater(input);
    verifyAppImageInstalls(updater);

    const installed = withAppImageEnv(
      { appImageFile: input.appImageFile, bin: failingMv(input.root) },
      () => updater.install(true, false),
    );

    assert.isTrue(installed);
    assert.deepEqual(errors, []);
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), NEW_APPIMAGE);
    assert.isFalse(NodeFS.existsSync(input.installerPath));
  });

  it("passes the release size from the downloaded helper to verification", () => {
    const input = fixture();
    const { updater, errors } = makeUpdater(input);
    Object.assign(updater, {
      downloadedUpdateHelper: {
        file: input.installerPath,
        downloadedFileInfo: { sha512: sha512(NEW_APPIMAGE) },
        fileInfo: { info: { size: 1 } },
      },
    });
    verifyAppImageInstalls(updater);
    const installed = withAppImageEnv(
      { appImageFile: input.appImageFile, bin: failingMv(input.root) },
      () => updater.install(true, false),
    );
    assert.isFalse(installed);
    assert.match(errors.join("\n"), /invalid size/);
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
  });

  it("forces a relaunch with the verified versioned destination", () => {
    const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
    const { updater, errors } = makeUpdater(input);
    const spawn = vi.fn((_cmd: string, _args: Array<string>, _env: NodeJS.ProcessEnv) =>
      Promise.resolve(true),
    );
    const renamed = vi.fn();
    Object.assign(updater, { spawnLog: spawn });
    updater.on("appimage-filename-updated", renamed);
    verifyAppImageInstalls(updater);
    withAppImageEnv({ appImageFile: input.appImageFile, bin: failingMv(input.root) }, () =>
      assert.isTrue(updater.install(true, true)),
    );
    const destination = NodePath.join(input.applications, NodePath.basename(input.installerPath));
    assert.deepEqual(renamed.mock.calls, [[destination]]);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(spawn.mock.calls[0]?.slice(0, 2), [destination, []]);
    assert.equal(spawn.mock.calls[0]?.[2].APPIMAGE_SILENT_INSTALL, "true");
    assert.isUndefined(spawn.mock.calls[0]?.[2].APPIMAGE_EXIT_AFTER_INSTALL);
    assert.deepEqual(errors, []);
  });

  it("installs through the dependency quit handler with exit-after-install flags", () => {
    const input = fixture();
    const marker = NodePath.join(input.root, "launch-flags");
    const script = `#!/bin/sh\nprintf '%s|%s' "$APPIMAGE_SILENT_INSTALL" "$APPIMAGE_EXIT_AFTER_INSTALL" > '${marker}'\n`;
    NodeFS.writeFileSync(input.installerPath, script);
    const { updater, errors, quit } = makeUpdater(input);
    Object.assign(updater, {
      downloadedUpdateHelper: {
        file: input.installerPath,
        downloadedFileInfo: { sha512: sha512(script) },
      },
    });
    verifyAppImageInstalls(updater);
    withAppImageEnv({ appImageFile: input.appImageFile, bin: failingMv(input.root) }, () => quit());
    assert.deepEqual(errors, []);
    assert.equal(NodeFS.readFileSync(marker, "utf8"), "true|true");
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), script);
  });

  it("warns about post-commit cache cleanup failure and still relaunches", () => {
    const input = fixture();
    const { updater, errors } = makeUpdater(input);
    const warn = vi.fn();
    const spawn = vi.fn(() => Promise.resolve(true));
    updater.logger = { info: () => undefined, error: () => undefined, warn };
    Object.assign(updater, { spawnLog: spawn });
    verifyAppImageInstalls(updater);
    const pending = NodePath.dirname(input.installerPath);
    NodeFS.chmodSync(pending, 0o555);
    try {
      withAppImageEnv({ appImageFile: input.appImageFile, bin: failingMv(input.root) }, () =>
        assert.isTrue(updater.install(true, true)),
      );
      assert.isTrue(NodeFS.existsSync(input.installerPath));
      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), NEW_APPIMAGE);
      assert.isTrue(
        warn.mock.calls.some(([message]) =>
          String(message).startsWith("AppImage update cleanup failed"),
        ),
      );
      assert.equal(spawn.mock.calls.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      NodeFS.chmodSync(pending, 0o755);
    }
  });

  it("preserves the original failure if removing the failed stage also fails", () => {
    const input = fixture();
    let stageDirectory = "";
    const failure = new Error("original copy failure");
    try {
      assert.throws(
        () =>
          installAppImageUpdate({
            ...input,
            sha512: sha512(NEW_APPIMAGE),
            copyFile: (_from, to) => {
              stageDirectory = NodePath.dirname(to);
              NodeFS.writeFileSync(to, "partial");
              NodeFS.chmodSync(stageDirectory, 0o555);
              throw failure;
            },
          }),
        /original copy failure/,
      );
      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), OLD_APPIMAGE);
    } finally {
      if (NodeFS.existsSync(stageDirectory)) NodeFS.chmodSync(stageDirectory, 0o755);
    }
  });
});
