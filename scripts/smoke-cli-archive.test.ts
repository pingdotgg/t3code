import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { smokeCliArchive } from "./smoke-cli-archive.ts";

const archiveLayer = Layer.mergeAll(
  Path.layer,
  FileSystem.layerNoop({
    makeTempDirectory: () => Effect.succeed("/cli-smoke"),
    readDirectory: () => Effect.succeed(["t3-test"]),
    exists: () => Effect.succeed(true),
    realPath: (path) => Effect.succeed(path),
    remove: () => Effect.void,
  }),
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: () => Effect.succeed(false),
    reserveLoopbackPort: () => Effect.succeed(47700),
    findAvailablePort: () => Effect.succeed(47700),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
    ),
  ),
);

const runArchive = (stdout: string, expectVersion: string, versionExitCode = 0) =>
  smokeCliArchive({ archive: "t3-test.tar.gz", expectVersion }).pipe(
    Effect.scoped,
    Effect.provide(archiveLayer),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        assert.ok(ChildProcess.isStandardCommand(command));
        const output =
          command.command === "ldd"
            ? `\tlibatomic.so.1 => ${command.args[0]?.replace(/t3$/, "lib/libatomic.so.1")} (0x7f0000000000)\n`
            : stdout;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(command.args[0] === "--version" ? versionExitCode : 0),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(output)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

it.effect.each(["0.1.1", "0.1.1-nightly.20261020.3411"])(
  "accepts the exact archive version %s",
  (version) => runArchive(`t3 v${version}\n`, version),
);

const expectVersionRejection = (stdout: string, versionExitCode: number, detail: string) =>
  Effect.gen(function* () {
    const error = yield* runArchive(stdout, "0.1.1", versionExitCode).pipe(Effect.flip);
    assert.equal(error._tag, "CliArchiveSmokeError");
    if (error._tag === "CliArchiveSmokeError") {
      assert.equal(error.step, "running --version");
      assert.include(error.detail, detail);
    }
  });

it.effect.each(["0.1.10", "0.1.1-nightly.20261020.3411"])(
  "rejects archive version %s when stable 0.1.1 is expected",
  (version) => expectVersionRejection(`t3 v${version}\n`, 0, `t3 v${version}`),
);

it.effect("rejects a matching archive version when --version exits nonzero", () =>
  expectVersionRejection("t3 v0.1.1\n", 1, "exit 1"),
);
