import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Schema, Sink, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import { runBackendProcess } from "./backendProcess.ts";

const bootstrap: DesktopBackendBootstrapValue = {
  mode: "desktop",
  noBrowser: true,
  port: 3773,
  t3Home: "/tmp/t3",
  host: "127.0.0.1",
  desktopBootstrapToken: "token",
  tailscaleServeEnabled: true,
  tailscaleServePort: 443,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function httpClientLayer(status: number) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
    ),
  );
}

function decodeBootstrap(raw: string) {
  return Schema.decodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))(raw);
}

describe("runBackendProcess", () => {
  it.effect("spawns the backend with fd3 bootstrap JSON and reports HTTP readiness", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      let bootstrapJson = "";
      let finishExit: (() => void) | undefined;
      let readyCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            if (command._tag === "StandardCommand") {
              const fd3 = command.options.additionalFds?.fd3;
              if (fd3?.type === "input" && fd3.stream) {
                bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
              }
            }

            return makeProcess({
              exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
                finishExit = () => resume(Effect.succeed(ChildProcessSpawner.ExitCode(0)));
              }),
            });
          }),
        ),
      );

      const exit = yield* runBackendProcess({
        executablePath: "/electron",
        entryPath: "/server/bin.mjs",
        cwd: "/server",
        env: { ELECTRON_RUN_AS_NODE: "1" },
        bootstrap,
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: true,
        onReady: () =>
          Effect.sync(() => {
            readyCount += 1;
            finishExit?.();
          }),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, httpClientLayer(200))));

      assert.equal(exit.code, 0);
      assert.equal(readyCount, 1);
      assert.isDefined(spawnedCommand);
      if (spawnedCommand?._tag === "StandardCommand") {
        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );
      }
      assert.deepEqual(yield* decodeBootstrap(bootstrapJson), bootstrap);
    }),
  );

  it.effect("inherits child output when captureOutput is false", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      let finishExit: (() => void) | undefined;
      let readyCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            spawnedCommand = command;
            return makeProcess({
              exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
                finishExit = () => resume(Effect.succeed(ChildProcessSpawner.ExitCode(0)));
              }),
            });
          }),
        ),
      );

      const exit = yield* runBackendProcess({
        executablePath: "/electron",
        entryPath: "/server/bin.mjs",
        cwd: "/server",
        env: { ELECTRON_RUN_AS_NODE: "1" },
        bootstrap,
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: false,
        onReady: () =>
          Effect.sync(() => {
            readyCount += 1;
            finishExit?.();
          }),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, httpClientLayer(200))));

      assert.equal(exit.code, 0);
      assert.equal(readyCount, 1);
      assert.isDefined(spawnedCommand);
      if (spawnedCommand?._tag === "StandardCommand") {
        assert.equal(spawnedCommand.options.stdout, "inherit");
        assert.equal(spawnedCommand.options.stderr, "inherit");
      }
    }),
  );
});
