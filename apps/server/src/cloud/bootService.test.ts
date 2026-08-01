import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make, renderBootServiceUnit } from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";

it("keeps systemd pinned to the stable launcher rather than a versioned server", () => {
  const unit = renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    launcherPath: "/home/theo/.t3/runtime/service-launcher.mjs",
    statePath: "/home/theo/.t3/runtime/service-state.json",
    activeVersion: "1.2.3",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain("ExecStart=/usr/bin/node /home/theo/.t3/runtime/service-launcher.mjs");
  expect(unit).toContain("KillMode=control-group");
  expect(unit).not.toContain("versions/1.2.3");
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect("writes launcher state only after the selected runtime exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
      const baseDir = path.join(home, ".t3");
      const logsDir = path.join(baseDir, "userdata", "logs");
      const sourceLauncher = path.join(home, "service-launcher.mjs");
      yield* fs.writeFileString(sourceLauncher, "export {};\n");
      const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
      yield* fs.writeFileString(runtime.entryPath, "export {};\n");
      yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

      const commands: string[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push(`${input.command} ${input.args.join(" ")}`);
            return {
              stdout: input.args[1] === "--version" ? "t3 v1.2.3\n" : "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });
      const service = yield* make({
        baseDir,
        logsDir,
        cliVersion: "1.2.3",
        host: {
          execPath: "/usr/bin/node",
          cliEntryPath: path.join(home, "bin.mjs"),
          launcherSourcePath: sourceLauncher,
        },
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessExecutablePath, "/usr/bin/node"),
            Layer.succeed(HostProcessArguments, ["/usr/bin/node", path.join(home, "bin.mjs")]),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
          ),
        ),
      );

      const plan = yield* service.install;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the launcher document bytes.
      expect(JSON.parse(yield* fs.readFileString(plan.statePath))).toEqual({
        schemaVersion: 1,
        launcherProtocol: 1,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.launcherPath)).toBe("export {};\n");
      expect(commands).toContain("systemctl --user restart t3code.service");
      expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
    }),
  );
});
