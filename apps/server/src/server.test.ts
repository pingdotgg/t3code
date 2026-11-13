// @effect-diagnostics nodeBuiltinImport:off - the subprocess fixture uses the absolute CLI entrypoint.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "./config.ts";
import * as SpawnHost from "./process/SpawnHost.ts";
import * as ProcessRunner from "./processRunner.ts";
import { layerHttpServer, layerPlatformServices, layerProcessRunner } from "./server.ts";

const parentScript = "process.stdout.write(String(process.ppid))";

describe.each(["linux", "darwin", "win32"] as const)(
  "server process layer selection for %s",
  (platform) => {
    // quarantine: #30183 Windows cannot transfer the Unix stdio sockets used by the Linux helper.
    it.live.skipIf(platform === "linux" && HostProcess.Platform.defaultValue() === "win32")(
      "provides the selected spawner to HTTP consumers and the shared ProcessRunner",
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const parents = yield* Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const runner = yield* ProcessRunner.ProcessRunner;
            const getHostPids = yield* SpawnHost.HostPids;
            expect([...getHostPids()]).toEqual([]);
            const child = yield* spawner.spawn(
              ChildProcess.make(process.execPath, ["-e", parentScript]),
            );
            const httpParent = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
            expect(yield* child.exitCode).toBe(0);
            const result = yield* runner.run({
              command: process.execPath,
              args: ["-e", parentScript],
            });
            expect(result.code).toBe(0);
            expect([...getHostPids()]).toEqual(platform === "linux" ? [Number(httpParent)] : []);
            return { http: Number(httpParent), runner: Number(result.stdout), getHostPids };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              layerHttpServer.pipe(
                Layer.provideMerge(layerPlatformServices),
                Layer.provideMerge(layerProcessRunner),
              ),
            ),
            Effect.provideService(ServerConfig.ServerConfig, { ...config, host: "127.0.0.1" }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                T3CODE_DEV_MANAGED_POLICY_PATH: `${config.baseDir}/missing-policy.json`,
              }),
            ),
          );
          expect([...parents.getHostPids()]).toEqual([]);
          expect(parents.http).toBe(parents.runner);
          expect({
            httpHosted: parents.http !== process.pid,
            runnerHosted: parents.runner !== process.pid,
          }).toEqual({ httpHosted: platform === "linux", runnerHosted: platform === "linux" });
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "server-spawn-layers-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.merge(NetService.layer),
            ),
          ),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Arguments, [
            process.execPath,
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
        ),
    );
  },
);
