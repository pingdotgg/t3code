import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerShutdown from "../serverShutdown.ts";
import { ServiceLauncherClient } from "./serviceLauncherClient.ts";
import { make } from "./selfUpdate.ts";

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
      const order: string[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            if (input.command === "npm") {
              order.push("install");
              const prefix = input.args[input.args.indexOf("--prefix") + 1];
              if (prefix === undefined) return yield* Effect.die("missing npm prefix");
              const entry = path.join(prefix, "node_modules", "t3", "dist", "bin.mjs");
              yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
              yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
              return {
                stdout: "",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }
            order.push("preflight");
            return {
              // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
              stdout: JSON.stringify({
                status: "ready",
                version: "1.1.0",
                launcherProtocol: 1,
              }),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });
      const launcher = ServiceLauncherClient.of({
        managed: true,
        trial: false,
        awaitActivation: Effect.void,
        requestUpdate: (input) =>
          Effect.sync(() => {
            order.push("accept");
            return {
              id: "launcher-id",
              ...input,
              status: "pending" as const,
              requestedAt: "2026-08-01T00:00:00.000Z",
            };
          }),
        prepareTrial: Effect.succeed(Option.none()),
        latestOutcome: Effect.succeed(Option.none()),
      });
      const shutdown = yield* ServerShutdown.make;
      const selfUpdate = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(ServiceLauncherClient, launcher),
        Effect.provideService(ServerShutdown.ServerShutdown, shutdown),
        Effect.provideService(HostProcessExecutablePath, "/usr/bin/node"),
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );

      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" });
      expect(result).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["install", "preflight", "accept"]);
    }),
  );
});
