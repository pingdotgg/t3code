// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cross-process launcher contention uses real filesystem leases and IPC barriers.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { CliError } from "effect/cli";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  acquireServiceAccountLock,
  type ControlAclHooks,
  Launcher,
  probeServiceLauncher,
  readServiceState,
  serviceAccountControlRoot,
  serviceControlDir,
  serviceTaskName,
  serviceTaskNamePath,
  windowsSystem32Binary,
  writeServiceState,
} from "../serviceLauncher.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

const leaseObserver = vi.hoisted(() => ({ contended: (_destination: string) => {} }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      try {
        return actual.renameSync(...args);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        const existingTargetOnWindows =
          (code === "EPERM" || code === "EACCES") && actual.existsSync(args[1]);
        if (["EEXIST", "ENOTEMPTY"].includes(code) || existingTargetOnWindows) {
          leaseObserver.contended(String(args[1]));
        }
        throw error;
      }
    },
  };
});

const trustedTestAcl: ControlAclHooks = {
  restrictPathAcl: async () => undefined,
  verifyPathAcl: async () => true,
};

const windowsTaskOptions = {
  userId: "PC\\theo",
  homeDir: "C:\\Users\\theo",
  conhostPath: "C:\\Windows\\System32\\conhost.exe",
};

it("reads the served T3 home back out of a rendered unit, plist, or task", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/versions/1.2.3/t3`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(BootService.renderBootServiceUnit(plan("/home/theo/.t3"))),
  ).toBe("/home/theo/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/theo/T3 Data/100%")),
    ),
  ).toBe("/home/theo/T3 Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/theo/a&b"), {
        homeDir: "/Users/theo",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/theo/a&b");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceTask(plan('C:\\Users\\theo\\T3 "a&b"\\'), windowsTaskOptions),
    ),
  ).toBe('C:\\Users\\theo\\T3 "a&b"\\');
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
});

it("parses Task Scheduler /Query /XML exports with XML entities, multiline whitespace, and unquoted arguments", () => {
  const exportedXml = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Actions Context=&quot;Author&quot;>",
    "    <Exec>",
    "      <Command>C:\\Windows\\System32\\conhost.exe</Command>",
    "      <Arguments>",
    "        --headless &quot;C:\\Users\\theo\\T3 &apos;Code&apos; &amp; Tools\\runtime\\versions\\1.2.3\\t3.exe&quot;",
    "        __service-launcher --base-dir",
    "        &quot;C:\\Users\\theo\\T3 &amp; Home\\\\&quot; --log-file C:\\Users\\theo\\boot.log",
    "      </Arguments>",
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ].join("\r\n");

  expect(BootService.bootServiceProgramOf(exportedXml)).toBe(
    "C:\\Users\\theo\\T3 'Code' & Tools\\runtime\\versions\\1.2.3\\t3.exe",
  );
  expect(BootService.bootServiceBaseDirOf(exportedXml)).toBe("C:\\Users\\theo\\T3 & Home\\");

  const unquotedXml = [
    "<Task>",
    "  <Actions>",
    "    <Exec>",
    "      <Command>C:\\Windows\\System32\\conhost.exe</Command>",
    "      <Arguments>--headless C:\\t3\\runtime\\versions\\1.2.3\\t3.exe __service-launcher --base-dir=C:\\Users\\theo\\.t3</Arguments>",
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ].join("\n");
  expect(BootService.bootServiceProgramOf(unquotedXml)).toBe(
    "C:\\t3\\runtime\\versions\\1.2.3\\t3.exe",
  );
  expect(BootService.bootServiceBaseDirOf(unquotedXml)).toBe("C:\\Users\\theo\\.t3");
});

it("protects the server unit from agents under CPU and memory pressure", () => {
  const unit = BootService.renderBootServiceUnit({
    program: ["/home/theo/.t3/runtime/versions/1.2.3/t3", "__service-launcher"],
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });
  const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
  for (const line of [
    "CPUWeight=1000",
    "IOWeight=1000",
    "MemoryLow=1536M",
    "OOMScoreAdjust=100",
    "OOMPolicy=continue",
  ]) {
    expect(service.split("\n")).toContain(line);
  }
});

it.each([
  ["a unit", '/home/theo/T3 "Data"/100%\\x', BootService.renderBootServiceUnit],
  [
    "a plist",
    "/Users/theo/a&b <c>",
    (plan: BootService.BootServicePlan) =>
      BootService.renderBootServicePlist(plan, { homeDir: "/Users/theo", environmentPath: "" }),
  ],
  [
    "a task",
    'C:\\Users\\theo\\T3 "a&b" <c>\\',
    (plan: BootService.BootServicePlan) =>
      BootService.renderBootServiceTask(plan, windowsTaskOptions),
  ],
] as const)("reads the launcher back out of %s", (_, baseDir, render) => {
  const program = `${baseDir}/runtime/versions/1.2.3/t3`;
  expect(
    BootService.bootServiceProgramOf(
      render({ program: [program, "__service-launcher"], baseDir, logPath: "/log", unitPath: "" }),
    ),
  ).toBe(program);
});

const macInstallerPath =
  "/opt/homebrew/bin:/Users/theo/.npm-global/bin:/Users/theo/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
  xdgConfigHome?: string,
  managerXdgConfigHome = xdgConfigHome,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const localAppData = path.join(home, "AppData", "Local");
  const taskName = serviceTaskName("PC", "theo");
  const controlDirFor = (targetBaseDir: string) =>
    serviceControlDir(localAppData, targetBaseDir, { caseInsensitive: platform === "win32" });
  const managerUnitDir = path.join(
    managerXdgConfigHome !== undefined && path.isAbsolute(managerXdgConfigHome)
      ? managerXdgConfigHome
      : path.join(home, ".config"),
    "systemd",
    "user",
  );
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const schtasksExe = windowsSystem32Binary("schtasks.exe", { SystemRoot: "C:\\Windows" });
  const activeLaunchers = new Set<Launcher>();
  const commands: string[] = [];
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const timeouts = new Map<string, unknown>();
  const control: {
    failCommand: string | undefined;
    failAllSchtasks?: boolean | undefined;
    failTaskQuery?: boolean | undefined;
    queryHresultOverride?: number | undefined;
    windowsLauncherFlags?: boolean | undefined;
    stopLaunchersOnTaskEnd?: boolean | undefined;
    stateAfterStop?: string | undefined;
    registeredTaskXml?: string | undefined;
    onBeforeWriteUnit?: (() => Effect.Effect<void>) | undefined;
    linger: string;
    enabled: boolean;
    active: boolean;
    taskRegistered: boolean;
  } = {
    failCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
    taskRegistered: false,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      invocations.push(input);
      timeouts.set(command, input.timeout);
      const isSchtasks =
        input.command === "schtasks" || input.command.toLowerCase().endsWith("\\schtasks.exe");
      const isTaskXmlQuery =
        input.command.toLowerCase().endsWith("\\powershell.exe") &&
        input.args.some((arg) => arg.includes("Schedule.Service"));
      const failed =
        command === control.failCommand ||
        (control.failAllSchtasks === true && (isSchtasks || isTaskXmlQuery)) ||
        (control.failTaskQuery === true && isTaskXmlQuery);
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && isSchtasks && input.args[0] === "/Create") {
        const xmlIndex = input.args.indexOf("/XML");
        const xmlPath = xmlIndex >= 0 ? input.args[xmlIndex + 1] : undefined;
        const xml =
          xmlPath === undefined
            ? ""
            : yield* fs.readFileString(xmlPath).pipe(Effect.orElseSucceed(() => ""));
        control.taskRegistered = true;
        control.enabled = !/<Enabled>\s*false\s*<\/Enabled>/i.test(xml);
        control.registeredTaskXml = xml;
      }
      if (!failed && isSchtasks && input.args[0] === "/Delete") {
        control.taskRegistered = false;
        control.registeredTaskXml = undefined;
      }
      const setTaskXmlEnabled = (xml: string | undefined, enabled: boolean) => {
        if (xml === undefined) return undefined;
        const tag = `<Enabled>${enabled}</Enabled>`;
        return /<Enabled>\s*(?:true|false)\s*<\/Enabled>/i.test(xml)
          ? xml.replace(/<Enabled>\s*(?:true|false)\s*<\/Enabled>/i, tag)
          : xml.replace(/<\/Settings>/i, `    ${tag}\n  </Settings>`);
      };
      if (
        !failed &&
        (command === "systemctl --user enable t3code.service" ||
          (isSchtasks && input.args.includes("/ENABLE")))
      ) {
        control.enabled = true;
        control.registeredTaskXml = setTaskXmlEnabled(control.registeredTaskXml, true);
      }
      if (!failed && isSchtasks && input.args.includes("/DISABLE")) {
        control.enabled = false;
        control.registeredTaskXml = setTaskXmlEnabled(control.registeredTaskXml, false);
      }
      if (
        !failed &&
        control.stopLaunchersOnTaskEnd === true &&
        isSchtasks &&
        input.args[0] === "/End"
      ) {
        yield* Effect.promise(() =>
          Promise.all(Array.from(activeLaunchers, (launcher) => launcher.stop("SIGTERM"))),
        );
      }
      if (!failed && command === "systemctl --user restart t3code.service") control.active = true;
      // A timed-out stop may still stop the service.
      if (command === "systemctl --user stop t3code.service") control.active = false;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop t3code.service" ||
          command.startsWith("launchctl bootout --wait ") ||
          (isSchtasks && input.args[0] === "/End"))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      if (
        control.onBeforeWriteUnit !== undefined &&
        (command === "systemctl --user stop t3code.service" ||
          (isSchtasks && input.args[0] === "/End"))
      ) {
        yield* control.onBeforeWriteUnit();
      }
      const exitCode = isTaskXmlQuery
        ? failed
          ? 1
          : !control.taskRegistered
            ? 2
            : 0
        : isSchtasks &&
            input.args[0] === "/Query" &&
            input.args.includes("/HRESULT") &&
            control.queryHresultOverride !== undefined
          ? control.queryHresultOverride
          : failed
            ? 1
            : isSchtasks &&
                (input.args[0] === "/Delete" || input.args[0] === "/Change") &&
                !control.taskRegistered
              ? 1
              : isSchtasks && input.args[0] === "/Query" && !control.taskRegistered
                ? input.args.includes("/HRESULT")
                  ? 0x80070002
                  : 1
                : (input.args[1] === "is-active" && !control.active) ||
                    (input.args[1] === "is-enabled" && !control.enabled)
                  ? 1
                  : 0;
      return {
        stdout:
          input.command === "busctl"
            ? JSON.stringify({
                type: "as",
                data: [
                  "/usr/lib/systemd/user",
                  `${managerUnitDir}.control`,
                  "/run/user/501/systemd/transient",
                  managerUnitDir,
                  "/etc/systemd/user",
                ],
              })
            : isTaskXmlQuery && !failed && control.taskRegistered
              ? (control.registeredTaskXml ??
                `<Task><Settings><Enabled>${control.enabled}</Enabled></Settings></Task>\n`)
              : input.args[0] === "__service-launcher" && input.args[1] === "--help"
                ? control.windowsLauncherFlags === false
                  ? "t3 __service-launcher\n"
                  : "--base-dir --log-file --service-unit\n"
                : input.args[0] === "--version"
                  ? `t3 v${/versions[\\/]([^\\/]+)[\\/]/.exec(input.command)?.[1] ?? "1.2.3"}\n`
                  : input.command === "loginctl" && input.args[0] === "show-user"
                    ? `${control.linger}\n`
                    : input.args[1] === "is-enabled"
                      ? control.enabled
                        ? "enabled\n"
                        : "disabled\n"
                      : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(exitCode),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
  });
  const makeService = (
    environmentPath: string | undefined = installerPath,
    cliVersion = "1.2.3",
    serviceBaseDir = baseDir,
    insideService = false,
    hostExecPath = "/usr/bin/t3",
    fallbackReleaseTimeoutMs?: number,
    envOverrides: Readonly<Record<string, string>> = {},
    aclOverride: ControlAclHooks = trustedTestAcl,
  ) =>
    Effect.gen(function* () {
      const paths = pinnedRuntimePaths(path, serviceBaseDir, cliVersion, platform);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${cliVersion}\n`);
      return yield* BootService.make({
        baseDir: serviceBaseDir,
        logsDir: path.join(serviceBaseDir, "userdata", "logs"),
        cliVersion,
        host: {
          execPath: hostExecPath,
          acl: aclOverride,
          ...(fallbackReleaseTimeoutMs === undefined ? {} : { fallbackReleaseTimeoutMs }),
        },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.UserId, 501),
          Layer.succeed(HostProcess.ExecutablePath, hostExecPath),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...(xdgConfigHome === undefined ? {} : { XDG_CONFIG_HOME: xdgConfigHome }),
                USERPROFILE: home,
                LOCALAPPDATA: localAppData,
                USERDOMAIN: "PC",
                USERNAME: "theo",
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
                ...(insideService
                  ? {
                      T3_BOOT_SERVICE_UNIT:
                        platform === "win32"
                          ? BootService.BOOT_SERVICE_TASK_FILE
                          : platform === "darwin"
                            ? BootService.BOOT_SERVICE_PLIST_FILE
                            : BootService.BOOT_SERVICE_UNIT_FILE,
                    }
                  : {}),
                ...envOverrides,
              },
            }),
          ),
        ),
      ),
    );
  const spawnLauncher = (version: string, acceptUpdate = false) =>
    Effect.gen(function* () {
      const dbPath = path.join(baseDir, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      yield* fs.writeFileString(dbPath, "db");
      const childScript = [
        'process.on("message", (m) => { if (m.type === "stop" || m.type === "update-accepted") process.exit(0); });',
        `process.send({ type: "request-update", targetVersion: "9.9.9", dbPath: ${JSON.stringify(dbPath)} });`,
        "setInterval(() => {}, 10000);",
      ].join("\n");
      for (const candidate of [version, "9.9.9"]) {
        const hostBin = pinnedRuntimePaths(
          path,
          baseDir,
          candidate,
          path.sep === "\\" ? "win32" : "linux",
        );
        yield* fs.makeDirectory(hostBin.versionDir, { recursive: true });
        yield* fs.writeFileString(hostBin.entryPath, childScript, { mode: 0o755 });
        yield* fs.writeFileString(hostBin.sentinelPath, `${candidate}\n`);
      }
      const ready = Promise.withResolvers<void>();
      const state = yield* Effect.promise(() => readServiceState(statePath));
      const controlDir = controlDirFor(baseDir);
      const launcher = new Launcher(baseDir, state, {
        controlDir,
        acl: trustedTestAcl,
        stopChildOverIpc: true,
        spawnCommand: (entryPath) => {
          if (acceptUpdate && entryPath.includes("9.9.9")) {
            ready.resolve();
          }
          return { command: process.execPath, args: [entryPath] };
        },
        backupSpaceProbe: {
          readFreeBytes: () => {
            if (!acceptUpdate) {
              ready.resolve();
            }
            return Promise.resolve(acceptUpdate ? Number.MAX_SAFE_INTEGER : 0);
          },
          canClone: () => Promise.resolve(false),
        },
      });
      activeLaunchers.add(launcher);
      const running = launcher.run().finally(() => {
        activeLaunchers.delete(launcher);
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          launcher
            .stop("SIGTERM")
            .then(() => running)
            .catch(() => undefined),
        ),
      );
      yield* Effect.promise(() => Promise.race([ready.promise, running]));
      return { launcher, running, controlDir };
    });
  const service = yield* makeService();
  return {
    service,
    makeService,
    spawnLauncher,
    controlDirFor,
    localAppData,
    taskName,
    schtasksExe,
    fs,
    home,
    baseDir,
    statePath,
    commands,
    invocations,
    timeouts,
    control,
    runtime,
  };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect(
    "fails before installing files or validating a runtime when lingering needs an administrator",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, runtime } = yield* makeHarness();
        const before = yield* service.status;
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";
        yield* fs.remove(runtime.sentinelPath);

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServicePrerequisiteError",
          problem: "linger-disabled",
        });
        expect(error.message).toContain('sudo loginctl enable-linger "$(id -un)"');
        expect(error.message).toContain("last login session ends");
        expect(yield* fs.exists(before.unitPath)).toBe(false);
        expect(yield* fs.exists(statePath)).toBe(false);
        expect(commands.some((command) => command.includes("--version"))).toBe(false);
        expect(
          commands.some(
            (command) => command.includes("daemon-reload") || command.includes("restart"),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(before.logPath)).toContain("[linger-disabled]");
      }),
  );

  it.effect(
    "detects a partial install and preserves the running service when repair lacks permission",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness();
        const plan = yield* service.install();
        const before = yield* fs.readFileString(statePath);
        const unit = yield* fs.readFileString(plan.unitPath);
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";

        expect(yield* service.status).toMatchObject({
          current: false,
          problems: ["linger-disabled"],
        });
        commands.length = 0;
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServicePrerequisiteError",
        );
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(commands).not.toContain("systemctl --user stop t3code.service");
      }),
  );

  it.effect("enables lingering before installing and repairs stopped or disabled services", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      control.linger = "no";
      yield* service.install();
      expect(control.linger).toBe("yes");
      expect(commands.indexOf("loginctl enable-linger --no-ask-password 501")).toBeLessThan(
        commands.indexOf("systemctl --user daemon-reload"),
      );

      control.enabled = false;
      control.active = false;
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-disabled", "service-stopped"],
      });
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each([
    { command: "systemctl --user show-environment", problem: "user-manager-unavailable" },
    { command: "loginctl show-user 501 --property=Linger --value", problem: "linger-unavailable" },
  ])("reports failed prerequisite probes without installing: $command", ({ command, problem }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      control.failCommand = command;
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem,
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect.each([
    "unset",
    "empty",
    "relative",
    "relocated",
    "shell-only",
    "manager-only",
    "manager-unavailable",
  ] as const)("installs, discovers, restarts, and uninstalls with $XDG_CONFIG_HOME %s", (setting) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const configRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-xdg-config-" });
      const xdgConfigHome = {
        unset: undefined,
        empty: "",
        relative: "relative-config",
        relocated: path.join(configRoot, "config root"),
        "shell-only": path.join(configRoot, "config root"),
        "manager-only": undefined,
        "manager-unavailable": path.join(configRoot, "config root"),
      }[setting];
      const managerXdgConfigHome =
        setting === "shell-only"
          ? ""
          : setting === "manager-only"
            ? path.join(configRoot, "config root")
            : undefined;
      const { service, makeService, home, statePath, timeouts, runtime, control } =
        yield* makeHarness("linux", undefined, xdgConfigHome, managerXdgConfigHome);
      const unitPath = path.join(
        setting === "relocated" || setting === "manager-only" || setting === "manager-unavailable"
          ? path.join(configRoot, "config root")
          : path.join(home, ".config"),
        "systemd",
        "user",
        "t3code.service",
      );
      expect(yield* service.status).toMatchObject({ installed: false, unitPath });
      const plan = yield* service.install();
      expect(plan.unitPath).toBe(unitPath);
      if (setting === "manager-unavailable") {
        control.failCommand =
          "busctl --user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager UnitPath";
      }
      const discoveredService = yield* makeService();

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `ExecStart=${runtime.entryPath} __service-launcher`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* discoveredService.status).toMatchObject({
        installed: true,
        current: true,
        unitPath,
      });
      expect(yield* discoveredService.restart).toBe("restarted");
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
      expect(yield* discoveredService.uninstall).toBe(true);
      expect(yield* fs.exists(unitPath)).toBe(false);
      expect((yield* discoveredService.status).installed).toBe(false);
      // systemd can take 90s to stop, exceeding the runner's 60s default.
      expect(timeouts.get("systemctl --user disable --now t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "reports the installed version across launcher protocols on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* makeHarness(platform);
        yield* service.install();

        for (const protocol of [SERVICE_LAUNCHER_PROTOCOL - 1, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          yield* fs.writeFileString(
            statePath,
            `{"protocol":${protocol},"activeVersion":"1.2.4-nightly.1","update":{"status":"unknown"}}`,
          );
          expect(yield* service.status).toMatchObject({
            current: false,
            installedVersion: "1.2.4-nightly.1",
          });
          yield* service.install({ allowDowngrade: true });
          expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.3",
          });
        }
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("reports an unknown version for invalid service state", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();

      for (const stateText of [
        "{",
        '{"activeVersion":"latest"}',
        '{"activeVersion":"1.2"}',
        '{"activeVersion":123}',
      ]) {
        yield* fs.writeFileString(statePath, stateText);
        const status = yield* service.status;
        expect(status.current).toBe(false);
        expect(status.installedVersion).toBeUndefined();
      }
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "preserves a newer version that finishes updating during stop on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL + 1},"activeVersion":"1.2.4"}`;
        commands.length = 0;

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.4",
          targetVersion: "1.2.3",
        });
        expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(
          commands.filter(
            (command) =>
              command.startsWith(platform === "linux" ? "systemctl " : "launchctl ") &&
              !command.includes("show-environment"),
          ),
        ).toEqual(
          platform === "linux"
            ? ["systemctl --user stop t3code.service", "systemctl --user restart t3code.service"]
            : [
                "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
                `launchctl bootstrap gui/501 ${plan.unitPath}`,
              ],
        );
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("allows an explicit downgrade", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      yield* service.install({ allowDowngrade: true });

      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("repairs versions with equal SemVer precedence without an override", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.3+previous-build"}`,
      );

      yield* service.install();

      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "install with start=false rewrites files, preserves service.env, and marks a restart pending on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, commands, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const envPath = path.join(baseDir, SERVICE_ENV_FILE);
        const envBytes = new TextEncoder().encode(
          '# user configuration\r\nT3CODE_TOKEN="literal $HOME # token"',
        );
        yield* fs.writeFile(envPath, envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        commands.length = 0;

        const newer = yield* makeService(undefined, "1.2.4");
        const plan = yield* newer.install({ start: false });
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);

        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
        });
        expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/t3");
        expect(
          commands.filter(
            (command) =>
              /^(systemctl|launchctl) /.test(command) && !command.includes("show-environment"),
          ),
        ).toEqual([]);
        const status = yield* newer.status;
        expect(status.current).toBe(false);
        expect(status.problems).toContain("restart-pending");

        commands.length = 0;
        expect(yield* newer.restart).toBe("restarted");
        expect((yield* newer.status).problems).not.toContain("restart-pending");
        expect((yield* newer.status).current).toBe(true);

        const latest = yield* makeService(undefined, "1.2.5");
        yield* latest.install({ start: true });
        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.5",
        });
        expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.5/t3");
        expect((yield* latest.status).current).toBe(true);
        expect(
          yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
        ).toBe(false);
      }),
  );

  it.effect(
    "serializes a local install with another process reconciling an older unit snapshot",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, makeService, runtime } = yield* makeHarness();
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        yield* fs.writeFileString(
          plan.unitPath,
          unit.replace("versions/1.2.3/t3", "versions/1.2.2/t3"),
        );
        yield* fs.writeFileString(
          statePath,
          JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.3",
            update: {
              id: "committed",
              fromVersion: "1.2.2",
              targetVersion: "1.2.3",
              status: "committed",
            },
          }),
        );
        const rejection = path.join(plan.baseDir, "rejected-update");
        const databasePath = path.join(plan.baseDir, "state.sqlite");
        yield* fs.writeFileString(databasePath, "database");
        yield* fs.writeFileString(
          runtime.entryPath,
          `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("message", message => {
  if (message === "request-update") process.send({ type: "request-update", targetVersion: "1.2.5", dbPath: ${JSON.stringify(databasePath)} });
  if (message.type === "update-rejected") {
    writeFileSync(${JSON.stringify(rejection)}, message.reason);
    process.exit(0);
  }
});
`,
        );
        yield* fs.chmod(runtime.entryPath, 0o755);
        const newer = yield* makeService(undefined, "1.2.4");
        yield* makeService(undefined, "1.2.5");
        const snapshot = Promise.withResolvers<void>();
        const milestone = Promise.withResolvers<void>();
        const script = path.join(plan.baseDir, "launcher-contention.mjs");
        yield* fs.writeFileString(
          script,
          `
import fs from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const server = Promise.withResolvers();
const originalSpawn = cp.spawn;
cp.spawn = (...args) => { const child = originalSpawn(...args); server.resolve(child); return child; };
process.on("message", async message => {
  if (message === "installed") (await server.promise).send("request-update");
});
const originalRead = fs.readFile;
fs.readFile = async (...args) => {
  const contents = await originalRead(...args);
  if (args[0] === ${JSON.stringify(plan.unitPath)}) {
    fs.readFile = originalRead;
    syncBuiltinESMExports();
    const resume = new Promise(resolve => process.once("message", resolve));
    process.send("snapshot");
    await resume;
  }
  return contents;
};
syncBuiltinESMExports();
const { Launcher, readServiceState } = await import(${JSON.stringify(import.meta.resolve("../serviceLauncher.ts"))});
const launcher = new Launcher(${JSON.stringify(plan.baseDir)}, await readServiceState(${JSON.stringify(statePath)}), {
  serviceUnit: { path: ${JSON.stringify(plan.unitPath)}, reload: async () => {} },
});
try { await launcher.run(); throw Error("unexpected completion"); }
catch (error) {
  if (!error.message.includes("Active child exited unexpectedly (0)")) throw error;
}
const { acquireServiceSelectionLock } = await import(${JSON.stringify(import.meta.resolve("./serviceSelectionLock.ts"))});
// Exit owning the real lease, as a crashed process would.
await acquireServiceSelectionLock(${JSON.stringify(plan.unitPath)});
process.disconnect();
`,
        );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.fork(script, [], {
              execArgv: [],
              stdio: ["ignore", "inherit", "inherit", "ipc"],
            }),
          ),
          (child) =>
            Effect.sync(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill();
            }),
        );
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`launcher exited ${code}`)),
          );
        });
        child.on("message", (message) => {
          if (message === "snapshot") snapshot.resolve();
        });
        yield* Effect.promise(() =>
          Promise.race([
            snapshot.promise,
            exited.then(() => {
              throw new Error("launcher exited before snapshot");
            }),
          ]),
        );
        leaseObserver.contended = (destination) => {
          if (destination === plan.unitPath + ".selection-lock") milestone.resolve();
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            leaseObserver.contended = () => {};
          }),
        );
        const installing = yield* newer
          .install({ start: false })
          .pipe(Effect.ensuring(Effect.sync(() => milestone.resolve())), Effect.forkChild);
        // Resume the launcher once the installer contends for the unit lease, or once an
        // uncoordinated installer has finished, which makes the stale snapshot win.
        yield* Effect.promise(() => milestone.promise);
        child.send("resume");
        yield* Fiber.join(installing);
        child.send("installed");
        yield* Effect.promise(() => exited);
        expect(yield* fs.readFileString(rejection)).toContain("Service selection changed");
        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
        });
        expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/t3");
        expect(
          yield* fs.readFileString(
            path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE),
          ),
        ).toBe("1.2.4\n");
        // The next installer reclaims the dead owner and releases its own lease.
        yield* newer.install({ start: false });
        expect(yield* fs.exists(plan.unitPath + ".selection-lock")).toBe(false);
      }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      const unitPath = (yield* service.status).unitPath;
      yield* fs.remove(unitPath);
      yield* fs.makeDirectory(unitPath);
      yield* fs.writeFileString(path.join(unitPath, "occupied"), "");

      const error = yield* newer.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(
        yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
      ).toBe(true);
    }),
  );

  it.effect("install with start=false refuses while a remote update is pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
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

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
      yield* fs.remove((yield* service.status).unitPath);
      expect((yield* service.install({ start: false }).pipe(Effect.flip))._tag).toBe(
        "BootServiceUpdatePendingError",
      );
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("pauses only this home's running service for maintenance, even when it fails", () =>
    Effect.gen(function* () {
      const { service, commands, control, makeService } = yield* makeHarness();
      yield* service.install();
      const failure = yield* service
        .withStopped(Effect.failSync(() => (control.active ? "running" : "repair failed")))
        .pipe(Effect.flip);
      expect(failure).toBe("repair failed");
      expect(control.active).toBe(true);

      control.failCommand = "systemctl --user stop t3code.service";
      let ran = false;
      const stopFailure = yield* service
        .withStopped(
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.flip);
      expect(stopFailure).toMatchObject({
        _tag: "BootServiceCommandError",
        step: "stopping the installed service",
      });
      expect(ran).toBe(false);
      expect(control.active).toBe(true);
      control.failCommand = undefined;

      control.active = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toEqual([
        "systemctl --user is-enabled t3code.service",
        "systemctl --user is-active t3code.service",
        "systemctl --user stop t3code.service",
        "repair",
        "systemctl --user restart t3code.service",
      ]);
      expect(control.active).toBe(true);
      control.enabled = false;
      yield* service.withStopped(Effect.void);
      expect(control).toMatchObject({ active: true, enabled: false });
      control.active = false;
      control.enabled = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toContain("systemctl --user stop t3code.service");
      expect(commands).not.toContain("systemctl --user restart t3code.service");
      expect(control.active).toBe(false);
      control.enabled = true;
      control.active = true;

      const fs = yield* FileSystem.FileSystem;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-other-" });
      const other = yield* makeService(undefined, "1.2.3", otherHome);
      commands.length = 0;
      expect(yield* other.withStopped(Effect.sync(() => control.active))).toBe(true);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("restart and install leave a service that serves another T3 home alone", () =>
    Effect.gen(function* () {
      const { service, fs, baseDir, commands, makeService } = yield* makeHarness();
      const plan = yield* service.install();
      const unit = yield* fs.readFileString(plan.unitPath);
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      commands.length = 0;
      expect(yield* other.restart).toBe("skipped");
      const refused = yield* other.install().pipe(Effect.flip);
      expect(refused._tag).toBe("BootServiceOtherBaseDirError");
      // The CLI prints a user message without a stack trace.
      expect(CliError.getUserMessage(refused)).toBe(refused.message);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(commands).toEqual([]);
      expect((yield* other.status).otherBaseDir).toBe(baseDir);
    }),
  );

  it.effect("hands the whole install to systemd without changing the running service", () =>
    Effect.gen(function* () {
      const { fs, commands, invocations, control, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-" });
      const baseDir = path.join(home, "T3 Data 100%", "${UNSET}", "$literal");
      const outside = yield* makeService(undefined, "1.2.3", baseDir);
      const plan = yield* outside.install();
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      const state = yield* fs.readFileString(statePath);
      const unit = yield* fs.readFileString(plan.unitPath);
      const inside = yield* makeService(undefined, "1.2.4", baseDir, true);
      commands.length = 0;
      invocations.length = 0;

      const result = yield* inside.install({ allowDowngrade: true });

      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(commands).not.toContain("systemctl --user stop t3code.service");
      expect(result).toMatchObject({ handedOff: true, logPath: plan.logPath });
      const handoffs = invocations.filter(({ command }) => command === "systemd-run");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.args).toEqual([
        "--user",
        "--collect",
        "--quiet",
        `--property=StandardOutput=append:${plan.logPath}`,
        `--property=StandardError=append:${plan.logPath}`,
        "--setenv=T3_BOOT_SERVICE_UNIT=",
        pinnedRuntimePaths(path, baseDir, "1.2.4", "linux").entryPath,
        "service",
        "install",
        "--base-dir",
        path.join(home, "T3 Data 100%", "$${UNSET}", "$$literal"),
        "--allow-downgrade",
      ]);

      const handoff = handoffs[0]!;
      control.failCommand = `${handoff.command} ${handoff.args.join(" ")}`;
      const error = yield* inside.install({ allowDowngrade: true }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(control.active).toBe(true);
      expect(commands).not.toContain("systemctl --user stop t3code.service");
    }),
  );

  it.effect(
    "queues an in-service restart without stopping the caller, even on handoff failure",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, makeService } = yield* makeHarness();
        const plan = yield* service.install();
        const state = yield* fs.readFileString(statePath);
        const marker = `${plan.baseDir}/runtime/${SERVICE_RESTART_PENDING_FILE}`;
        yield* fs.writeFileString(marker, "1.2.3\n");
        const inside = yield* makeService(undefined, "1.2.3", undefined, true);
        commands.length = 0;
        control.failCommand = "systemctl --user daemon-reload";

        const error = yield* inside.restart.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
        expect(commands).toEqual(["systemctl --user daemon-reload"]);
        expect(control.active).toBe(true);

        control.failCommand = undefined;
        commands.length = 0;
        const outcome = yield* inside.restart;
        expect(commands).toEqual([
          "systemctl --user daemon-reload",
          "systemctl --user enable t3code.service",
          "systemctl --user restart --no-block t3code.service",
        ]);
        expect(outcome).toBe("queued");
        expect(yield* fs.readFileString(statePath)).toBe(state);
        expect(yield* fs.readFileString(marker)).toBe("1.2.3\n");
      }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart t3code.service",
      ]);

      // `restart` runs `stop` before registering recovery so a failed stop does not immediately restart.
      commands.length = 0;
      control.failCommand = "systemctl --user stop t3code.service";
      expect((yield* service.restart.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(commands).not.toContain("systemctl --user restart t3code.service");
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install();
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
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(
          commands.filter(
            (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
          ),
        ).toEqual([
          "systemctl --user stop t3code.service",
          "systemctl --user restart t3code.service",
        ]);
      }
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();

      expect(
        plan.unitPath.endsWith(
          path.join("Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <key>PATH</key>\n    <string>${macInstallerPath}:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <string>${runtime.entryPath}</string>\n    <string>__service-launcher</string>`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // launchd can take 90s to bootout; the runner's 60s default could let bootstrap race it.
      expect(timeouts.get("launchctl bootout --wait gui/501/com.t3tools.t3code.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect(
    "installs, defers disabled installs, refuses post-stop downgrades, and uninstalls on Windows",
    () =>
      Effect.gen(function* () {
        const {
          service,
          makeService,
          taskName,
          schtasksExe,
          control,
          fs,
          statePath,
          commands,
          runtime,
        } = yield* makeHarness("win32");
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const task = yield* fs.readFileString(plan.unitPath);
        const nonQuerySchtasks = () =>
          commands.filter(
            (command) =>
              command.startsWith(`${schtasksExe} `) &&
              !command.startsWith(`${schtasksExe} /Query `),
          );

        expect(plan.unitPath).toBe(
          path.join(path.dirname(plan.baseDir), "AppData", "Local", "t3code", "t3code-task.xml"),
        );
        expect(BootService.bootServiceProgramOf(task)).toBe(runtime.entryPath);
        expect(BootService.bootServiceBaseDirOf(task)).toBe(plan.baseDir);
        expect(task).toContain("<UserId>PC\\theo</UserId>");
        expect(task).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.3",
        });
        expect(nonQuerySchtasks()).toEqual([
          `${schtasksExe} /Create /XML ${plan.unitPath} /TN ${taskName} /F`,
          `${schtasksExe} /Run /TN ${taskName}`,
        ]);
        expect(yield* service.status).toMatchObject({
          installed: true,
          current: false,
          problems: ["service-stopped"],
        });

        // Deferred install preserves an enabled task's state, and registers `<Enabled>false</Enabled>`
        // directly in one `schtasks /Create` call when the task is disabled so the minute trigger never fires.
        const newer = yield* makeService(undefined, "1.2.4");
        commands.length = 0;
        yield* newer.install({ start: false });
        expect(control.enabled).toBe(true);
        control.enabled = false;
        control.registeredTaskXml = control.registeredTaskXml?.replace(
          /<\/Settings>/i,
          "    <Enabled>false</Enabled>\n  </Settings>",
        );
        const latest = yield* makeService(undefined, "1.2.5");
        commands.length = 0;
        yield* latest.install({ start: false });
        const deferredSchtasks = nonQuerySchtasks();
        expect(deferredSchtasks).toHaveLength(1);
        expect(deferredSchtasks[0]).toMatch(
          new RegExp(
            `^${schtasksExe.replaceAll("\\", "\\\\")} /Create /XML .+ /TN ${taskName} /F$`,
          ),
        );
        expect(control.enabled).toBe(false);
        expect(BootService.bootServiceProgramOf(yield* fs.readFileString(plan.unitPath))).toBe(
          pinnedRuntimePaths(path, plan.baseDir, "1.2.5", "win32").entryPath,
        );

        // Failed /Run on a disabled+stopped task restores `<Enabled>false</Enabled>`.
        control.failCommand = `${schtasksExe} /Run /TN ${taskName}`;
        expect((yield* latest.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        expect(control.enabled).toBe(false);
        control.failCommand = undefined;

        // Ordinary install checks state under the control lock after stop so a newer staged version wins.
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.9"}`;
        expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.9",
          targetVersion: "1.2.3",
        });
        expect(control.enabled).toBe(false);
        control.stateAfterStop = undefined;
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.3",
          }),
        );

        // Uninstall preserves the XML mirror when the task stays registered or Task Scheduler fails,
        // and removes it when `/Query /HRESULT` confirms the task is absent (0x80070002).
        control.failCommand = `${schtasksExe} /Delete /TN ${taskName} /F`;
        expect((yield* service.uninstall.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        expect(yield* fs.exists(plan.unitPath)).toBe(true);
        control.failCommand = undefined;

        control.taskRegistered = false;
        control.failAllSchtasks = true;
        expect((yield* service.uninstall.pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        expect(yield* fs.exists(plan.unitPath)).toBe(true);
        control.failAllSchtasks = false;

        commands.length = 0;
        expect(yield* service.uninstall).toBe(true);
        expect(commands.filter((command) => command.startsWith(`${schtasksExe} `))).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          `${schtasksExe} /Query /TN ${taskName} /HRESULT`,
          `${schtasksExe} /End /TN ${taskName}`,
          `${schtasksExe} /Delete /TN ${taskName} /F`,
          `${schtasksExe} /Query /TN ${taskName} /HRESULT`,
        ]);
        expect((yield* service.status).installed).toBe(false);
      }),
  );

  it.effect(
    "aborts Windows mutations when disabling or querying fails, protects stale mirrors, and round-trips non-ASCII homes",
    () =>
      Effect.gen(function* () {
        const { service, makeService, taskName, schtasksExe, control, fs, home, commands } =
          yield* makeHarness("win32");
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const nonQuerySchtasks = () =>
          commands.filter(
            (command) =>
              command.startsWith(`${schtasksExe} `) &&
              !command.startsWith(`${schtasksExe} /Query `),
          );

        // A real `/DISABLE` failure on an existing task aborts before stopping or running recovery.
        control.failCommand = `${schtasksExe} /Change /TN ${taskName} /DISABLE`;
        commands.length = 0;
        expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "disabling the scheduled task",
        });
        expect(commands.filter((command) => command.startsWith(`${schtasksExe} `))).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          `${schtasksExe} /Query /TN ${taskName} /HRESULT`,
        ]);

        commands.length = 0;
        expect(yield* service.restart.pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "disabling the scheduled task",
        });
        expect(commands.filter((command) => command.startsWith(`${schtasksExe} `))).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          `${schtasksExe} /Query /TN ${taskName} /HRESULT`,
        ]);
        control.failCommand = undefined;

        // If `Schedule.Service` fails, `install`, `restart`, `withStopped`, and `uninstall` fail
        // closed instead of falling back to a stale mirror or authorizing a blind overwrite.
        const foreignHome = path.join(home, ".t3-stale-mirror");
        yield* fs.writeFileString(
          plan.unitPath,
          BootService.renderBootServiceTask(
            {
              program: [`${foreignHome}/runtime/versions/1.2.3/t3.exe`, "__service-launcher"],
              baseDir: foreignHome,
              logPath: `${foreignHome}/userdata/logs/boot-service.log`,
              unitPath: plan.unitPath,
            },
            windowsTaskOptions,
          ),
        );
        // With Task Scheduler healthy, live `registeredTaskXml` (`plan.baseDir`) wins over the
        // stale foreign local mirror, and `restart` activates the registered task directly rather
        // than overwriting Task Scheduler from the stale mirror via `/Create /XML`.
        commands.length = 0;
        expect(yield* service.restart).toBe("restarted");
        expect(nonQuerySchtasks()).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          `${schtasksExe} /End /TN ${taskName}`,
          `${schtasksExe} /Change /TN ${taskName} /ENABLE`,
          `${schtasksExe} /Run /TN ${taskName}`,
        ]);

        control.failTaskQuery = true;
        expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "inspecting the scheduled task",
        });
        expect(yield* service.restart.pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "inspecting the scheduled task",
        });
        expect(yield* service.withStopped(Effect.void).pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "inspecting the scheduled task",
        });
        expect(yield* service.uninstall.pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "inspecting the scheduled task",
        });
        control.failTaskQuery = false;

        // Even when the local XML mirror is deleted, `Schedule.Service` preserves cross-home
        // protection, mirrorless `status` fails closed when the query fails, and mirrorless
        // `restart` re-enables and starts the registered task directly.
        yield* fs.remove(plan.unitPath);
        control.failTaskQuery = true;
        expect(yield* service.status.pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceCommandError",
          step: "inspecting the scheduled task",
        });
        control.failTaskQuery = false;
        expect((yield* service.status).installed).toBe(true);
        commands.length = 0;
        expect(yield* service.restart).toBe("restarted");
        expect(nonQuerySchtasks()).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          `${schtasksExe} /End /TN ${taskName}`,
          `${schtasksExe} /Change /TN ${taskName} /ENABLE`,
          `${schtasksExe} /Run /TN ${taskName}`,
        ]);

        const insideMirrorless = yield* makeService(undefined, "1.2.3", undefined, true);
        commands.length = 0;
        expect(yield* insideMirrorless.restart).toBe("queued");
        expect(nonQuerySchtasks()).toEqual([
          `${schtasksExe} /Change /TN ${taskName} /ENABLE`,
          `${schtasksExe} /End /TN ${taskName}`,
          `${schtasksExe} /Run /TN ${taskName}`,
        ]);
        expect(yield* insideMirrorless.withStopped(Effect.void).pipe(Effect.flip)).toMatchObject({
          _tag: "BootServiceRunningInsideServiceError",
        });

        const other = yield* makeService(undefined, "1.2.3", path.join(home, ".t3-other"));
        expect((yield* other.status).otherBaseDir).toBe(plan.baseDir);
        expect((yield* other.install().pipe(Effect.flip))._tag).toBe(
          "BootServiceOtherBaseDirError",
        );
        expect((yield* other.uninstall.pipe(Effect.flip))._tag).toBe(
          "BootServiceOtherBaseDirError",
        );

        // Non-ASCII Windows T3 home paths survive `Schedule.Service` UTF-8 task XML queries intact.
        expect(yield* service.uninstall).toBe(true);
        const unicodeHome = path.join(home, "José-Łukasz-用户", ".t3");
        const unicodeService = yield* makeService(undefined, "1.2.3", unicodeHome);
        yield* unicodeService.install();
        expect(yield* unicodeService.status).toMatchObject({
          installed: true,
          installedBaseDir: unicodeHome,
        });
        expect((yield* unicodeService.status).otherBaseDir).toBeUndefined();
        yield* unicodeService.install({ allowDowngrade: true });
        expect(yield* unicodeService.uninstall).toBe(true);
      }),
  );

  it.effect(
    "persists the Windows task name across PC renames, fails closed on unrecognized task XML, and treats transient query errors as unhealthy",
    () =>
      Effect.gen(function* () {
        const {
          service,
          makeService,
          localAppData,
          taskName,
          schtasksExe,
          control,
          fs,
          home,
          commands,
        } = yield* makeHarness("win32");
        const path = yield* Path.Path;
        const persistedTaskPath = serviceTaskNamePath(localAppData);
        const plan = yield* service.install();
        expect((yield* fs.readFileString(persistedTaskPath)).trim()).toBe(taskName);

        // Transient query failure when the local mirror exists reports `service-unhealthy` instead
        // of misclassifying an enabled task as `service-disabled`.
        control.failTaskQuery = true;
        expect((yield* service.status).problems).toContain("service-unhealthy");
        expect((yield* service.status).problems).not.toContain("service-disabled");
        control.failTaskQuery = false;

        // Live registered `<Actions>` wins over a stale local XML mirror, and an `<Actions>` block
        // without `--base-dir` fails closed instead of silently overwriting a foreign task.
        const otherHome = path.join(home, ".t3-live");
        const otherService = yield* makeService(undefined, "1.2.3", otherHome);
        control.registeredTaskXml = BootService.renderBootServiceTask(
          {
            program: [`${otherHome}/runtime/versions/1.2.3/t3.exe`, "__service-launcher"],
            baseDir: otherHome,
            logPath: `${otherHome}/userdata/logs/boot-service.log`,
            unitPath: plan.unitPath,
          },
          windowsTaskOptions,
        );
        expect((yield* service.status).otherBaseDir).toBe(otherHome);
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServiceOtherBaseDirError",
        );

        control.registeredTaskXml = [
          "<Task>",
          "  <Settings><Enabled>true</Enabled></Settings>",
          "  <Actions><Exec><Command>C:\\custom\\daemon.exe</Command><Arguments>--serve</Arguments></Exec></Actions>",
          "</Task>",
        ].join("\n");
        const unrecognized = yield* otherService.install().pipe(Effect.flip);
        expect(unrecognized).toMatchObject({
          _tag: "BootServiceOtherBaseDirError",
          unrecognizedTaskName: taskName,
        });
        expect(unrecognized.message).toContain(
          `Windows scheduled task '${taskName}' has an unrecognized configuration`,
        );
        expect((yield* otherService.status).problems).toContain("service-unhealthy");
        expect((yield* otherService.status).installedBaseDir).toBeUndefined();

        // Restore the task XML for `plan.baseDir` and simulate a workgroup PC rename (`USERDOMAIN`).
        control.registeredTaskXml = yield* fs.readFileString(plan.unitPath);
        const afterRename = yield* makeService(
          undefined,
          "1.2.3",
          plan.baseDir,
          false,
          "/usr/bin/t3",
          undefined,
          { USERDOMAIN: "RENAMED-PC" },
        );
        expect((yield* afterRename.status).installed).toBe(true);
        commands.length = 0;
        expect(yield* afterRename.uninstall).toBe(true);
        expect(commands).toContain(`${schtasksExe} /Delete /TN ${taskName} /F`);
        expect(yield* fs.exists(persistedTaskPath)).toBe(false);
      }),
  );

  it.effect(
    "restores an installed service when install is interrupted after stopping and removes unreadable POSIX units on uninstall",
    () =>
      Effect.gen(function* () {
        const { service, fs, commands, control } = yield* makeHarness();
        const plan = yield* service.install();

        // Fiber interruption after stopping the service still triggers `Effect.onExit` restoration.
        const stoppedGate = Promise.withResolvers<void>();
        const holdAfterStop = Promise.withResolvers<void>();
        control.onBeforeWriteUnit = () =>
          Effect.promise(async () => {
            stoppedGate.resolve();
            await holdAfterStop.promise;
          });
        commands.length = 0;
        const installFiber = yield* Effect.forkChild(service.install());
        yield* Effect.promise(() => stoppedGate.promise);
        expect(control.active).toBe(false);
        yield* Fiber.interrupt(installFiber);
        control.onBeforeWriteUnit = undefined;
        expect(control.active).toBe(true);
        expect(commands).toContain("systemctl --user restart t3code.service");

        // An unreadable (`0o000`) unit file still uninstalls cleanly when the directory is writable.
        yield* fs.chmod(plan.unitPath, 0o000);
        expect(yield* service.uninstall).toBe(true);
        expect(yield* fs.exists(plan.unitPath)).toBe(false);
      }),
  );

  // regression: #8173 keep provider CLIs available in the macOS service
  it.effect("reconstructs a launch agent search path when the installer has no PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("adds missing provider directories to a minimal installer PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "/usr/bin:/bin");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps an installed launch agent current when the process PATH changes", () =>
    Effect.gen(function* () {
      const { service, makeService } = yield* makeHarness("darwin");
      yield* service.install();

      const restartedService = yield* makeService("/usr/local/bin:/usr/bin:/bin");
      expect((yield* restartedService.status).current).toBe(true);
    }),
  );

  // regression: #17532
  it.effect("puts the runtime an update installs on the launch agent PATH", () =>
    Effect.gen(function* () {
      const { makeService, baseDir, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const previous = runtime.versionDir;
      const installed = pinnedRuntimePaths(path, baseDir, "1.2.4", "darwin").versionDir;
      // The 1.2.3 CLI, or the 1.2.3 service's own PATH, installs 1.2.4.
      const updated = yield* makeService(
        `/usr/bin:${previous}:/bin`,
        "1.2.4",
        undefined,
        false,
        runtime.entryPath,
      );
      const plan = yield* updated.install();

      expect(yield* FileSystem.FileSystem.use((fs) => fs.readFileString(plan.unitPath))).toContain(
        `    <key>PATH</key>\n    <string>/usr/bin:${installed}:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
    }),
  );

  it.effect("drops PATH directories that cannot be represented in a launch agent plist", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness(
        "darwin",
        "/opt/homebrew/bin:/Users/theo/\u0001invalid:/usr/bin",
      );
      const plan = yield* service.install();
      const plist = yield* fs.readFileString(plan.unitPath);

      expect(plist).toContain(
        "    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect(plist).not.toContain("\u0001");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.failCommand = "launchctl bootout --wait gui/501/com.t3tools.t3code.service";

      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps failed launch agent installs pending until activation succeeds", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();
      const markerPath = path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE);
      const bootstrap = `launchctl bootstrap gui/501 ${plan.unitPath}`;
      control.failCommand = bootstrap;

      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["restart-pending"],
      });
      expect(yield* fs.readFileString(markerPath)).toBe("1.2.3\n");

      control.failCommand = undefined;
      commands.length = 0;
      yield* service.install();

      expect(commands).toContain(bootstrap);
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );
});

const runLiveNode = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("boot service Windows control", () => {
  it.live(
    "reports unhealthy control locks, falls back to ending the task on stop, and fails closed if wedged",
    () =>
      runLiveNode(
        Effect.gen(function* () {
          const {
            service,
            makeService,
            spawnLauncher,
            taskName,
            schtasksExe,
            control,
            fs,
            commands,
          } = yield* makeHarness("win32");
          const path = yield* Path.Path;
          const plan = yield* service.install();
          const live = yield* spawnLauncher("1.2.3", false);

          expect(yield* service.status).toMatchObject({
            installed: true,
            current: true,
            problems: [],
          });

          // Incompatible older runtimes lacking Windows launcher flags fail before stopping the service.
          control.windowsLauncherFlags = false;
          expect(yield* service.install({ allowDowngrade: true }).pipe(Effect.flip)).toMatchObject({
            _tag: "BootServiceCommandError",
            step: "verifying Windows service launcher support",
          });
          expect(yield* Effect.promise(() => probeServiceLauncher(live.controlDir))).toBe(
            "running",
          );
          control.windowsLauncherFlags = true;

          // An occupied lock whose token cannot authenticate reports `service-unhealthy`, not healthy.
          control.enabled = false;
          if (control.registeredTaskXml !== undefined) {
            control.registeredTaskXml = /<Enabled>\s*(?:true|false)\s*<\/Enabled>/i.test(
              control.registeredTaskXml,
            )
              ? control.registeredTaskXml.replace(
                  /<Enabled>\s*(?:true|false)\s*<\/Enabled>/i,
                  "<Enabled>false</Enabled>",
                )
              : control.registeredTaskXml.replace(
                  /<\/Settings>/i,
                  "    <Enabled>false</Enabled>\n  </Settings>",
                );
          }
          const tokenPath = path.join(live.controlDir, "control.token");
          yield* fs.writeFileString(tokenPath, "corrupt\n");
          expect(yield* service.status).toMatchObject({
            current: false,
            problems: ["service-disabled", "service-unhealthy"],
          });

          // If `schtasks /End` does not release a wedged lock holder, stop fails closed.
          const differentlyCasedHome = path.join(path.dirname(plan.baseDir), ".T3");
          const fastFallback = yield* makeService(
            undefined,
            "1.2.3",
            differentlyCasedHome,
            false,
            "/usr/bin/t3",
            100,
          );
          expect((yield* fastFallback.status).otherBaseDir).toBeUndefined();
          let ranWhileWedged = false;
          expect(
            yield* fastFallback
              .withStopped(
                Effect.sync(() => {
                  ranWhileWedged = true;
                }),
              )
              .pipe(Effect.flip),
          ).toMatchObject({
            _tag: "BootServiceCommandError",
            step: "stopping the installed service",
          });
          expect(ranWhileWedged).toBe(false);

          // When `schtasks /End` closes the task session and releases the lock, `withStopped`
          // proceeds and restores the disabled state afterwards.
          control.stopLaunchersOnTaskEnd = true;
          commands.length = 0;
          yield* fastFallback.withStopped(
            Effect.gen(function* () {
              expect(yield* Effect.promise(() => probeServiceLauncher(live.controlDir))).toBe(
                "stopped",
              );
            }),
          );
          yield* Effect.promise(() => live.running);
          expect(control.enabled).toBe(false);
          expect(
            commands.filter(
              (command) =>
                command.startsWith(`${schtasksExe} `) &&
                !command.startsWith(`${schtasksExe} /Query `),
            ),
          ).toEqual([
            `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
            `${schtasksExe} /End /TN ${taskName}`,
            `${schtasksExe} /Change /TN ${taskName} /ENABLE`,
            `${schtasksExe} /Run /TN ${taskName}`,
            `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
          ]);
        }),
      ),
  );

  it.live(
    "serializes concurrent Windows installs, restarts, and withStopped on the account lock",
    () =>
      runLiveNode(
        Effect.gen(function* () {
          const { makeService, localAppData, home, commands } = yield* makeHarness("win32");
          const path = yield* Path.Path;
          const firstHome = path.join(home, ".t3-first");
          const first = yield* makeService(undefined, "1.2.3", firstHome);
          const second = yield* makeService(undefined, "1.2.3", path.join(home, ".t3-second"));
          const capture = <A, E>(effect: Effect.Effect<A, E>) =>
            effect.pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            );

          const outcomes = yield* Effect.all(
            [capture(first.install()), capture(second.install())],
            {
              concurrency: "unbounded",
            },
          );
          const successes = outcomes.filter((outcome) => outcome.ok);
          const failures = outcomes.filter((outcome) => !outcome.ok);
          expect(successes).toHaveLength(1);
          expect(failures).toHaveLength(1);
          expect(failures[0]?.error._tag).toBe("BootServiceOtherBaseDirError");

          // Ensure `firstHome` is the installed home, then prove both `restart` and `withStopped`
          // block at `account-task.sqlite` before issuing any `schtasks` command while the lock is held.
          const installedHome = successes[0]?.value.baseDir ?? firstHome;
          let attemptedAccountLock = Promise.withResolvers<void>();
          const contender = yield* makeService(
            undefined,
            "1.2.3",
            installedHome,
            false,
            "/usr/bin/t3",
            undefined,
            {},
            {
              restrictPathAcl: async () => undefined,
              verifyPathAcl: async (targetPath) => {
                if (targetPath.endsWith("account-task.sqlite")) {
                  queueMicrotask(() => attemptedAccountLock.resolve());
                }
                return true;
              },
            },
          );

          const accountRoot = serviceAccountControlRoot(localAppData);
          const lockForRestart = yield* Effect.promise(() =>
            acquireServiceAccountLock(accountRoot, { acl: trustedTestAcl }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => lockForRestart.close()));
          commands.length = 0;
          const restartFiber = yield* Effect.forkScoped(contender.restart);
          yield* Effect.promise(() => attemptedAccountLock.promise);
          expect(commands).toEqual([]);
          lockForRestart.close();
          expect(yield* Fiber.join(restartFiber)).toBe("restarted");

          attemptedAccountLock = Promise.withResolvers<void>();
          const lockForWithStopped = yield* Effect.promise(() =>
            acquireServiceAccountLock(accountRoot, { acl: trustedTestAcl }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => lockForWithStopped.close()));
          commands.length = 0;
          const withStoppedFiber = yield* Effect.forkScoped(
            contender.withStopped(Effect.succeed("repair-finished")),
          );
          yield* Effect.promise(() => attemptedAccountLock.promise);
          expect(commands).toEqual([]);
          lockForWithStopped.close();
          expect(yield* Fiber.join(withStoppedFiber)).toBe("repair-finished");
        }),
      ),
  );

  it.live(
    "hands in-service install, restart, and uninstall to Task Scheduler and the control channel",
    () =>
      runLiveNode(
        Effect.gen(function* () {
          const {
            service,
            spawnLauncher,
            taskName,
            schtasksExe,
            control,
            fs,
            statePath,
            commands,
            makeService,
          } = yield* makeHarness("win32");
          const path = yield* Path.Path;
          const plan = yield* service.install();
          const inside = yield* makeService(undefined, "1.2.4", undefined, true);
          const nonQuerySchtasks = () =>
            commands.filter(
              (command) =>
                command.startsWith(`${schtasksExe} `) &&
                !command.startsWith(`${schtasksExe} /Query `),
            );
          const handoff = [
            `${schtasksExe} /Create /XML ${plan.unitPath} /TN ${taskName} /F`,
            `${schtasksExe} /End /TN ${taskName}`,
            `${schtasksExe} /Run /TN ${taskName}`,
          ];

          // A remote update accepted over IPC blocks an in-service install serialized over control.
          const pending = yield* spawnLauncher("1.2.3", true);
          expect(yield* inside.install().pipe(Effect.flip)).toMatchObject({
            _tag: "BootServiceUpdatePendingError",
          });
          yield* Effect.promise(() => pending.launcher.stop("SIGTERM"));
          yield* Effect.promise(() => pending.running);
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.2.3",
            }),
          );

          const active = yield* spawnLauncher("1.2.3", false);
          commands.length = 0;
          expect(yield* inside.install()).toMatchObject({ handedOff: true, logPath: plan.logPath });
          yield* Effect.promise(() => active.running);
          expect(nonQuerySchtasks()).toEqual(handoff);
          expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe(
            "1.2.4",
          );
          expect(
            yield* fs.readFileString(`${plan.baseDir}/runtime/${SERVICE_RESTART_PENDING_FILE}`),
          ).toBe("1.2.4\n");

          const restarted = yield* spawnLauncher("1.2.4", false);
          commands.length = 0;
          expect(yield* inside.restart).toBe("queued");
          yield* Effect.promise(() => restarted.running);
          expect(nonQuerySchtasks()).toEqual(handoff);

          // In-service uninstall fails closed BEFORE deleting the task or mirror if the control
          // channel is unhealthy (for example, a corrupt token), then succeeds once healthy.
          const uninstalled = yield* spawnLauncher("1.2.4", false);
          const tokenPath = path.join(uninstalled.controlDir, "control.token");
          const validToken = yield* fs.readFileString(tokenPath);
          yield* fs.writeFileString(tokenPath, "corrupt\n");
          commands.length = 0;
          expect(yield* inside.uninstall.pipe(Effect.flip)).toMatchObject({
            _tag: "BootServiceCommandError",
            step: "stopping the installed service",
          });
          expect(control.taskRegistered).toBe(true);
          expect(yield* fs.exists(plan.unitPath)).toBe(true);
          expect(nonQuerySchtasks()).toEqual([]);

          yield* fs.writeFileString(tokenPath, validToken);
          commands.length = 0;
          expect(yield* inside.uninstall).toBe(true);
          yield* Effect.promise(() => uninstalled.running);
          expect(yield* fs.exists(plan.unitPath)).toBe(false);
          expect((yield* service.status).installed).toBe(false);
          expect(nonQuerySchtasks()).toEqual([
            `${schtasksExe} /Change /TN ${taskName} /DISABLE`,
            `${schtasksExe} /Delete /TN ${taskName} /F`,
          ]);

          // If a previous in-service uninstall already removed the scheduled task and mirror while
          // the launcher remained alive with a pending trial, retrying `uninstall` finishes stopping
          // the launcher and recovers the pre-trial database backup.
          const dbPath = path.join(plan.baseDir, "userdata", "state.sqlite");
          const orphanedLauncher = yield* spawnLauncher("1.2.4", true);
          expect((yield* Effect.promise(() => readServiceState(statePath))).update?.status).toBe(
            "pending",
          );
          yield* fs.writeFileString(dbPath, "corrupted-during-trial");
          expect(yield* inside.uninstall).toBe(true);
          yield* Effect.promise(() => orphanedLauncher.running);
          expect(yield* fs.readFileString(dbPath)).toBe("db");
          expect((yield* Effect.promise(() => readServiceState(statePath))).update?.status).toBe(
            "failed",
          );
          expect(yield* inside.uninstall).toBe(false);

          // Reinstalling while uninstalled with an unrecovered pending update fails closed and
          // surfaces the PowerShell foreground recovery command for the installed version.
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: "1.2.4",
              update: {
                id: "u-win",
                fromVersion: "1.2.4",
                targetVersion: "9.9.9",
                dbPath,
                status: "pending",
              },
            }),
          );
          const pendingError = yield* service.install().pipe(Effect.flip);
          expect(pendingError).toMatchObject({
            _tag: "BootServiceUpdatePendingError",
          });
          expect(pendingError.message).toContain(
            `__service-launcher --base-dir '${plan.baseDir.replaceAll("'", "''")}'`,
          );
        }),
      ),
  );
});
