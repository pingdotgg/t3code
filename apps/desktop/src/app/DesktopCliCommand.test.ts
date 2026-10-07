import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/** The service for a packaged Linux app whose home is `home`, with the launcher already written. */
const commandIn = (home: string, isPackaged = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = path.join(home, ".t3");
    yield* fs.makeDirectory(path.join(baseDir, "bin"), { recursive: true });
    yield* fs.writeFileString(path.join(baseDir, "bin", "t3"), "#!/bin/sh\n", { mode: 0o755 });
    const environment = DesktopEnvironment.DesktopEnvironment.of({
      path,
      platform: "linux",
      isPackaged,
      homeDirectory: home,
      baseDir,
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
    return yield* DesktopCliCommand.make.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
  });

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn(home);
      const link = path.join(home, ".local", "bin", "t3");

      expect(yield* command.state).toEqual({ supported: true, installedPath: null, onPath: false });
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "t3"));
      // Installing again leaves the one link in place.
      expect((yield* command.install).installedPath).toBe(link);

      const removed = yield* command.uninstall;
      expect(removed.installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);
      // The launcher itself stays for setup commands.
      expect(yield* fs.exists(path.join(home, ".t3", "bin", "t3"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces or removes a t3 it did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn(home);
      const theirs = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's t3\n");

      // It falls through to the next folder instead of overwriting.
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(path.join(home, "bin", "t3"));
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's t3\n");

      // With every folder taken, it says so instead.
      yield* fs.writeFileString(path.join(home, "bin", "t3"), "another t3\n");
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Another t3 command is already installed");
      expect((yield* command.state).installedPath).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("offers nothing for a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* commandIn(yield* fs.makeTempDirectoryScoped(), false);
      expect((yield* command.state).supported).toBe(false);
    }).pipe(Effect.scoped),
  );
});
