// @effect-diagnostics nodeBuiltinImport:off -- The generated shell script must really run, against a real directory tree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxFolderMenu from "./DesktopLinuxFolderMenu.ts";

describe("readOpenFolderArgument", () => {
  it("reads the folder wherever Electron placed it", () => {
    assert.equal(
      DesktopLinuxFolderMenu.readOpenFolderArgument([
        "/opt/t3code",
        "--allow-file-access-from-files",
        "--open-folder=/home/al ice/my project",
      ]),
      "/home/al ice/my project",
    );
  });

  it("ignores missing and relative folders", () => {
    assert.isNull(DesktopLinuxFolderMenu.readOpenFolderArgument(["/opt/t3code"]));
    assert.isNull(DesktopLinuxFolderMenu.readOpenFolderArgument(["--open-folder="]));
    assert.isNull(DesktopLinuxFolderMenu.readOpenFolderArgument(["--open-folder=project"]));
  });
});

describe("renderKdeServiceMenu", () => {
  it("quotes the launcher for Exec", () => {
    const entry = DesktopLinuxFolderMenu.renderKdeServiceMenu({
      menuName: "Open in T3 Code (Nightly)",
      execTarget: "/home/al ice/T3 Code.AppImage",
      iconPath: "/home/al ice/icon.png",
    });

    assert.include(entry, "MimeType=inode/directory;\n");
    assert.include(entry, "Name=Open in T3 Code (Nightly)\n");
    assert.include(entry, 'Exec="/home/al ice/T3 Code.AppImage" --open-folder=%f\n');
  });
});

describe("renderNautilusScript", () => {
  const runScript = (input: {
    readonly args: ReadonlyArray<string>;
    readonly launcherName: string;
    readonly select: (root: string) => void;
  }) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-folder-menu-"));
    try {
      const launcher = NodePath.join(root, input.launcherName);
      NodeFS.writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const script = NodePath.join(root, "script");
      NodeFS.writeFileSync(
        script,
        DesktopLinuxFolderMenu.renderNautilusScript({ execTarget: launcher }),
        { mode: 0o755 },
      );
      input.select(root);
      const cwd = NodePath.join(root, "cur rent");
      const stdout = NodeChildProcess.execFileSync(script, input.args, { cwd, encoding: "utf8" });
      return { root: NodeFS.realpathSync(root), stdout };
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };
  const selectFolders = (root: string) => {
    NodeFS.mkdirSync(NodePath.join(root, "cur rent", "-sel 'ected"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "cur rent", "file.txt"), "");
  };

  it("passes a selected folder as one absolute argument", () => {
    const { root, stdout } = runScript({
      args: ["-sel 'ected"],
      launcherName: "T3 it's.AppImage",
      select: selectFolders,
    });
    assert.equal(stdout, `--open-folder=${root}/cur rent/-sel 'ected\n`);
  });

  it("falls back to the current folder for an empty or file selection", () => {
    for (const args of [[], ["file.txt"]]) {
      const { root, stdout } = runScript({
        args,
        launcherName: "launcher",
        select: selectFolders,
      });
      assert.equal(stdout, `--open-folder=${root}/cur rent\n`);
    }
  });
});

it.layer(NodeServices.layer)("DesktopLinuxFolderMenu.register", (it) => {
  const registerIn = (dataDir: string, overrides: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const environment = DesktopEnvironment.DesktopEnvironment.of({
        path,
        platform: "linux",
        isPackaged: true,
        displayName: "T3 Code (Alpha)",
        linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
        linuxApplicationsDir: path.join(dataDir, "applications"),
        desktopLauncherPath: Option.none(),
        appImagePath: Option.some("/opt/T3-Code.AppImage"),
        ...overrides,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
      const menu = yield* DesktopLinuxFolderMenu.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
            Layer.succeed(FileSystem.FileSystem, fileSystem),
          ),
        ),
      );
      yield* menu.register;
    });

  it.effect("installs executable Dolphin and Nautilus entries that launch the AppImage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* registerIn(dataDir);

      const servicePath = `${dataDir}/kio/servicemenus/com.t3tools.T3Code.OpenFolder.desktop`;
      const scriptPath = `${dataDir}/nautilus/scripts/Open in T3 Code (Alpha)`;
      assert.include(
        yield* fileSystem.readFileString(servicePath),
        'Exec="/opt/T3-Code.AppImage" --open-folder=%f',
      );
      assert.include(
        yield* fileSystem.readFileString(servicePath),
        `Icon=${dataDir}/icons/com.t3tools.T3Code.desktop.png`,
      );
      assert.include(yield* fileSystem.readFileString(scriptPath), "'/opt/T3-Code.AppImage'");
      assert.equal(((yield* fileSystem.stat(servicePath)).mode & 0o777).toString(8), "755");
      assert.equal(((yield* fileSystem.stat(scriptPath)).mode & 0o777).toString(8), "755");
    }).pipe(Effect.scoped),
  );

  it.effect("repairs a lost executable bit on an otherwise current entry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* registerIn(dataDir);
      const servicePath = `${dataDir}/kio/servicemenus/com.t3tools.T3Code.OpenFolder.desktop`;
      yield* fileSystem.chmod(servicePath, 0o644);

      yield* registerIn(dataDir);

      assert.equal(((yield* fileSystem.stat(servicePath)).mode & 0o777).toString(8), "755");
    }).pipe(Effect.scoped),
  );

  it.effect("writes nothing for unpackaged runs or other platforms", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* registerIn(dataDir, { isPackaged: false });
      yield* registerIn(dataDir, { platform: "darwin" });

      assert.deepEqual(yield* fileSystem.readDirectory(dataDir), []);
    }).pipe(Effect.scoped),
  );

  it.effect("never fails startup when the menu cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${dataDir}/kio`, "not a directory");
      yield* registerIn(dataDir);

      assert.isTrue(
        yield* fileSystem.exists(`${dataDir}/nautilus/scripts/Open in T3 Code (Alpha)`),
      );
    }).pipe(Effect.scoped),
  );
});
