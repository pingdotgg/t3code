import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  launcherOwnsVersionsDir,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";
import type { BootServiceError, BootServicePlan, BootServiceProblem, BootServiceStatus, BootServiceStep } from "./bootService-part2.ts";
import { BOOT_SERVICE_LAUNCHD_LABEL, BOOT_SERVICE_LOG_FILE, BOOT_SERVICE_UNIT_ENV, BOOT_SERVICE_UNIT_FILE, BootServiceCommandError, BootServiceDowngradeRefusedError, BootServiceInstallError, BootServicePrerequisiteError, BootServiceUnsupportedError, BootServiceUpdatePendingError, bootServiceBaseDirOf, readSystemdUnitDirectory, selectBootServiceManager } from "./bootService-part2.ts";

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (options?: {
      readonly allowDowngrade?: boolean;
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone, which resolves `skipped`. From
     * inside the service the restart can only be `queued` with the service
     * manager, since the stop ends this process.
     */
    readonly restart: Effect.Effect<"restarted" | "queued" | "skipped", BootServiceError>;
    /**
     * Runs the operation with this home's service stopped; other homes are left alone.
     * Restores a previously enabled or loaded service even if stopping failed.
     * The operation's failure takes precedence over a restart failure.
     */
    readonly withStopped: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BootServiceError, R>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const uid = yield* HostProcess.UserId;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const xdgConfigHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const runningInsideService =
    (yield* Config.String(BOOT_SERVICE_UNIT_ENV).pipe(Config.withDefault(""))) ===
    BOOT_SERVICE_UNIT_FILE;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion, platform);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );
  // During an update, the running CLI and a PATH inherited from the service name the runtime
  // being replaced. The service and its agent shells should find the runtime it starts.
  const environmentPath = Array.from(
    new Set(
      [
        ...xmlSafeInstallerDirectories,
        path.dirname(host.execPath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].map((directory) =>
        launcherOwnsVersionsDir(path, versionsDir, directory) ? runtimePaths.versionDir : directory,
      ),
    ),
  ).join(":");

  const systemdUnitDir = platform === "linux" ? yield* readSystemdUnitDirectory() : undefined;
  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    xdgConfigHome,
    systemdUnitDir,
    uid,
    path,
    environmentPath,
  });
  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        // Opened read-write: Windows refuses to flush a handle without write access.
        yield* (yield* fs.open(tempPath, { flag: "r+" })).sync;
        yield* fs.rename(tempPath, filePath);
        // Windows has no directory fsync (EPERM); NTFS journals the rename.
        yield* (yield* fs.open(directory, { flag: "r" })).sync.pipe(
          Effect.catchIf(
            (error) => (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM",
            () => Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const plan: BootServicePlan = {
    program: [runtimePaths.entryPath, "__service-launcher"],
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const logFailure = (error: { readonly message: string }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError(logFailure),
    );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(
          entry.step,
          entry.command,
          entry.args,
          entry.timeout === undefined ? undefined : { timeout: entry.timeout },
        );
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const probe = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.seconds(5) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  const lingerArgs = [
    "show-user",
    ...(uid === undefined ? [] : [String(uid)]),
    "--property=Linger",
    "--value",
  ];
  const readSystemdProblems = Effect.fn("cloud.boot_service.read_systemd_problems")(function* (
    includeService: boolean,
  ) {
    const [manager, linger] = yield* Effect.all(
      [probe("systemctl", ["--user", "show-environment"]), probe("loginctl", lingerArgs)],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (!succeeded(manager)) problems.push("user-manager-unavailable");
    const lingering = succeeded(linger) && Option.isSome(linger) ? linger.value.stdout.trim() : "";
    if (lingering !== "yes") {
      problems.push(lingering === "no" ? "linger-disabled" : "linger-unavailable");
    }
    if (includeService && succeeded(manager)) {
      const [enabled, active] = yield* Effect.all(
        [
          probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
          probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !succeeded(enabled) ||
        (Option.isSome(enabled) && enabled.value.stdout.trim() !== "enabled")
      ) {
        problems.push("service-disabled");
      }
      if (!succeeded(active)) problems.push("service-stopped");
    }
    return problems;
  });

  const requireSystemdPrerequisites = Effect.gen(function* () {
    const problems = yield* readSystemdProblems(false);
    const unavailable = problems.find((problem) => problem !== "linger-disabled");
    if (unavailable) return yield* new BootServicePrerequisiteError({ problem: unavailable });
    if (!problems.includes("linger-disabled")) return;
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        (cause) => new BootServicePrerequisiteError({ problem: "linger-disabled", cause }),
      ),
    );
    const remaining = yield* readSystemdProblems(false);
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [...pinnedRuntimeCommand(runtime).args, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned t3 runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned t3 runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // With start=false, changing startup-only files is safe except during a remote update,
    // when the launcher also writes its state file.
    const start = options?.start !== false;
    if (installed && start && runningInsideService && manager.kind === "systemd") {
      // Stopping the unit from inside it kills this process before the start.
      // A transient unit runs the same install from outside, stop first, so it
      // still serialises with a remote update the launcher may be starting.
      yield* runStep("handing the install to a transient unit", "systemd-run", [
        "--user",
        "--collect",
        "--quiet",
        // Transient properties reach systemd literally, unlike unit-file specifiers.
        `--property=StandardOutput=append:${logPath}`,
        `--property=StandardError=append:${logPath}`,
        `--setenv=${BOOT_SERVICE_UNIT_ENV}=`,
        runtimePaths.entryPath,
        "service",
        "install",
        "--base-dir",
        // systemd expands $VAR in arguments (not in the executable path).
        input.baseDir.replaceAll("$", () => "$$"),
        ...(options?.allowDowngrade === true ? ["--allow-downgrade"] : []),
      ]);
      return { ...plan, handedOff: true };
    }
    if (installed && start) {
      yield* runSteps(manager.stop);
    }

    yield* Effect.gen(function* () {
      if (installed) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
        if (Option.isSome(previousStateText)) {
          if (serviceStateHasPendingUpdate(previousStateText.value)) {
            return yield* new BootServiceUpdatePendingError();
          }
          // Read the final version after stopping the launcher; a remote update may finish after the status check.
          const installedVersion = serviceStateActiveVersion(previousStateText.value);
          if (
            installedVersion !== undefined &&
            options?.allowDowngrade !== true &&
            compareExactServiceVersions(input.cliVersion, installedVersion) < 0
          ) {
            return yield* new BootServiceDowngradeRefusedError({
              installedVersion,
              targetVersion: input.cliVersion,
            });
          }
        }
      }
      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      // Files can match the new version even when activation fails; keep that install retryable.
      yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      if (!start && installed) {
        // A concurrent remote update can overwrite launcher state; detect it before repointing the unit.
        const written = yield* fs.readFileString(statePath);
        if (serviceStateActiveVersion(written) !== input.cliVersion) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* writeDurably(unitPath, manager.render(plan));

      if (start) {
        yield* runSteps(manager.activate);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      Effect.tapError(() =>
        installed && start ? runSteps(manager.restart).pipe(Effect.ignore) : Effect.void,
      ),
    );
    return plan;
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return "skipped" as const;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return "skipped" as const;
    }
    // Writes no state, and the launcher lets an update transition in flight
    // finish before the queued stop tears it down.
    if (runningInsideService && manager.handoff !== undefined) {
      yield* runSteps(manager.handoff);
      return "queued" as const;
    }
    yield* runSteps(manager.stop);
    yield* runSteps(manager.activate).pipe(
      Effect.tapError(() => runSteps(manager.restart).pipe(Effect.ignore)),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return "restarted" as const;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const withStopped = Effect.fn("cloud.boot_service.with_stopped")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | BootServiceError, R> {
    if (detectedManager === undefined) return yield* operation;
    const manager = detectedManager;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return yield* operation;
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return yield* operation;
    }
    // `is-active` misses crash-looping systemd units; launchd can be loaded without a pid.
    // Always stop; restore only if previously active, enabled, or loaded,
    // so disabled crash loops stay stopped.
    const restore =
      manager.kind === "systemd"
        ? yield* Effect.map(
            Effect.all(
              [
                probe("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]),
                probe("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]),
              ],
              { concurrency: "unbounded" },
            ),
            ([enabled, active]) => succeeded(active) || succeeded(enabled),
          )
        : succeeded(
            yield* probe("launchctl", ["print", `gui/${uid}/${BOOT_SERVICE_LAUNCHD_LABEL}`]),
          );
    return yield* Effect.acquireUseRelease(
      // Require every stop before repair when restoring, so the server releases the database.
      // Otherwise stops are best-effort; launchd rejects bootout of an unloaded job.
      // A failed stop may still stop the service, so restoration runs either way.
      runSteps(manager.stop.map((step) => ({ ...step, optional: !restore }))).pipe(Effect.exit),
      (stopped): Effect.Effect<A, E | BootServiceError, R> =>
        Exit.isSuccess(stopped) ? operation : Effect.failCause(stopped.cause),
      (_, exit) => {
        if (!restore) return Effect.void;
        // Start only: `activate` would also enable a unit the user disabled.
        // When the operation itself failed, its error is the one worth reporting.
        const start = runSteps(manager.restart);
        return Exit.isFailure(exit) ? Effect.ignore(start) : start;
      },
    );
  });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return false;
    yield* runSteps(manager.deactivate);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runSteps(manager.finalize);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    if (!(yield* fs.exists(unitPath))) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const [unit, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
      fs.readFileString(unitPath),
      fs.exists(runtimePaths.entryPath),
      fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
      fs.readFileString(statePath).pipe(Effect.option),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir = bootServiceBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd" ? [...(yield* readSystemdProblems(true))] : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, restart, withStopped, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
export * from "./bootService-part2.ts";
