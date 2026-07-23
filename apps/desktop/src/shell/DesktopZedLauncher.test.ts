import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopZedLauncher from "./DesktopZedLauncher.ts";

function makeDetachedHandle(onUnref: () => void): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("DesktopZedLauncher", () => {
  it("builds Zed's encoded SSH URI from the connection target", () => {
    assert.equal(
      DesktopZedLauncher.remoteZedSshUri({
        target: {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "declan",
          port: 2222,
        },
        path: "~/code/project alpha",
      }),
      "ssh://declan@devbox:2222/~/code/project%20alpha",
    );
    assert.equal(
      DesktopZedLauncher.remoteZedSshUri({
        target: {
          alias: "",
          hostname: "devbox.example.com",
          username: null,
          port: null,
        },
        path: "/srv/project",
      }),
      "ssh://devbox.example.com/srv/project",
    );
  });

  it.effect("launches and detaches the local Zed CLI for a remote workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-zed-" });
      const zedPath = path.join(binDir, "zed");
      yield* fileSystem.writeFileString(zedPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(zedPath, 0o755);

      let spawned: ChildProcess.StandardCommand | undefined;
      let didUnref = false;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawned = command;
            return makeDetachedHandle(() => {
              didUnref = true;
            });
          }),
        ),
      );
      const previousPath = process.env.PATH;
      process.env.PATH = binDir;

      yield* Effect.gen(function* () {
        const launcher = yield* DesktopZedLauncher.DesktopZedLauncher;
        yield* launcher.openRemoteWorkspace({
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: null,
            port: null,
          },
          path: "/srv/project",
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.env.PATH = previousPath;
          }),
        ),
        Effect.provide(
          DesktopZedLauncher.layer.pipe(
            Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer)),
          ),
        ),
      );

      assert.ok(spawned);
      assert.equal(spawned.command, "zed");
      assert.deepEqual(spawned.args, ["-r", "ssh://devbox/srv/project"]);
      assert.equal(spawned.options.detached, true);
      assert.equal(didUnref, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
