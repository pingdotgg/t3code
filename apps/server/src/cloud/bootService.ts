import {
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  parseServiceState,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.launcherPath)}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agent tool calls run as children of the server, so they share this cgroup.
    // With the systemd default of OOMPolicy=stop, the kernel killing one greedy
    // child stops the whole unit: the server, every live agent, and the user's
    // connection. Keep running and let Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Plist values are emitted as XML text nodes; only these three need escaping. */
export function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string },
): string {
  // KeepAlive + ThrottleInterval mirror Restart=always + RestartSec=5. launchd
  // has no StartLimitBurst analog; a hard crash loop respawns every 5s forever.
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXmlText(plan.nodePath)}</string>`,
    `    <string>${escapeXmlText(plan.launcherPath)}</string>`,
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>T3CODE_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored. Reserved for steps whose common
   * failures (not loaded, already enabled) leave a state a later strict step
   * either tolerates or fails loudly on.
   */
  readonly optional?: boolean;
  /** Override the ProcessRunner default (60s) for steps that block longer. */
  readonly timeout?: Duration.Input;
}

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

/**
 * Platform service-manager integration as data: paths, a pure renderer, and
 * the command steps each flow runs. install/uninstall/status consume this and
 * never branch on platform.
 */
export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  /** Before rewriting files, when a unit is already installed. */
  readonly stop: ReadonlyArray<BootServiceStep>;
  /** After files are written. The last entry starts the service. */
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** Best-effort recovery after a failed repair of an installed service. */
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Uninstall, before the unit file is removed. */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Uninstall, after the unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

export function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    ".config",
    "systemd",
    "user",
    BOOT_SERVICE_UNIT_FILE,
  );
  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        step: "enabling the service",
        command: "systemctl",
        args: ["--user", "enable", BOOT_SERVICE_UNIT_FILE],
      },
      { step: "enabling lingering for this user", command: "loginctl", args: ["enable-linger"] },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", BOOT_SERVICE_UNIT_FILE],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}

export function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    BOOT_SERVICE_PLIST_FILE,
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate
  // kickstart would kill and restart a server it just booted. A lingering job
  // that survived bootout, or a gui domain with nobody logged in at the
  // screen (SSH install), makes bootstrap fail the flow loudly rather than
  // silently keeping a stale server.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) => renderBootServicePlist(plan, { homeDir: input.homeDir }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a
    // later reinstall. Removing the plist is what stops the next login load.
    // A bootout that fails for a reason other than "not loaded" leaves the
    // job running until logout; the failure is in the boot-service log.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}

/** Undefined means this host cannot run the background service. */
export function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number | undefined;
  readonly path: Path.Path;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({ path: input.path, homeDir: input.homeDir });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({ path: input.path, homeDir: input.homeDir, uid: input.uid });
  }
  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedErrorClass<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServiceUpdatePendingError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly launcherSourcePath?: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };

  const detectedManager = selectBootServiceManager({ platform, homeDir, uid, path });
  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, "boot-service.log");
  const launcherPath = path.join(input.baseDir, "runtime", SERVICE_LAUNCHER_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);
  const launcherSourcePath =
    host.launcherSourcePath ??
    path.join(path.dirname(runtimePaths.entryPath), SERVICE_LAUNCHER_FILE);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    launcherPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
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
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
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
        // runStep's tapError already appends the failure to the log, so an
        // ignored optional step still leaves a trace.
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      validate: (runtime) =>
        runner
          .run({
            command: host.execPath,
            args: [runtime.entryPath, "--version"],
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
    const launcherSource = yield* fs
      .readFileString(launcherSourcePath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (installed) {
      yield* runSteps(manager.stop);
    }

    yield* Effect.gen(function* () {
      if (installed) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
        if (
          Option.isSome(previousStateText) &&
          serviceStateHasPendingUpdate(previousStateText.value)
        ) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* writeDurably(launcherPath, launcherSource);
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
      yield* writeDurably(unitPath, manager.render(plan));

      yield* runSteps(manager.activate);
    }).pipe(
      Effect.tapError(() =>
        installed ? runSteps(manager.restart).pipe(Effect.ignore) : Effect.void,
      ),
    );
    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

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
    const [unit, launcherExists, runtimeEntryExists, runtimeSentinel, stateText] =
      yield* Effect.all([
        fs.readFileString(unitPath),
        fs.exists(launcherPath),
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    return {
      supported: true,
      installed: true,
      current:
        unit === detectedManager.render(plan) &&
        launcherExists &&
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

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
