import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

it("keeps systemd pinned to the stable launcher rather than a versioned server", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    launcherPath: "/home/theo/.t3/runtime/service-launcher.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain("ExecStart=/usr/bin/node /home/theo/.t3/runtime/service-launcher.mjs");
  expect(unit).toContain("KillMode=mixed");
  expect(unit).not.toContain("versions/1.2.3");
});

it("survives the kernel OOM-killing a greedy agent child", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    launcherPath: "/home/theo/.t3/runtime/service-launcher.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain("OOMPolicy=continue");
});

const macPlan = {
  nodePath: "/opt/homebrew/bin/node",
  launcherPath: "/Users/theo/.t3/runtime/service-launcher.mjs",
  baseDir: "/Users/theo/.t3",
  logPath: "/Users/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/Users/theo/Library/LaunchAgents/com.t3tools.t3code.service.plist",
};

it("keeps launchd pinned to the stable launcher rather than a versioned server", () => {
  const plist = BootService.renderBootServicePlist(macPlan, { homeDir: "/Users/theo" });

  expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
  expect(plist).toContain("<string>/Users/theo/.t3/runtime/service-launcher.mjs</string>");
  expect(plist).not.toContain("versions/1.2.3");
});

it("restarts the launch agent on the systemd cadence", () => {
  const plist = BootService.renderBootServicePlist(macPlan, { homeDir: "/Users/theo" });

  expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>5</integer>");
  expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>90</integer>");
});

it("appends both stdio streams to the boot service log", () => {
  const plist = BootService.renderBootServicePlist(macPlan, { homeDir: "/Users/theo" });

  expect(plist).toContain(
    "<key>StandardOutPath</key>\n  <string>/Users/theo/.t3/userdata/logs/boot-service.log</string>",
  );
  expect(plist).toContain(
    "<key>StandardErrorPath</key>\n  <string>/Users/theo/.t3/userdata/logs/boot-service.log</string>",
  );
});

it("escapes XML in host paths", () => {
  const plist = BootService.renderBootServicePlist(
    { ...macPlan, baseDir: "/Users/theo/T3 & <Co>" },
    { homeDir: "/Users/theo" },
  );

  expect(plist).toContain("<string>/Users/theo/T3 &amp; &lt;Co&gt;</string>");
});

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  usePinnedLauncher = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const sourceLauncher = path.join(home, "service-launcher.mjs");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  yield* fs.writeFileString(sourceLauncher, "export {};\n");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3");
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "export {};\n");
  yield* fs.writeFileString(
    path.join(path.dirname(runtime.entryPath), "service-launcher.mjs"),
    "export const source = 'pinned runtime';\n",
  );
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const timeouts = new Map<string, unknown>();
  const control: { failCommand: string | undefined } = { failCommand: undefined };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        const command = `${input.command} ${input.args.join(" ")}`;
        commands.push(command);
        timeouts.set(command, input.timeout);
        return {
          stdout: input.args[1] === "--version" ? "t3 v1.2.3\n" : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(command === control.failCommand ? 1 : 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const service = yield* BootService.make({
    baseDir,
    logsDir: path.join(baseDir, "userdata", "logs"),
    cliVersion: "1.2.3",
    host: {
      execPath: "/usr/bin/node",
      ...(usePinnedLauncher ? {} : { launcherSourcePath: sourceLauncher }),
    },
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessUserId, 501),
        Layer.succeed(HostProcessExecutablePath, "/usr/bin/node"),
        Layer.succeed(HostProcessArguments, ["/usr/bin/node", path.join(home, "bin.mjs")]),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
      ),
    ),
  );
  return { service, fs, statePath, commands, timeouts, control };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts } = yield* makeHarness();
      const plan = yield* service.install;

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.launcherPath)).toBe("export {};\n");
      expect((yield* service.status).current).toBe(true);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
      expect(timeouts.get("systemctl --user disable --now t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect("copies the launcher from the prepared pinned runtime", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("linux", true);
      const plan = yield* service.install;

      expect(yield* fs.readFileString(plan.launcherPath)).toBe(
        "export const source = 'pinned runtime';\n",
      );
    }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install;
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      commands.length = 0;

      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUpdatePendingError");
      expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("fails closed on Windows", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("win32");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts } = yield* makeHarness("darwin");
      const plan = yield* service.install;

      expect(plan.unitPath.endsWith("Library/LaunchAgents/com.t3tools.t3code.service.plist")).toBe(
        true,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.launcherPath)).toBe("export {};\n");
      expect((yield* service.status).current).toBe(true);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
      expect(timeouts.get("launchctl bootout --wait gui/501/com.t3tools.t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect("restarts the launch agent when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness("darwin");
      yield* service.install;
      const plistPath = (yield* service.status).unitPath;
      commands.length = 0;
      control.failCommand = `launchctl bootstrap gui/501 ${plistPath}`;

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
        "launchctl enable gui/501/com.t3tools.t3code.service",
        `launchctl bootstrap gui/501 ${plistPath}`,
        `launchctl bootstrap gui/501 ${plistPath}`,
      ]);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install;
      control.failCommand = "launchctl bootout --wait gui/501/com.t3tools.t3code.service";

      yield* service.install;
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("restarts without overwriting a pending remote update on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness("darwin");
      yield* service.install;
      const plistPath = (yield* service.status).unitPath;
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned test document.
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      commands.length = 0;

      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUpdatePendingError");
      expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
      expect(commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
        `launchctl bootstrap gui/501 ${plistPath}`,
      ]);
    }),
  );
});
