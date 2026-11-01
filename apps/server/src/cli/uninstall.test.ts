// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's link calls take strings; this test needs raw bytes.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { findOwnedLauncher, findRecordedLaunchers, spawnWindowsRemoval } from "./uninstall.ts";

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // macOS spells the temp folder /var but resolves it to /private/var.
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-uninstall-" })
        .pipe(Effect.flatMap(fs.realPath));
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t3");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      // Installs link to the command link, which points at the version.
      const commandLink = path.join(versionsDir, "current/t3");
      const viaCommandLink = path.join(root, "bin/t3-command");
      yield* fs.makeDirectory(path.dirname(commandLink));
      yield* fs.symlink(exe, commandLink);
      yield* fs.symlink(commandLink, viaCommandLink);
      assert.equal(
        yield* findOwnedLauncher({ launchedAs: viaCommandLink, versionsDir }),
        viaCommandLink,
      );
      // On POSIX a backslash is part of a name, so `versions/manager\t3` is not a version's t3.
      const backslashed = path.join(versionsDir, "manager\\t3");
      const viaBackslash = path.join(root, "bin/t3-backslash");
      yield* fs.writeFileString(backslashed, "");
      yield* fs.symlink(backslashed, viaBackslash);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: viaBackslash, versionsDir }));
      // A version run directly is not a launcher, nor another tool's link that selects it.
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: exe, versionsDir }));
      const managed = path.join(root, "manager/t3");
      const managedBin = path.join(root, "bin/t3-managed");
      yield* fs.makeDirectory(path.dirname(managed), { recursive: true });
      yield* fs.symlink(exe, managed);
      yield* fs.symlink(managed, managedBin);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: managedBin, versionsDir }));
      const asFolder = path.join(root, "bin/t3-folder");
      yield* fs.symlink(`${exe}/.`, asFolder);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: asFolder, versionsDir }));
      // `..` after a symlinked folder leads where the folder does, not back into this home.
      const hop = path.join(root, "runtime/hop");
      const hopped = path.join(root, "bin/t3-hopped");
      yield* fs.makeDirectory(path.join(root, "other/runtime/inner"), { recursive: true });
      yield* fs.symlink(path.join(root, "other/runtime/inner"), hop);
      yield* fs.symlink(`${hop}/../versions/1.0.0/t3`, hopped);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: hopped, versionsDir }));
      // A version folder that is itself another tool's folder only looks like ours.
      yield* fs.symlink(path.dirname(otherExe), path.join(versionsDir, "2.0.0"));
      const borrowed = path.join(root, "bin/t3-borrowed");
      yield* fs.symlink(path.join(versionsDir, "2.0.0/t3"), borrowed);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: borrowed, versionsDir }));
      // A target that is not UTF-8 names another file than its decoded text, so it is not ours.
      const rawFolder = Buffer.concat([Buffer.from(`${versionsDir}/`), Buffer.from([0xff])]);
      yield* Effect.promise(() => NodeFSP.symlink(path.join(root, "elsewhere"), rawFolder));
      const rawLink = path.join(root, "bin/t3-raw");
      yield* Effect.promise(() =>
        NodeFSP.symlink(Buffer.concat([rawFolder, Buffer.from("/t3")]), rawLink),
      );
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: rawLink, versionsDir }));
      // A version folder that is a link to one of ours (versions/latest) is not followed.
      yield* fs.symlink(path.join(versionsDir, "1.0.0"), path.join(versionsDir, "latest"));
      const latest = path.join(root, "bin/t3-latest");
      yield* fs.symlink(path.join(versionsDir, "latest/t3"), latest);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: latest, versionsDir }));
      // A version folder link that leads nowhere is not missing; it may be another tool's.
      yield* fs.symlink(path.join(root, "unmounted"), path.join(versionsDir, "2.1.0"));
      const unmounted = path.join(root, "bin/t3-unmounted");
      yield* fs.symlink(path.join(versionsDir, "2.1.0/t3"), unmounted);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: unmounted, versionsDir }));
      // With versions itself a link, the command link is still the one in the runtime folder.
      const store = path.join(root, "store");
      yield* fs.makeDirectory(path.join(store, "versions/1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(store, "t3"), "");
      const linkedHome = path.join(root, "linked-home");
      yield* fs.makeDirectory(path.join(linkedHome, "runtime"), { recursive: true });
      yield* fs.symlink(path.join(store, "versions"), path.join(linkedHome, "runtime/versions"));
      const storeLauncher = path.join(root, "bin/t3-store");
      yield* fs.symlink(path.join(store, "t3"), storeLauncher);
      assert.isUndefined(
        yield* findOwnedLauncher({
          launchedAs: storeLauncher,
          versionsDir: path.join(linkedHome, "runtime/versions"),
        }),
      );
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));

      // On Windows, only the shim exactly as written is ours; a user's wrapper stays.
      const shimDir = path.join(root, "win-bin");
      const shim = path.join(shimDir, "t3.cmd");
      yield* fs.makeDirectory(shimDir);
      const windowsOwner = (contents: string) =>
        fs
          .writeFileString(shim, contents)
          .pipe(
            Effect.andThen(findOwnedLauncher({ launchedAs: exe, versionsDir })),
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(HostProcess.Environment, { PATH: shimDir }),
          );
      assert.equal(yield* windowsOwner(`@echo off\r\n"${exe}" %*`), shim);
      assert.isUndefined(yield* windowsOwner(`@echo off\r\nset FOO=1\r\n"${exe}" %*`));

      // npx can run another version than the installed one, so uninstall also reads the
      // recorded launchers: through a symlinked home, and dangling after a prune.
      const throughAlias = path.join(root, "bin/t3-alias");
      const pruned = path.join(root, "bin/t3-pruned");
      yield* fs.symlink(root, path.join(root, "alias"));
      yield* fs.symlink(path.join(root, "alias/runtime/versions/1.0.0/t3"), throughAlias);
      yield* fs.symlink(path.join(versionsDir, "0.9.0/t3"), pruned);
      // Another program inside a version is not a launcher.
      const sibling = path.join(root, "bin/t3-sibling");
      yield* fs.symlink(path.join(versionsDir, "1.0.0/node"), sibling);
      // The command link leads to a pruned version, so only its name says it is ours.
      const otherRoot = path.join(root, "pruned-home");
      const prunedCommand = path.join(root, "bin/t3-pruned-command");
      const prunedCommandLink = path.join(otherRoot, "runtime/versions/current/t3");
      yield* fs.makeDirectory(path.dirname(prunedCommandLink), { recursive: true });
      yield* fs.symlink(path.join(otherRoot, "runtime/versions/0.9.0/t3"), prunedCommandLink);
      yield* fs.symlink(prunedCommandLink, prunedCommand);
      yield* fs.writeFileString(path.join(otherRoot, "runtime/launchers"), `${prunedCommand}\n`);
      assert.deepStrictEqual(
        yield* findRecordedLaunchers(path.join(otherRoot, "runtime/versions")),
        [prunedCommand],
      );
      yield* fs.writeFileString(
        path.join(root, "runtime/launchers"),
        [
          ours,
          theirs,
          copy,
          viaCommandLink,
          throughAlias,
          pruned,
          sibling,
          path.join(root, "missing"),
        ].join("\n") + "\n",
      );
      for (const dir of [versionsDir, path.join(root, "alias/runtime/versions")]) {
        assert.deepStrictEqual(yield* findRecordedLaunchers(dir), [
          ours,
          viaCommandLink,
          throughAlias,
          pruned,
        ]);
      }

      // On Windows only an unedited t3.cmd is ours; a hand-edited wrapper belongs to the user.
      const cmd = path.join(root, "bin/t3.cmd");
      const edited = path.join(root, "bin/edited.cmd");
      yield* fs.writeFileString(cmd, `@echo off\r\n"${exe}" %*`);
      yield* fs.writeFileString(edited, `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${exe}" %*`);
      yield* fs.writeFileString(path.join(root, "runtime/launchers"), `${cmd}\r\n${edited}\r\n`);
      assert.deepStrictEqual(
        yield* findRecordedLaunchers(versionsDir).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
        [cmd],
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "t3 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(process.env.ComSpec ?? "cmd.exe", runtimeDir);
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
