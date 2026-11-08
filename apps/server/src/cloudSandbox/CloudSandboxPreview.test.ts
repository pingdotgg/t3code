import { expect, it } from "@effect/vitest";
import { ManagedCloudSandboxResourceId, SandboxProfileId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Net from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import { ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import { PortDiscovery } from "../preview/PortScanner.ts";
import { CloudSandboxManager } from "./CloudSandboxManager.ts";
import { fixture } from "./CloudSandboxManager.testkit.ts";
import { discoveredPorts, make } from "./CloudSandboxPreview.ts";

it.effect("rejects undiscovered ports and preserves protected preview paths and tokens", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.manager;
    const resourceId = ManagedCloudSandboxResourceId.make("preview");
    yield* manager.provision({
      operationId: resourceId,
      profile: SandboxProfileId.make("fixture"),
      sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
    });
    const resourceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(resourceScope, Exit.void));
    let forwards = 0;
    const spawnedArgs: Array<ReadonlyArray<string>> = [];
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    let shares = 0;
    let blockReadiness = false;
    const readinessEntered = yield* Deferred.make<void>();
    const service = yield* make.pipe(
      Effect.provideService(CloudSandboxManager, {
        ...manager,
        withConnection: (_id, effect) =>
          Effect.gen(function* () {
            const connection = yield* manager.route(resourceId);
            return yield* effect(
              { alias: "verified", hostname: "verified.test", username: "sandbox", port: 22 },
              connection,
            ).pipe(Effect.provideService(Scope.Scope, resourceScope));
          }),
        execute: () => {
          shares++;
          return Effect.succeed({
            _tag: "host",
            port: { port: 5173, url: "https://app.provider.test/?token=private", isPublic: false },
          });
        },
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          blockReadiness && !request.url.endsWith("/preview-ports")
            ? Deferred.succeed(readinessEntered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([5173]))),
        ),
      ),
      Effect.provide(Net.layer),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              if (command._tag === "StandardCommand") {
                spawnedArgs.push(command.args.map(String));
              }
              forwards++;
              return handle;
            }),
            () =>
              Effect.sync(() => {
                forwards--;
              }),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
    );
    for (const url of [
      "http://localhost:9999/",
      "http://localhost:47773/",
      "http://arbitrary.test:5173/",
    ]) {
      expect((yield* service.open({ resourceId, url }).pipe(Effect.result))._tag).toBe("Failure");
    }
    expect(shares).toBe(0);
    const opened = yield* service.open({
      resourceId,
      url: "http://localhost:5173/app?n=1#section",
    });
    expect(opened.url).toBe("https://app.provider.test/app?token=private&n=1#section");
    expect(shares).toBe(1);
    const local = yield* service.open({
      resourceId,
      url: "http://localhost:5173/app?n=1",
      access: "local",
    });
    expect(new URL(local.url).hostname).toBe("127.0.0.1");
    expect(forwards).toBe(1);
    expect(spawnedArgs[0]?.find((arg) => arg.startsWith("BatchMode="))).toBe("BatchMode=yes");
    expect(spawnedArgs[0]).not.toContain("BatchMode=no");
    yield* service.open({ resourceId, url: "http://localhost:5173/", access: "local" });
    expect(forwards).toBe(2);
    yield* service.open({ resourceId, url: local.url, close: true });
    expect(forwards).toBe(1);
    blockReadiness = true;
    const interruptedFiber = yield* service
      .open({ resourceId, url: "http://localhost:5173/", access: "local" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(readinessEntered);
    yield* Fiber.interrupt(interruptedFiber);
    expect(forwards).toBe(1);
    blockReadiness = false;
    yield* service.open({ resourceId, url: "http://localhost:5173/", access: "local" });
    expect(forwards).toBe(2);
    yield* Scope.close(resourceScope, Exit.void);
    expect(forwards).toBe(0);
  }),
);

it.effect("excludes persisted ephemeral control server port from discoveredPorts", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      config.serverRuntimeStatePath,
      JSON.stringify({
        version: 1,
        pid: 1,
        port: 41234,
        origin: "http://127.0.0.1:41234",
        startedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const ports = yield* discoveredPorts().pipe(
      Effect.provideService(PortDiscovery, {
        scan: () =>
          Effect.succeed(
            [
              { port: 41234, processName: "node", pid: 1 },
              { port: 47773, processName: "ssh", pid: 2 },
              { port: 5173, processName: "vite", pid: 3 },
            ].map((server) => ({
              host: "127.0.0.1",
              url: `http://127.0.0.1:${server.port}`,
              terminal: null,
              ...server,
            })),
          ),
        subscribe: () => Effect.void,
        retain: Effect.void,
        registerTerminalProcesses: () => Effect.void,
        unregisterTerminal: () => Effect.void,
        trackAgent: () => () => {},
        stopServer: () => Effect.void,
      }),
    );
    expect(ports).toEqual([5173]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "cloud-preview-ports-",
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
