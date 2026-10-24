import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
  const starts: Array<{
    program: string | undefined;
    state: string | undefined;
    marker: string | undefined;
  }> = [];
  const control: {
    failCommand: string | undefined;
    failOnce?: boolean;
    beforeCommand?: (command: string) => Effect.Effect<void>;
    loadedUnit?: string | undefined;
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
      if (control.beforeCommand !== undefined) yield* control.beforeCommand(command);
      const failed = command === control.failCommand;
      if (failed && control.failOnce) control.failCommand = undefined;
      if (!failed && command === "systemctl --user daemon-reload") {
        control.loadedUnit = yield* fs
          .readFileString(path.join(home, ".config", "systemd", "user", "t3code.service"))
          .pipe(Effect.orElseSucceed(() => undefined));
      }
      if (
        command === "systemctl --user restart t3code.service" ||
        command.startsWith("launchctl bootstrap ")
      ) {
        const unit =
          platform === "linux"
            ? control.loadedUnit
            : yield* fs.readFileString(input.args[2]!).pipe(Effect.orDie);
        const selectedHome = unit === undefined ? baseDir : BootService.bootServiceBaseDirOf(unit);
        const selectedRuntime = path.join(selectedHome ?? baseDir, "runtime");
        starts.push({
          program: unit === undefined ? undefined : BootService.bootServiceProgramOf(unit),
          state: yield* fs
            .readFileString(path.join(selectedRuntime, "service-state.json"))
            .pipe(Effect.orElseSucceed(() => undefined)),
          marker: yield* fs
            .readFileString(path.join(selectedRuntime, SERVICE_RESTART_PENDING_FILE))
            .pipe(Effect.orElseSucceed(() => undefined)),
        });
      }
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && command === "systemctl --user enable t3code.service") control.enabled = true;
      if (!failed && command === "systemctl --user restart t3code.service") control.active = true;
      // A stop that fails (a timeout, say) has still stopped the service.
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
    fileSystem = fs,
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
      Effect.provideService(FileSystem.FileSystem, fileSystem),
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
    starts,
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
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
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

  it.effect.each(["linux", "darwin"] as const)(
    "a host upgrade persists the newer launcher and server across a full restart on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const retained = [
          [path.join(baseDir, SERVICE_ENV_FILE), 'T3CODE_TOKEN="literal $HOME # token"\r\n'],
          [path.join(baseDir, "userdata", "settings.json"), '{"continueThreads":true}\n'],
          [path.join(baseDir, "userdata", "secrets", "server-signing-key.bin"), "auth key\0"],
          [path.join(baseDir, "userdata", "statev2.sqlite"), "threads and auth sessions"],
        ] as const;
        for (const [filePath, contents] of retained) {
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        yield* service.install();
        const newer = yield* makeService(undefined, "1.2.4");

        const plan = yield* newer.install();
        expect(BootService.bootServiceProgramOf(yield* fs.readFileString(plan.unitPath))).toBe(
          pinnedRuntimePaths(path, baseDir, "1.2.4", platform).entryPath,
        );
        expect(starts.at(-1)).toMatchObject({
          program: plan.program[0],
          state: yield* fs.readFileString(statePath),
        });
        expect(parseServiceState(starts.at(-1)!.state!)?.activeVersion).toBe("1.2.4");

        const fresh = yield* makeService(undefined, "1.2.4");
        yield* fresh.restart;
        expect(starts.at(-1)).toEqual({
          program: plan.program[0],
          state: yield* fs.readFileString(statePath),
          marker: undefined,
        });
        for (const [filePath, contents] of retained) {
          expect(yield* fs.readFileString(filePath)).toBe(contents);
        }
      }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "refreshing only the launcher preserves the committed update and rollback runtime on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, starts, makeService } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const committed = JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
          update: {
            id: "remote-update",
            fromVersion: "1.2.3",
            targetVersion: "1.2.4",
            status: "committed",
          },
        });
        yield* fs.writeFileString(statePath, committed);
        const newer = yield* makeService(undefined, "1.2.4");

        yield* newer.install();

        expect(yield* fs.readFileString(statePath)).toBe(committed);
        expect(starts.at(-1)?.state).toBe(committed);
        expect(BootService.bootServiceProgramOf(yield* fs.readFileString(plan.unitPath))).toContain(
          "/versions/1.2.4/t3",
        );
      }),
  );

  it.effect.each(
    (["linux", "darwin"] as const).flatMap((platform) =>
      (["failure", "interruption"] as const).map((outcome) => ({ platform, outcome })),
    ),
  )(
    "keeps the replacement selection after a start command $outcome may have migrated the database on $platform",
    ({ platform, outcome }) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, commands, control, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");
        yield* fs.writeFileString(databasePath, "original database");
        const startCommand =
          platform === "linux"
            ? "systemctl --user restart t3code.service"
            : `launchctl bootstrap gui/501 ${plan.unitPath}`;
        const replacementState = JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
          update: {
            id: "replacement-committed",
            fromVersion: "1.2.3",
            targetVersion: "1.2.4",
            status: "committed",
          },
        });
        const reached = yield* Deferred.make<void>();
        let started = false;
        control.beforeCommand = (command) =>
          Effect.gen(function* () {
            if (command !== startCommand || started) return;
            started = true;
            // The manager can launch the server before returning an error or hanging.
            yield* fs.writeFileString(databasePath, "replacement migrated database");
            yield* fs.writeFileString(statePath, replacementState);
            if (outcome === "interruption") {
              yield* Deferred.succeed(reached, undefined);
              return yield* Effect.never;
            }
          }).pipe(Effect.orDie);
        control.failCommand = startCommand;
        control.failOnce = true;
        const newer = yield* makeService(undefined, "1.2.4");
        commands.length = 0;
        starts.length = 0;

        if (outcome === "interruption") {
          const installing = yield* newer.install().pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(installing);
          expect(Exit.hasInterrupts(yield* Fiber.await(installing))).toBe(true);
        } else {
          expect((yield* newer.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
        }

        const replacement = pinnedRuntimePaths(path, baseDir, "1.2.4", platform).entryPath;
        expect(BootService.bootServiceProgramOf(yield* fs.readFileString(plan.unitPath))).toBe(
          replacement,
        );
        expect(yield* fs.readFileString(statePath)).toBe(replacementState);
        expect(yield* fs.readFileString(databasePath)).toBe("replacement migrated database");
        expect(
          yield* fs.readFileString(path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE)),
        ).toBe("1.2.4\n");
        expect(commands.at(-1)).toBe(startCommand);
        expect(starts.every((entry) => entry.program === replacement)).toBe(true);
      }),
  );

  it.effect.each(
    (["linux", "darwin"] as const).flatMap((platform) =>
      (
        [
          "activation",
          "state write",
          "unit write",
          "stop interruption",
          "activation interruption",
          "state write interruption",
          "unit write interruption",
        ] as const
      )
        // launchd's enable step is optional; bootstrap itself may already start the server.
        .filter((stage) => platform === "linux" || stage !== "activation")
        .map((stage) => ({ platform, stage })),
    ),
  )(
    "restores the previous selection before restarting after $stage on $platform",
    ({ platform, stage }) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, commands, control, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        const state = yield* fs.readFileString(statePath);
        const retained = [
          [path.join(baseDir, SERVICE_ENV_FILE), 'T3CODE_TOKEN="literal $HOME # token"\r\n'],
          [path.join(baseDir, "userdata", "settings.json"), '{"continueThreads":true}\n'],
          [path.join(baseDir, "userdata", "secrets", "server-signing-key.bin"), "auth key\0"],
          [path.join(baseDir, "userdata", "statev2.sqlite"), "threads and auth sessions"],
        ] as const;
        for (const [filePath, contents] of retained) {
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        const settledState = JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.3",
          update: {
            id: "finished-while-stopping",
            fromVersion: "1.2.2",
            targetVersion: "1.2.3",
            status: "committed",
          },
        });
        control.stateAfterStop = settledState;
        const previousState = stage === "stop interruption" ? state : settledState;
        const markerPath = path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
        const marker = stage === "activation" || stage === "state write" ? undefined : "1.2.3\n";
        if (marker !== undefined) yield* fs.writeFileString(markerPath, marker);
        const reached = yield* Deferred.make<void>();
        let injected = false;
        const activation =
          platform === "linux"
            ? "systemctl --user enable t3code.service"
            : "launchctl enable gui/501/com.t3tools.t3code.service";
        if (stage === "activation") {
          control.failCommand = activation;
          control.failOnce = true;
        }
        control.beforeCommand = (command) => {
          const selected =
            stage === "stop interruption"
              ? command === "systemctl --user stop t3code.service" ||
                command.startsWith("launchctl bootout ")
              : stage === "activation interruption" && command === activation;
          if (!selected || injected) return Effect.void;
          injected = true;
          return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never));
        };
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fs.rename(from, to);
              const selected =
                stage === "state write" || stage === "state write interruption"
                  ? to === statePath
                  : (stage === "unit write" || stage === "unit write interruption") &&
                    to === plan.unitPath;
              if (!selected || injected) return;
              injected = true;
              if (stage.includes("interruption")) {
                yield* Deferred.succeed(reached, undefined);
                return yield* Effect.never;
              } else {
                // The replacement already landed; fail like a post-rename directory fsync.
                yield* fs.rename(from, to);
              }
            }),
        });
        const newer = yield* makeService(undefined, "1.2.4", baseDir, false, fileSystem);
        starts.length = 0;
        commands.length = 0;
        if (stage.includes("interruption")) {
          const installing = yield* newer.install().pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(installing);
          expect(Exit.hasInterrupts(yield* Fiber.await(installing))).toBe(true);
        } else {
          expect((yield* newer.install().pipe(Effect.flip))._tag).toBe(
            stage === "activation" ? "BootServiceCommandError" : "BootServiceInstallError",
          );
        }

        expect(starts.at(-1)).toEqual({ program: plan.program[0], state: previousState, marker });
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(yield* fs.readFileString(statePath)).toBe(previousState);
        expect(
          yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => undefined)),
        ).toBe(marker);
        for (const [filePath, contents] of retained) {
          expect(yield* fs.readFileString(filePath)).toBe(contents);
        }
      }),
  );

  it.effect.each(
    (["linux", "darwin"] as const).flatMap((platform) =>
      (["state", "unit"] as const).flatMap((failedRestore) =>
        [false, true].map((hasMarker) => ({ platform, failedRestore, hasMarker })),
      ),
    ),
  )(
    "restores remaining files and leaves the service stopped after $failedRestore restore failure on $platform (marker: $hasMarker)",
    ({ platform, failedRestore, hasMarker }) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, commands, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const markerPath = path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
        if (hasMarker) yield* fs.writeFileString(markerPath, "1.2.3\n");
        let stateWrites = 0;
        let unitWrites = 0;
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (to === statePath && ++stateWrites === 2 && failedRestore === "state") {
                return yield* fs.rename(path.join(baseDir, "missing-restore-source"), to);
              }
              if (to === plan.unitPath && ++unitWrites === 2 && failedRestore === "unit") {
                return yield* fs.rename(path.join(baseDir, "missing-restore-source"), to);
              }
              yield* fs.rename(from, to);
              if (to === plan.unitPath && unitWrites === 1) {
                yield* fs.rename(from, to);
              }
            }),
        });
        const newer = yield* makeService(undefined, "1.2.4", baseDir, false, fileSystem);
        commands.length = 0;
        starts.length = 0;

        expect((yield* newer.install().pipe(Effect.flip))._tag).toBe("BootServiceInstallError");

        expect(starts).toHaveLength(0);
        expect(commands.at(-1)).toBe(
          platform === "linux"
            ? "systemctl --user stop t3code.service"
            : "launchctl bootout --wait gui/501/com.t3tools.t3code.service",
        );
        expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe(
          failedRestore === "state" ? "1.2.4" : "1.2.3",
        );
        expect(BootService.bootServiceProgramOf(yield* fs.readFileString(plan.unitPath))).toBe(
          pinnedRuntimePaths(path, baseDir, failedRestore === "unit" ? "1.2.4" : "1.2.3", platform)
            .entryPath,
        );
        expect(
          yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => undefined)),
        ).toBe(hasMarker ? "1.2.3\n" : undefined);
        const log = yield* fs.readFileString(plan.logPath);
        expect(log).toContain("Could not set up the T3 Code background service.");
        expect(log).toContain(
          "Restoring the previous background service failed. The service was left stopped.",
        );
        expect(log).not.toContain("missing-restore-source");
      }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "a failed install for another home restores its absent state and the previous home's service on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        const state = yield* fs.readFileString(statePath);
        const markerPath = path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
        yield* fs.writeFileString(markerPath, "1.2.3\n");
        const otherHome = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-service-install-other-",
        });
        let unitWritten = false;
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fs.rename(from, to);
              if (to === plan.unitPath && !unitWritten) {
                unitWritten = true;
                yield* fs.rename(from, to);
              }
            }),
        });
        const other = yield* makeService(undefined, "1.2.4", otherHome, false, fileSystem);

        expect((yield* other.install().pipe(Effect.flip))._tag).toBe("BootServiceInstallError");

        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(yield* fs.readFileString(statePath)).toBe(state);
        expect(yield* fs.readFileString(markerPath)).toBe("1.2.3\n");
        expect(yield* fs.exists(path.join(otherHome, "runtime", "service-state.json"))).toBe(false);
        expect(
          yield* fs.exists(path.join(otherHome, "runtime", SERVICE_RESTART_PENDING_FILE)),
        ).toBe(false);
        expect(starts.at(-1)).toEqual({ program: plan.program[0], state, marker: "1.2.3\n" });
      }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "restarts a stopped pending update with its original database snapshot association on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, starts, control, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        const dbPath = path.join(baseDir, "custom", "actual.sqlite");
        const backupPath = path.join(baseDir, "runtime", "db-backup", "pending-update", "database");
        for (const filePath of [dbPath, backupPath, `${backupPath}-wal`]) {
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, filePath);
        }
        const pending = JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.3",
          update: {
            id: "pending-update",
            fromVersion: "1.2.3",
            targetVersion: "1.2.4",
            dbPath,
            status: "pending",
          },
        });
        control.stateAfterStop = pending;
        const newer = yield* makeService(undefined, "1.2.4");

        expect((yield* newer.install().pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );

        expect(starts.at(-1)).toEqual({
          program: plan.program[0],
          state: pending,
          marker: undefined,
        });
        expect(yield* fs.readFileString(statePath)).toBe(pending);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        for (const filePath of [dbPath, backupPath, `${backupPath}-wal`]) {
          expect(yield* fs.readFileString(filePath)).toBe(filePath);
        }
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

      // A failed stop skips the operation but still starts the service again.
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

      // An enabled unit that is not active (crash-looping in auto-restart, say)
      // is still stopped for the repair and started again afterwards.
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
      // A running unit the user disabled is started again but stays disabled.
      control.enabled = false;
      yield* service.withStopped(Effect.void);
      expect(control).toMatchObject({ active: true, enabled: false });
      // A unit that was neither enabled nor active stays stopped.
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

  it.effect("restart leaves a service that serves another T3 home alone", () =>
    Effect.gen(function* () {
      const { service, fs, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      expect(yield* other.restart).toBe("skipped");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([]);
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
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
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
