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
import * as Schedule from "effect/Schedule";
import { CliError } from "effect/cli";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import { acquireServiceSelectionLock } from "./serviceSelectionLock.ts";
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
  SERVICE_UNIT_ENV,
  compareExactServiceVersions,
  serviceUnitBaseDirOf as bootServiceBaseDirOf,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

export {
  serviceUnitBaseDirOf as bootServiceBaseDirOf,
  serviceUnitProgramOf as bootServiceProgramOf,
} from "./serviceProtocol.ts";

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  /** The manager accepted a detached install; its outcome is written to `logPath`. */
  readonly handedOff?: boolean;
}

/** Service units cannot rely on the user's shell or PATH. */
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
    `Environment=${SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Helpers share this cgroup; default OOMPolicy=stop would stop the unit if one is OOM-killed.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    // Weights favor the server over the sibling agents slice; IOWeight needs a delegated io controller.
    "CPUWeight=1000",
    "IOWeight=1000",
    // Reclaim takes the agents' unprotected pages first. The kernel caps this at the
    // protection of user.slice and user@.service, which only root can grant.
    "MemoryLow=1536M",
    // A user manager's own score, the lowest it may set: below its other services (200) and agents (800).
    // `t3 service protect` lowers it further through a drop-in.
    "OOMScoreAdjust=100",
    // systemd-oomd ignores this preference when the watched cgroup is root-owned, as user-1000.slice usually is.
    "ManagedOOMPreference=avoid",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // Allow 90s stops for update handoffs.
  // Interactive avoids background throttling.
  // AbandonProcessGroup=false reaps agents only on launcher exit, preserving them across child updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>T3CODE_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${SERVICE_UNIT_ENV}</key>`,
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
  /** Non-zero exit is logged and ignored. */
  readonly optional?: boolean;
  readonly timeout?: Duration.Input;
}

/** Must exceed systemd TimeoutStopSec and launchd ExitTimeOut (both 90s) to avoid shutdown races. */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  readonly stop: ReadonlyArray<BootServiceStep>;
  readonly activate: ReadonlyArray<BootServiceStep>;
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Queue a restart owned by the manager, since stopping would kill the caller. */
  readonly handoff?: ReadonlyArray<BootServiceStep>;
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

const defaultSystemdUnitDir = (path: Path.Path, homeDir: string, xdgConfigHome: string) =>
  path.join(
    path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(homeDir, ".config"),
    "systemd",
    "user",
  );

const launchdPlistPath = (path: Path.Path, homeDir: string) =>
  path.join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE);

function systemdManager(input: {
  readonly path: Path.Path;
  readonly unitDir: string;
}): BootServiceManager {
  const unitPath = input.path.join(input.unitDir, BOOT_SERVICE_UNIT_FILE);
  const prepareActivation = [
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
  ];
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
      ...prepareActivation,
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
    handoff: [
      ...prepareActivation,
      {
        step: "restarting the service",
        command: "systemctl",
        args: ["--user", "restart", "--no-block", BOOT_SERVICE_UNIT_FILE],
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

function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
  readonly environmentPath: string;
}): BootServiceManager {
  const unitPath = launchdPlistPath(input.path, input.homeDir);
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // Unloaded jobs may reject bootout/enable. Bootstrap starts RunAtLoad/KeepAlive jobs; kickstart would restart them.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    // bootout --wait is undocumented but waits through ExitTimeOut, preventing bootstrap EIO races.
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
    // Persisted launchctl disable overrides would block reinstall.
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

function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly xdgConfigHome: string;
  readonly systemdUnitDir: string | undefined;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({
      path: input.path,
      unitDir:
        input.systemdUnitDir ??
        defaultSystemdUnitDir(input.path, input.homeDir, input.xdgConfigHome),
    });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
    });
  }
  return undefined;
}

const decodeSystemdUnitPaths = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.String) })),
);

// The manager may not share the installer's environment; JSON preserves spaces in its paths.
const readSystemdUnitDirectory = Effect.fn("cloud.boot_service.read_systemd_unit_directory")(
  function* (runner: ProcessRunner.ProcessRunner["Service"], path: Path.Path) {
    const result = yield* runner.run({
      command: "busctl",
      args: [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      timeout: Duration.seconds(5),
    });
    if (result.code !== 0) return undefined;
    const { data } = yield* decodeSystemdUnitPaths(result.stdout);
    // The persistent control directory identifies the manager's config root despite UnitPath overrides.
    const controlDirectory = data.find(
      (directory) =>
        path.isAbsolute(directory) &&
        directory.endsWith("/systemd/user.control") &&
        data.includes(directory.slice(0, -".control".length)),
    );
    return controlDirectory?.slice(0, -".control".length);
  },
  Effect.orElseSucceed(() => undefined),
);

/** Where this platform's service manager keeps the unit, whether or not one is installed. */
export const bootServiceUnitPath = Effect.fn("cloud.boot_service.unit_path")(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDir = yield* HostProcess.HomeDirectory;
  if (homeDir === "") return undefined;
  if (platform === "darwin") return launchdPlistPath(path, homeDir);
  if (platform !== "linux") return undefined;
  const unitDir =
    (yield* readSystemdUnitDirectory()) ??
    defaultSystemdUnitDir(path, homeDir, (yield* HostProcess.Environment).XDG_CONFIG_HOME ?? "");
  return path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
});

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
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

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
]);
type BootServiceProblem = typeof BootServiceProblem.Type;

