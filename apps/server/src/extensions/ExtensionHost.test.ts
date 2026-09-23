import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ExtensionError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { downloadRehArchive, ExtensionHost, parseProduct } from "./ExtensionHost.ts";
import { rehAsset } from "./extensionMetadata.ts";

const encodeExtensionError = Schema.encodeEffect(ExtensionError);

it.effect("returns a typed host error for malformed product.json", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(parseProduct("{"));
    expect(failure).toMatchObject({ _tag: "ExtensionError", operation: "host" });
    expect(failure).toHaveProperty("cause");
    expect(yield* encodeExtensionError(failure)).not.toHaveProperty("cause");
  }),
);

it.effect("returns a typed host error for null product.json", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(parseProduct("null"));
    expect(failure).toMatchObject({ _tag: "ExtensionError", operation: "host" });
  }),
);

it.effect("rejects a REH archive that differs from its pinned digest", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reh-integrity-test-" });
    const asset = rehAsset("linux", "x64")!;
    const failure = yield* Effect.flip(
      downloadRehArchive(asset, path.join(directory, "reh.tar.gz")),
    );
    expect(failure).toMatchObject({
      _tag: "ExtensionError",
      operation: "host",
      detail: "The REH archive did not match its pinned SHA-256.",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("changed archive"))),
          ),
        ),
      ),
    ),
  ),
);

it.effect("restarts the extension host after installing an extension", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const serverDir = path.join(config.vscodeDir, "server");
    yield* fs.makeDirectory(path.join(serverDir, "out"), { recursive: true });
    yield* fs.writeFileString(path.join(serverDir, "node"), "");
    yield* fs.writeFileString(path.join(serverDir, "out", "server-main.js"), "");
    yield* fs.writeFileString(
      path.join(serverDir, "product.json"),
      '{"commit":"1a46a584725d5dd330e0bcd7f5510f24990efcf2","quality":"stable"}',
    );

    let kills = 0;
    let hostStarts = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const host = command.args.includes("--host");
        if (host) hostStarts++;
        if (command.args.includes("--install-extension")) {
          const directory = path.join(config.vscodeDir, "extensions", "example.demo-1.0.0");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "package.json"),
            '{"publisher":"example","name":"demo","version":"1.0.0"}',
          );
        }
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: host ? Deferred.await(exit) : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(host),
          kill: () =>
            Effect.sync(() => {
              kills++;
            }).pipe(
              Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0))),
              Effect.asVoid,
            ),
          stdin: Sink.drain,
          stdout: host
            ? Stream.make(new TextEncoder().encode("Extension host agent listening on 1234"))
            : Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const http = HttpClient.make((request) => {
      const body = request.url.endsWith("/example/demo")
        ? JSON.stringify({
            files: {
              download: "https://open-vsx.org/file.vsix",
              sha256: "https://open-vsx.org/file.sha256",
            },
          })
        : request.url.endsWith(".sha256")
          ? "2e207c9f978e286abace80a8058492ee4ef41dccba55515580adf91fc3da847d"
          : "fake-vsix";
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
    });

    const installed = yield* Effect.gen(function* () {
      const host = yield* ExtensionHost;
      yield* host.connect;
      const installed = yield* host.install({
        source: { type: "openVsx", namespace: "example", name: "demo" },
      });
      yield* host.connect;
      return installed;
    }).pipe(
      Effect.provide(ExtensionHost.layer),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    expect(installed.id).toBe("example.demo");
    expect(kills).toBe(1);
    expect(hostStarts).toBe(2);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-reh-install-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("uninstalls an extension without a ready host", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const serverDir = path.join(config.vscodeDir, "server");
    yield* fs.makeDirectory(path.join(serverDir, "out"), { recursive: true });
    yield* fs.writeFileString(path.join(serverDir, "node"), "");
    yield* fs.writeFileString(path.join(serverDir, "out", "server-main.js"), "");

    let cliCalls = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag === "StandardCommand" && command.args.includes("--uninstall-extension"))
          cliCalls++;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );

    yield* ExtensionHost.pipe(
      Effect.flatMap((host) => host.uninstall("example.demo")),
      Effect.provide(ExtensionHost.layer),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected download")),
      ),
    );
    expect(cliCalls).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-reh-uninstall-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
