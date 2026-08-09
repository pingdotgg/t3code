import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootServiceWindows from "./bootServiceWindows.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_PID_FILE,
} from "./serviceProtocol.ts";

const plan = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  launcherPath: "C:\\Users\\me\\.t3\\runtime\\service-launcher.mjs",
  baseDir: "C:\\Users\\me\\.t3",
  logPath: "C:\\Users\\me\\.t3\\userdata\\logs\\boot-service.log",
  unitPath:
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\T3 Code Server.lnk",
  startupScriptPath: "C:\\Users\\me\\.t3\\runtime\\service-startup.ps1",
  shortcutScriptPath: "C:\\Users\\me\\.t3\\runtime\\service-shortcut.ps1",
} as const;

it("escapes a quote in a PowerShell literal by doubling it", () => {
  expect(BootServiceWindows.quotePowerShellLiteral("C:\\Users\\o'brien\\.t3")).toBe(
    "'C:\\Users\\o''brien\\.t3'",
  );
});

it("starts the launcher with no window and redirects both streams to the log", () => {
  const script = BootServiceWindows.renderStartupScript(plan);

  expect(script).toContain("$startInfo.CreateNoWindow = $true");
  expect(script).toContain("$startInfo.UseShellExecute = $false");
  // Doubling the outer quote is what carries a fully quoted command through cmd.
  expect(script).toContain(
    `/c ""${plan.nodePath}" "${plan.launcherPath}" >> "${plan.logPath}" 2>&1"`,
  );
});

it("tells the launcher to supervise itself, because nothing else will", () => {
  expect(BootServiceWindows.renderStartupScript(plan)).toContain(
    "$env:T3_SERVICE_SELF_SUPERVISE = '1'",
  );
});

it("names the window so the blink at sign-in does not look like malware", () => {
  const script = BootServiceWindows.renderStartupScript(plan);
  const shortcut = BootServiceWindows.renderShortcutScript(plan);

  expect(script).toContain("$Host.UI.RawUI.WindowTitle = 'T3 Code Server'");
  expect(shortcut).toContain("$shortcut.Description = 'T3 Code Server, started at sign-in'");
});

it("points the shortcut at a hidden PowerShell running the startup script", () => {
  const shortcut = BootServiceWindows.renderShortcutScript(plan);

  expect(shortcut).toContain("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(shortcut).toContain(`-WindowStyle Hidden -File "${plan.startupScriptPath}"`);
  expect(shortcut).toContain("$shortcut.WindowStyle = 7");
});

it("reads both findings out of the probe output", () => {
  expect(BootServiceWindows.parseProbeOutput("shell=True\r\ndisabled=False\r\n")).toEqual({
    shellRunning: true,
    entryDisabled: false,
  });
  expect(BootServiceWindows.parseProbeOutput("shell=False\ndisabled=True\n")).toEqual({
    shellRunning: false,
    entryDisabled: true,
  });
});

it("refuses to guess when the probe output is unreadable", () => {
  // Defaulting to false would read as "the entry is not disabled", so a probe
  // that never ran would look exactly like one that passed.
  expect(BootServiceWindows.parseProbeOutput("")).toBeUndefined();
  expect(BootServiceWindows.parseProbeOutput("shell=True\n")).toBeUndefined();
});

it("spots a percent sign, which the command shell would rewrite silently", () => {
  expect(
    BootServiceWindows.findPercentInPaths([
      ["the Node executable", "C:\\node.exe"],
      ["the data directory", "C:\\pct %TEMP% dir\\launcher.mjs"],
    ]),
  ).toBe("the data directory");
  expect(
    BootServiceWindows.findPercentInPaths([["the Node executable", "C:\\node.exe"]]),
  ).toBeUndefined();
});

const makeHarness = Effect.fn("test.make_windows_boot_service_harness")(function* (
  platform: NodeJS.Platform = "win32",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-win-test-" });
  const appData = path.join(home, "AppData", "Roaming");
  const baseDir = path.join(home, ".t3");
  const sourceLauncher = path.join(home, "service-launcher.mjs");
  const runtimeDir = path.join(baseDir, "runtime");
  const statePath = path.join(runtimeDir, "service-state.json");
  const startupScriptPath = path.join(runtimeDir, "service-startup.ps1");
  const shortcutPath = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    BootServiceWindows.SHORTCUT_FILE,
  );
  yield* fs.writeFileString(sourceLauncher, "export {};\n");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3");
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "export {};\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const pidPath = path.join(runtimeDir, SERVICE_PID_FILE);
  const stopRequestPath = path.join(runtimeDir, ".service-stop-request");
  const commands: string[] = [];
  const control = {
    shell: "True",
    disabled: "False",
    failCommand: undefined as string | undefined,
    /** Set to false to model a launcher that never answers the stop request. */
    launcherStopsOnRequest: true,
  };
  // The fake stands in for PowerShell: creating and removing the shortcut is a
  // plain file write here, which is all the module observes.
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const command = `${input.command} ${input.args.join(" ")}`;
        commands.push(command);
        const action = input.args.at(-1);
        if (command.includes("service-startup")) {
          // Standing in for the logon script: a launcher starts and claims the
          // pid file, exactly as the real one does before anything else.
          yield* fs.makeDirectory(runtimeDir, { recursive: true });
          yield* fs.writeFileString(pidPath, `${process.pid}\n`);
        }
        if (command.includes("service-shortcut")) {
          if (action === "Install") {
            yield* fs.makeDirectory(path.dirname(shortcutPath), { recursive: true });
            yield* fs.writeFileString(shortcutPath, "shortcut");
          }
          if (action === "Remove") {
            yield* fs.remove(shortcutPath, { force: true });
          }
        }
        return {
          stdout:
            action === "Probe"
              ? `shell=${control.shell}\ndisabled=${control.disabled}\n`
              : input.args[1] === "--version"
                ? "t3 v1.2.3\n"
                : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(command === control.failCommand ? 1 : 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }).pipe(Effect.orDie),
  });

  const service = yield* BootServiceWindows.make({
    baseDir,
    logsDir: path.join(baseDir, "userdata", "logs"),
    cliVersion: "1.2.3",
    host: { execPath: "C:\\node.exe", launcherSourcePath: sourceLauncher },
    stopRequestTimeout: Duration.millis(30),
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, platform),
        Layer.succeed(HostProcessExecutablePath, "C:\\node.exe"),
        Layer.succeed(HostProcessArguments, ["C:\\node.exe", path.join(home, "bin.mjs")]),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { APPDATA: appData } })),
      ),
    ),
  );
  // Stands in for a running launcher. The real one drops its pid file when it
  // stops, and that disappearance is the only thing the CLI accepts as proof.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.millis(5));
        if (!control.launcherStopsOnRequest) continue;
        const asked = yield* fs.exists(stopRequestPath).pipe(Effect.orElseSucceed(() => false));
        if (!asked) continue;
        yield* fs.remove(stopRequestPath, { force: true }).pipe(Effect.ignore);
        yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore);
      }
    }),
  );

  return {
    service,
    fs,
    statePath,
    startupScriptPath,
    shortcutPath,
    pidPath,
    commands,
    control,
  };
});

