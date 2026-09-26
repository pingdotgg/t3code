import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import { posixLauncherScript, repointLauncher, resolveLauncherPath } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("replaces an old launcher symlink with a script for the new version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.isTrue(Option.isNone(yield* fs.readLink(launcher).pipe(Effect.option)));
      assert.equal(yield* fs.readFileString(launcher), posixLauncherScript(newExe));
      // The rename replaced the link. It did not write into the old executable.
      assert.equal(yield* fs.readFileString(oldExe), "");
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("repoints the launcher script that runs this executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The real path, because the launcher is found by its real path.
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" }));
      const versionsDir = path.join(root, "it's home/runtime/versions");
      const oldExe = path.join(versionsDir, "1.0.0/t3");
      const newExe = path.join(versionsDir, "2.0.0/t3");
      const bin = path.join(root, "bin");
      const launcher = path.join(bin, "t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(launcher, posixLauncherScript(oldExe));

      // The script execs the executable by absolute path, so argv0 is the executable.
      const repointed = yield* repointLauncher({
        launchedAs: oldExe,
        versionsDir,
        targetEntryPath: newExe,
      }).pipe(
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${bin}`,
        }),
      );

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readFileString(launcher), posixLauncherScript(newExe));
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the script in ~/.local/bin or through a PATH symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" }));
      const versionsDir = path.join(root, "runtime/versions");
      const oldExe = path.join(versionsDir, "1.0.0/t3");
      const newExe = path.join(versionsDir, "2.0.0/t3");
      const home = path.join(root, "home");
      const defaultLauncher = path.join(home, ".local/bin/t3");
      const customLauncher = path.join(root, "custom/t3");
      const linkOnPath = path.join(root, "path/t3");
      for (const file of [oldExe, newExe, defaultLauncher, customLauncher, linkOnPath]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      }
      for (const file of [oldExe, newExe]) yield* fs.writeFileString(file, "");
      const repoint = (environment: Record<string, string>) =>
        repointLauncher({ launchedAs: oldExe, versionsDir, targetEntryPath: newExe }).pipe(
          Effect.provideService(HostProcessEnvironment, environment),
        );

      // install.sh's default folder, not on PATH.
      yield* fs.writeFileString(defaultLauncher, posixLauncherScript(oldExe));
      const fromHome = yield* repoint({ HOME: home, PATH: path.join(root, "missing") });
      assert.deepStrictEqual(Option.getOrUndefined(fromHome), defaultLauncher);
      assert.equal(yield* fs.readFileString(defaultLauncher), posixLauncherScript(newExe));

      // A symlink on PATH to a script in a folder that is not on PATH.
      yield* fs.writeFileString(customLauncher, posixLauncherScript(oldExe));
      yield* fs.symlink(customLauncher, linkOnPath);
      const throughLink = yield* repoint({ PATH: path.dirname(linkOnPath) });
      assert.deepStrictEqual(Option.getOrUndefined(throughLink), customLauncher);
      assert.equal(yield* fs.readFileString(customLauncher), posixLauncherScript(newExe));
      assert.equal(yield* fs.readLink(linkOnPath), customLauncher);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a hand-written wrapper alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const versionsDir = path.join(root, "runtime/versions");
      const oldExe = path.join(versionsDir, "1.0.0/t3");
      const newExe = path.join(versionsDir, "2.0.0/t3");
      const wrapper = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe, wrapper]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      }
      for (const file of [oldExe, newExe]) yield* fs.writeFileString(file, "");
      const contents = `#!/bin/sh\nexport T3_EXTRA=1\n${posixLauncherScript(oldExe).split("\n")[1]}\n`;
      yield* fs.writeFileString(wrapper, contents);

      const repointed = yield* repointLauncher({
        launchedAs: oldExe,
        versionsDir,
        targetEntryPath: newExe,
      }).pipe(Effect.provideService(HostProcessEnvironment, { PATH: path.dirname(wrapper) }));

      assert.equal(repointed._tag, "None");
      assert.equal(yield* fs.readFileString(wrapper), contents);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      // Another install's versions tree: same shape, different home.
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "./bin/t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});
