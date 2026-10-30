import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

it("reads the served T3 home back out of a rendered unit or plist", () => {
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
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();

  const plist = (value: string, between = "") =>
    `<plist version="1.0">\n<dict>\n\t<key>T3CODE_HOME</key>${between}\n\t<string>${value}</string>\n</dict>\n</plist>\n`;
  expect(BootService.bootServiceBaseDirOf(plist("/tmp/T3&#32;saved&#x2F;&quot;a&apos;"))).toBe(
    `/tmp/T3 saved/"a'`,
  );
  expect(BootService.bootServiceBaseDirOf(plist("/tmp/&amp;#32;"))).toBe("/tmp/&#32;");
  const unit = BootService.renderBootServiceUnit(plan("/home/theo/.t3"));
  // Hand-written homes this parser cannot read with certainty stay unknown, not misread.
  for (const unknown of [
    plist("/tmp/T3", "<!-- moved -->"),
    plist("/tmp/&#0;"),
    plist("/tmp/&#xD800;"),
    plist("/tmp/&nbsp;"),
    plist("/tmp/&constructor;"),
    plist("/tmp/a&b"),
    `${plist("/tmp/a")}${plist("/tmp/b")}`,
    '[Service]\nEnvironment="T3CODE_HOME=/srv/t3"\n',
    "[Service]\nEnvironment=PORT=3773 T3CODE_HOME=/srv/t3\n",
    '[Service]\nEnvironment=T3CODE_HOME="/srv/t3" PORT=3773\n',
    "[Service]\nEnvironment=T3CODE_HOME=%h/.t3\n",
    '[Service]\nEnvironment=T3CODE_HOME="/srv/t3\\n"\n',
    `${unit}EnvironmentFile=/srv/t3.env\n`,
    `${unit}Environment=T3CODE_HOME=/srv/t3\n`,
  ]) {
    expect(BootService.bootServiceBaseDirOf(unknown), unknown).toBeUndefined();
  }
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
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const timeouts = new Map<string, unknown>();
  const control: {
    failCommand: string | undefined;
    stateAfterStop?: string;
    linger: string;
    enabled: boolean;
    active: boolean;
  } = {
    failCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      invocations.push(input);
      timeouts.set(command, input.timeout);
      const failed = command === control.failCommand;
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && command === "systemctl --user enable t3code.service") control.enabled = true;
      if (!failed && command === "systemctl --user restart t3code.service") control.active = true;
      // A timed-out stop may still stop the service.
      if (command === "systemctl --user stop t3code.service") control.active = false;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop t3code.service" ||
          command.startsWith("launchctl bootout --wait "))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      return {
        stdout:
          input.args[0] === "--version"
            ? `t3 v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
            : input.command === "loginctl" && input.args[0] === "show-user"
              ? `${control.linger}\n`
              : input.args[1] === "is-enabled"
                ? control.enabled
                  ? "enabled\n"
                  : "disabled\n"
                : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed ||
            (input.args[1] === "is-active" && !control.active) ||
            (input.args[1] === "is-enabled" && !control.enabled)
            ? 1
            : 0,
        ),
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
        host: { execPath: "/usr/bin/t3" },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.UserId, 501),
          Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/t3"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no release download expected")),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
                ...(insideService ? { T3_BOOT_SERVICE_UNIT: "t3code.service" } : {}),
              },
            }),
          ),
        ),
      ),
    );
  const service = yield* makeService();
  return {
    service,
    makeService,
    fs,
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

  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, timeouts, runtime } = yield* makeHarness();
      const plan = yield* service.install();

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
      }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      yield* fs.remove(statePath);
      yield* fs.makeDirectory(statePath);
      yield* fs.writeFileString(path.join(statePath, "occupied"), "");

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
    }),
  );

  it.effect("pauses only this home's running service for maintenance, even when it fails", () =>
    Effect.gen(function* () {
      const { service, commands, control, makeService } = yield* makeHarness();
      yield* service.install();
      const failure = yield* service
        .withStopped(
          Effect.suspend(() => Effect.fail(control.active ? "running" : "repair failed")),
        )
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
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      expect(yield* other.restart).toBe("skipped");
      expect((yield* other.install().pipe(Effect.flip))._tag).toBe("BootServiceOtherBaseDirError");
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(commands).toEqual([]);
      expect((yield* other.status).otherBaseDir).toBe(baseDir);
    }),
  );

  it.effect.each([
    ["linux", '[Service]\nEnvironment="T3CODE_HOME=/srv/t3"\nExecStart=/srv/t3/t3\n'],
    ["linux", "[Service]\nEnvironment=PORT=3773 T3CODE_HOME=/srv/t3\nExecStart=/srv/t3/t3\n"],
    ["linux", "[Service]\nEnvironmentFile=/srv/t3.env\nExecStart=/srv/t3/t3\n"],
    [
      "darwin",
      "<plist>\n<dict>\n\t<key>T3CODE_HOME</key><!-- moved -->\n\t<string>/srv/t3</string>\n</dict>\n</plist>\n",
    ],
    ["linux", undefined],
  ] as const)(
    "restart and install leave a %s service whose T3 home they cannot read alone",
    ([platform, contents]) =>
      Effect.gen(function* () {
        const { service, fs, commands } = yield* makeHarness(platform);
        const { unitPath } = yield* service.status;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(contents === undefined ? unitPath : path.dirname(unitPath), {
          recursive: true,
        });
        if (contents !== undefined) yield* fs.writeFileString(unitPath, contents);
        commands.length = 0;

        expect(yield* service.restart).toBe("skipped");
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          contents === undefined ? "BootServiceInstallError" : "BootServiceUnknownBaseDirError",
        );
        expect(commands).toEqual([]);
        if (contents !== undefined) {
          expect(yield* fs.readFileString(unitPath)).toBe(contents);
          expect(yield* service.status).toMatchObject({ unknownBaseDir: true, current: false });
        }
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