it.layer(NodeServices.layer)("windows boot service", (it) => {
  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, shortcutPath } = yield* makeHarness();
      const installed = yield* service.install;

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(installed.launcherPath)).toBe("export {};\n");
      expect(yield* fs.exists(shortcutPath)).toBe(true);
      expect((yield* service.status).current).toBe(true);
      expect((yield* service.status).kind).toBe("win32-startup-shortcut");

      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
    }).pipe(TestClock.withLive),
  );

  it.effect("creates the shortcut only after the Startup folder passes its probe", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness();
      yield* service.install;

      const actions = commands
        .filter((command) => command.includes("service-shortcut.ps1"))
        .map((command) => command.split(" ").at(-1));
      expect(actions).toEqual(["Probe", "Install"]);
    }).pipe(TestClock.withLive),
  );

  it.effect("goes stale when the startup script drifts from what it should be", () =>
    Effect.gen(function* () {
      const { service, fs, startupScriptPath } = yield* makeHarness();
      yield* service.install;
      expect((yield* service.status).current).toBe(true);

      yield* fs.writeFileString(startupScriptPath, "# edited by hand\n");
      expect((yield* service.status).current).toBe(false);
    }).pipe(TestClock.withLive),
  );

  it.effect("refuses to install over an entry switched off in Windows Settings", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      control.disabled = "True";

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(String(error.cause)).toContain("Startup apps");
    }).pipe(TestClock.withLive),
  );

  it.effect("reinstalls over a running launcher only after it has actually gone", () =>
    Effect.gen(function* () {
      const { service, fs, pidPath } = yield* makeHarness();
      yield* service.install;
      // The stand-in launcher claimed the pid file when the startup script ran.
      expect(yield* fs.exists(pidPath)).toBe(true);

      yield* service.install;
      expect((yield* service.status).current).toBe(true);
    }).pipe(TestClock.withLive),
  );

  it.effect("refuses to reinstall when the running launcher will not stop", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness();
      yield* service.install;
      // Writing over a launcher we cannot confirm dead would leave two servers
      // on one database, so this must fail rather than carry on.
      control.launcherStopsOnRequest = false;

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(error.message).toContain("did not exit");
    }).pipe(TestClock.withLive),
  );

  it.effect("removes the shortcut without needing the generated script", () =>
    Effect.gen(function* () {
      const { service, fs, shortcutPath, startupScriptPath } = yield* makeHarness();
      yield* service.install;
      // A user who cleared the runtime directory still needs uninstall to work,
      // because the shortcut is the thing they asked to be rid of.
      yield* fs.remove(startupScriptPath, { force: true });

      expect(yield* service.uninstall).toBe(true);
      expect(yield* fs.exists(shortcutPath)).toBe(false);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails closed off Windows", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("linux");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }).pipe(TestClock.withLive),
  );
});
