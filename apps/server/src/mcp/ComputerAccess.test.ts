import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerAccess from "./ComputerAccess.ts";
import { detectBrowsers, resolveCuaDriverPath } from "./ComputerAccess.ts";

const installDriver = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  const binary = path.join(directory, "cua-driver");
  yield* fs.writeFileString(binary, "#!/bin/sh\n");
  yield* fs.chmod(binary, 0o755);
  return binary;
});

describe("resolveCuaDriverPath", () => {
  it.effect("prefers the driver on PATH over the installer's default directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const onPath = yield* installDriver(path.join(root, "bin"));
      yield* installDriver(path.join(root, "home", ".local", "bin"));

      const resolved = yield* resolveCuaDriverPath().pipe(
        Effect.provideService(HostProcessEnvironment, {
          PATH: path.join(root, "bin"),
          HOME: path.join(root, "home"),
        }),
      );
      expect(resolved).toBe(onPath);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  // A GUI-launched server often lacks ~/.local/bin on PATH.
  it.effect("finds the installer's default directory when PATH lacks it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const installed = yield* installDriver(path.join(root, ".local", "bin"));

      const resolved = yield* resolveCuaDriverPath().pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: "", HOME: root }),
      );
      expect(resolved).toBe(installed);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports a missing driver as null", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();

      const resolved = yield* resolveCuaDriverPath().pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: "", HOME: root }),
      );
      expect(resolved).toBeNull();
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("detectBrowsers", () => {
  // The DevToolsActivePort file is the only signal: opening the port would
  // ask the user to allow a connection.
  it.effect("lists installed browsers with remote debugging on first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const support = path.join(home, "Library", "Application Support");
      yield* fs.makeDirectory(path.join(support, "Google", "Chrome"), { recursive: true });
      const helium = path.join(support, "net.imput.helium");
      yield* fs.makeDirectory(helium, { recursive: true });
      yield* fs.writeFileString(
        path.join(helium, "DevToolsActivePort"),
        "9222\n/devtools/browser/id",
      );

      const browsers = yield* detectBrowsers().pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: home }),
      );
      expect(
        browsers.map(({ id, inspectUrl, remoteDebugging, userDataDir }) => ({
          id,
          inspectUrl,
          remoteDebugging,
          userDataDir,
        })),
      ).toEqual([
        {
          id: "helium",
          inspectUrl: "helium://inspect/#remote-debugging",
          remoteDebugging: true,
          userDataDir: helium,
        },
        {
          id: "chrome",
          inspectUrl: "chrome://inspect/#remote-debugging",
          remoteDebugging: false,
          userDataDir: path.join(support, "Google", "Chrome"),
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("Cua permission requests", () => {
  // `cua-driver permissions grant` waits on the user for minutes, so setup
  // starts it in the background and polls status instead of blocking.
  it.effect("run in the background, restart cleanly, and report Cua's guidance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* installDriver(path.join(root, "bin"));
      // Without CuaDriver.app, as on CI, the driver is found on PATH.
      yield* Effect.gen(function* () {
        const grants: Array<Deferred.Deferred<number>> = [];
        const runner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              const exit = yield* Deferred.make<number>();
              if (input.args.join(" ") === "permissions grant") grants.push(exit);
              else yield* Deferred.succeed(exit, 0);
              const code = yield* Deferred.await(exit);
              return {
                stdout: code === 0 ? "" : "Timed out waiting on: Screen Recording.",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(code),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        });
        const access = yield* ComputerAccess.make.pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(root, root),
              ServerSettings.ServerSettingsService.layerTest(),
            ),
          ),
        );
        const requesting = Effect.map(access.status, (status) => status.cuaDriver);

        yield* access.runAction("request-cua-permissions");
        expect((yield* requesting).requestingPermissions).toBe(true);

        // Restart replaces the waiting request instead of stacking a second one.
        yield* access.runAction("request-cua-permissions");
        expect(grants).toHaveLength(2);
        yield* Deferred.succeed(grants[1]!, 1);
        yield* Effect.yieldNow;
        const failed = yield* requesting;
        expect(failed.requestingPermissions).toBe(false);
        expect(failed.permissionsFailed).toBe(true);

        yield* access.runAction("request-cua-permissions");
        yield* access.runAction("cancel-cua-permissions");
        const cancelled = yield* requesting;
        expect(cancelled.requestingPermissions).toBe(false);
        expect(cancelled.permissionsFailed).toBe(false);
      }).pipe(
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "bin"), HOME: root }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("Browser tab access", () => {
  // A settings poll or a new session must never wait on npm; browser setup
  // installs Chrome DevTools MCP as its own action.
  it.effect("checks and starts sessions without installing Chrome DevTools MCP", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const commands: Array<string> = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push([input.command, ...input.args].join(" "));
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      });
      const access = yield* ComputerAccess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(root, root),
            ServerSettings.layerTest({ enableAgentBrowserTabs: true }),
          ),
        ),
        Effect.provideService(HostProcessEnvironment, { PATH: "", HOME: root }),
      );

      expect((yield* access.status).browserToolInstalled).toBe(false);
      expect(yield* access.servers("thread-1")).toEqual([]);
      expect(commands).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