export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run T3 with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. T3 Code will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `t3 service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log and `systemctl --user status t3code.service`, then run `t3 service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `t3 service restart` to switch.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  { problem: BootServiceProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  { recoveryCommand: Schema.optional(Schema.String) },
) {
  override get message(): string {
    if (this.recoveryCommand !== undefined) {
      return `A remote server update is still pending, but its service definition is missing. With the service stopped, run this on the server machine: ${this.recoveryCommand}\nWait for the update to finish or roll back, stop the foreground launcher with Ctrl-C, then retry the install.`;
    }
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace t3@${this.installedVersion} with older t3@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export const formatBootServiceBaseDirOption = (baseDir: string) =>
  `--base-dir '${baseDir.replaceAll("'", `'"'"'`)}'`;

export class BootServiceOtherBaseDirError extends Schema.TaggedError<BootServiceOtherBaseDirError>()(
  "BootServiceOtherBaseDirError",
  {
    installedBaseDir: Schema.String,
    baseDir: Schema.String,
  },
) {
  override get message(): string {
    return `The T3 Code service on this machine serves ${this.installedBaseDir}, not ${this.baseDir}. Pass ${formatBootServiceBaseDirOption(this.installedBaseDir)} to manage it, or run \`t3 service uninstall ${formatBootServiceBaseDirOption(this.installedBaseDir)}\` first to move it; both data directories are kept.`;
  }

  // A refusal the user fixes by rerunning, so the CLI prints the message, not a stack trace.
  override get [CliError.userMessage]() {
    return this.message;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceOtherBaseDirError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly installedVersion?: string;
  readonly installedBaseDir?: string;
  /** Set when the installed unit serves a different T3 home than this CLI. */
  readonly otherBaseDir?: string;
  readonly problems?: ReadonlyArray<BootServiceProblem>;
  readonly unitPath: string;
  readonly logPath: string;
}

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
  const xdgRuntimeDir = yield* Config.String("XDG_RUNTIME_DIR").pipe(Config.withDefault(""));
  // Root under sudo must not reach or start a separate root service.
  const rootUnderSudo =
    uid === 0 && (yield* Config.String("SUDO_USER").pipe(Config.withDefault(""))) !== "";
  const runningInsideService =
    (yield* Config.String(SERVICE_UNIT_ENV).pipe(Config.withDefault(""))) ===
    BOOT_SERVICE_UNIT_FILE;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // Without a login session nothing sets this, so `--user` commands cannot find the user bus.
  // The directory only appears once lingering starts the manager, so it need not exist yet.
  const userManagerEnv =
    platform === "linux" && xdgRuntimeDir === "" && uid !== undefined && !rootUnderSudo
      ? { XDG_RUNTIME_DIR: `/run/user/${uid}` }
      : undefined;
  const runner: ProcessRunner.ProcessRunner["Service"] =
    userManagerEnv === undefined
      ? processRunner
      : {
          run: (request) =>
            processRunner.run({ ...request, env: { ...userManagerEnv, ...request.env } }),
        };
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

  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const resolveTarget = (systemdUnitDir: string | undefined) => {
    const manager = selectBootServiceManager({
      platform,
      homeDir,
      xdgConfigHome,
      systemdUnitDir,
      uid,
      path,
      environmentPath,
    });
    const unitPath = manager?.unitPath ?? "";
    const plan: BootServicePlan = {
      program: [runtimePaths.entryPath, "__service-launcher"],
      baseDir: input.baseDir,
      logPath,
      unitPath,
    };
    return { manager, unitPath, plan };
  };
  let systemdUnitDir =
    platform === "linux" ? yield* readSystemdUnitDirectory(runner, path) : undefined;
  let { manager: detectedManager, unitPath, plan } = resolveTarget(systemdUnitDir);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const otherBaseDirOf = (unit: string) => {
    const installedBaseDir = bootServiceBaseDirOf(unit);
    return installedBaseDir !== undefined &&
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
      ? installedBaseDir
      : undefined;
  };
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
    const firstProblem = problems[0];
    if (firstProblem === undefined) return;
    // Logind reports a user without a session, whose manager is not running yet, as linger-unavailable.
    const withoutSession =
      problems.includes("linger-unavailable") && problems.includes("user-manager-unavailable");
    const lingerDisabled = problems.includes("linger-disabled");
    if (rootUnderSudo || (!lingerDisabled && !withoutSession)) {
      return yield* new BootServicePrerequisiteError({ problem: firstProblem });
    }
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        // Without a session this also fails on hosts that do not run systemd at all.
        (cause) =>
          new BootServicePrerequisiteError({
            problem: lingerDisabled ? "linger-disabled" : firstProblem,
            cause,
          }),
      ),
    );
    // Lingering starts the user manager asynchronously.
    const remaining = yield* readSystemdProblems(false).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 10,
        while: (current) => current.includes("user-manager-unavailable"),
      }),
    );
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  const withSelectionLock = <A, E, R>(selectionPath: string, operation: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireServiceSelectionLock(selectionPath),
        catch: (cause) => new BootServiceInstallError({ cause }),
      }),
      () => operation,
      (release) => Effect.sync(release),
    );

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    let manager = yield* requireManager;
    // The unit is per user. Rewriting one that serves another home moves the
    // service onto this home's data, which looks like every thread vanished.
    const refuseOtherBaseDir = Effect.gen(function* () {
      const existingUnit = yield* fs.readFileString(unitPath).pipe(Effect.option);
      const installedBaseDir = Option.isSome(existingUnit)
        ? otherBaseDirOf(existingUnit.value)
        : undefined;
      if (installedBaseDir !== undefined) {
        return yield* new BootServiceOtherBaseDirError({
          installedBaseDir,
          baseDir: input.baseDir,
        });
      }
    });
    yield* refuseOtherBaseDir;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
      // Without a session the manager was unreachable at construction, and the one lingering
      // started may use another config root than this shell's XDG_CONFIG_HOME.
      if (systemdUnitDir === undefined) {
        systemdUnitDir = yield* readSystemdUnitDirectory(runner, path);
        ({ manager: detectedManager, unitPath, plan } = resolveTarget(systemdUnitDir));
        manager = yield* requireManager;
        yield* refuseOtherBaseDir;
      }
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
    // Stop outside the selection lock: the launcher may be waiting to acquire it.
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
        `--setenv=${SERVICE_UNIT_ENV}=`,
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

    // State first, then unit. The launcher acquires only one at a time, and a
    // failure to lock the unit must never prevent its durable update commit.
    yield* withSelectionLock(
      statePath,
      withSelectionLock(
        unitPath,
        Effect.gen(function* () {
          const currentlyInstalled = yield* fs.exists(unitPath);
          const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
          if (Option.isSome(previousStateText)) {
            const installedVersion = serviceStateActiveVersion(previousStateText.value);
            if (serviceStateHasPendingUpdate(previousStateText.value)) {
              const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
              return yield* new BootServiceUpdatePendingError(
                !currentlyInstalled && installedVersion !== undefined
                  ? {
                      recoveryCommand: `T3CODE_HOME=${quote(input.baseDir)} ${quote(pinnedRuntimePaths(path, input.baseDir, installedVersion, platform).entryPath)} __service-launcher`,
                    }
                  : {},
              );
            }
            // Read the final version after stopping the launcher; a remote update may finish after the status check.
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
          yield* fs
            .makeDirectory(path.dirname(unitPath), { recursive: true })
            .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
          // Files can match the new version even when activation fails; keep that install retryable.
          yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
          yield* writeDurably(
            statePath,
            // @effect-diagnostics-next-line globalJsonInEffect:off - fixed launcher-owned document.
            `${JSON.stringify(
              {
                protocol: SERVICE_LAUNCHER_PROTOCOL,
                activeVersion: input.cliVersion,
              } satisfies ServiceState,
              null,
              2,
            )}\n`,
          );
          if (!start && (currentlyInstalled || Option.isSome(previousStateText))) {
            const written = yield* fs.readFileString(statePath);
            if (serviceStateActiveVersion(written) !== input.cliVersion) {
              return yield* new BootServiceUpdatePendingError();
            }
          }
          yield* writeDurably(unitPath, manager.render(plan));
        }),
      ),
    ).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (start) {
            yield* runSteps(manager.activate);
            yield* withSelectionLock(
              statePath,
              Effect.gen(function* () {
                // A concurrent deferred install may now be waiting for a newer restart.
                const selected = parseServiceState(yield* fs.readFileString(statePath));
                if (selected?.activeVersion === input.cliVersion && selected.update === undefined) {
                  yield* fs.remove(restartPendingPath, { force: true });
                }
              }),
            );
          }
        }),
      ),
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
    const manager = detectedManager;
    if (manager === undefined) {
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
    const otherBaseDir = otherBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      manager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      manager.kind === "systemd" ? [...(yield* readSystemdProblems(true))] : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      ...(otherBaseDir === undefined ? {} : { otherBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(manager.render(plan)) &&
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
