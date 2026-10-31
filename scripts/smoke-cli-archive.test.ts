import { assert, it } from "@effect/vitest";
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

const runArchive = (stdout: string, expectVersion: string) =>
  smokeCliArchive({ archive: "t3-test.tar.gz", expectVersion }).pipe(
    Effect.scoped,
    Effect.provide(archiveLayer),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        assert.ok(ChildProcess.isStandardCommand(command));
        const isVersion = command.args[0] === "--version";
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: isVersion ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
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

it.effect.each(["0.1.10", "0.1.1-nightly.20261020.3411"])(
  "rejects archive version %s when stable 0.1.1 is expected",
  (version) =>
    Effect.gen(function* () {
      const error = yield* runArchive(`t3 v${version}\n`, "0.1.1").pipe(Effect.flip);
      assert.equal(error._tag, "CliArchiveSmokeError");
      if (error._tag === "CliArchiveSmokeError") {
        assert.equal(error.step, "running --version");
        assert.include(error.detail, `t3 v${version}`);
      }
    }),
);
