import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ExtensionInfo } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import {
  EXTENSION_DEVELOPMENT_SKILL,
  EXTENSION_DEVELOPMENT_REFERENCE,
} from "@t3tools/provider-core/server/extensionDevelopmentSkill";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ExtensionHostAdapter from "./ExtensionHostAdapter.ts";
import * as ExtensionService from "./ExtensionService.ts";

const unexpectedHostOperation = async () => {
  throw new Error(
    "Installing development guidance must not start an extension or call host services.",
  );
};

const dependencies = Layer.mergeAll(
  Layer.mock(ExtensionHostAdapter.ExtensionHostAdapter)({
    platform: "linux",
    launch: unexpectedHostOperation,
    installPackage: unexpectedHostOperation,
    call: unexpectedHostOperation,
  }),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({ awaitCommandReady: Effect.void }),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
    latestApplicationSequence: Effect.succeed(0),
    streamApplicationEvents: () => Stream.never,
  }),
);

it.layer(NodeServices.layer)("extension development guidance", (it) => {
  it.effect("installs the skill and complete guide at startup and refreshes them on restart", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(config.stateDir, "skills", "t3-extension-development");
      const skill = path.join(root, "SKILL.md");
      const guide = path.join(root, "references", "api.md");
      const start = Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ExtensionService.ExtensionService;
          expect(yield* fs.readFileString(skill)).toBe(EXTENSION_DEVELOPMENT_SKILL);
          expect(yield* fs.readFileString(guide)).toBe(EXTENSION_DEVELOPMENT_REFERENCE);
          expect(yield* service.developmentSkill).toMatchObject({
            path: skill,
            referencePath: guide,
          });
        }).pipe(Effect.provide(ExtensionService.layer.pipe(Layer.provide(dependencies)))),
      );
      yield* start;
      yield* fs.writeFileString(skill, "old installed skill");
      yield* fs.remove(guide);
      yield* start;
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-extension-skill-" })),
    ),
  );
});

it.live("publishes disable and uninstall changes to every connected client", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const executable = yield* HostProcess.ExecutablePath;
    const worker = yield* path.fromFileUrl(new URL("./hostMain.ts", import.meta.url));
    const source = path.join(config.stateDir, "fixture");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.writeFileString(
      path.join(source, "t3-extension.json"),
      JSON.stringify({
        id: "test.sync",
        name: "Sync",
        description: "Cross-client lifecycle fixture",
        version: "1.0.0",
        apiVersion: 1,
        main: "main.mjs",
      }),
    );
    yield* fs.writeFileString(path.join(source, "main.mjs"), "export default {activate(){}};");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ExtensionService.ExtensionService;
        const clients = [
          yield* Queue.unbounded<readonly ExtensionInfo[]>(),
          yield* Queue.unbounded<readonly ExtensionInfo[]>(),
        ];
        for (const client of clients) {
          yield* service.changes.pipe(
            Stream.runForEach((snapshot) => Queue.offer(client, snapshot)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(client)).toEqual([]);
        }
        const next = (predicate: (snapshot: readonly ExtensionInfo[]) => boolean) =>
          Effect.forEach(clients, (client) =>
            Stream.fromQueue(client).pipe(Stream.filter(predicate), Stream.runHead),
          );
        const invalid = yield* Effect.flip(
          service.install({ source: path.join(source, "missing"), sourceType: "local" }),
        );
        expect(invalid.reason).toBe("runtime-failed");
        expect(invalid.detail).toBeUndefined();
        expect(invalid.cause).toMatchObject({ code: "ENOENT" });
        yield* service.install({ source, sourceType: "local" });
        yield* next((snapshot) => snapshot[0]?.status === "running");
        yield* service.manage({ id: "test.sync", action: "disable" });
        yield* next(
          (snapshot) => snapshot[0]?.enabled === false && snapshot[0]?.status === "disabled",
        );
        yield* service.manage({ id: "test.sync", action: "enable" });
        yield* next((snapshot) => snapshot[0]?.status === "running");
        yield* service.manage({ id: "test.sync", action: "uninstall" });
        yield* next((snapshot) => snapshot.length === 0);
        const homeRelative = yield* service
          .install({ source: "~/fixture", sourceType: "local" })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, config.stateDir));
        expect(homeRelative[0]?.source).toBe(yield* fs.realPath(source));
        yield* next((snapshot) => snapshot[0]?.status === "running");
        yield* service.manage({ id: "test.sync", action: "uninstall" });
        yield* next((snapshot) => snapshot.length === 0);
      }).pipe(
        Effect.provide(
          ExtensionService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ExtensionHostAdapter.ExtensionHostAdapter)({
                  platform,
                  launch: async () => ({ command: executable, args: [worker] }),
                  installPackage: unexpectedHostOperation,
                  call: unexpectedHostOperation,
                }),
                Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
                  awaitCommandReady: Effect.void,
                }),
                Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
                  latestApplicationSequence: Effect.succeed(0),
                  streamApplicationEvents: () => Stream.never,
                }),
              ),
            ),
          ),
        ),
      ),
    );
    yield* program;
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-extension-sync-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
