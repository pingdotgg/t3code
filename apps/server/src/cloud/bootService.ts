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
import { CliError } from "effect/cli";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import { acquireServiceSelectionLock } from "./serviceSelectionLock.ts";
import {
  WINDOWS_QUERY_REGISTERED_TASK_SCRIPT,
  acquireServiceAccountLock,
  isValidServiceTaskName,
  probeServiceLauncher,
  queryServiceLauncherId,
  recoverServiceLauncherUninstall,
  requestServiceLauncherStop,
  serviceAccountControlRoot,
  serviceControlDir,
  serviceTaskName,
  serviceTaskNamePath,
  signalServiceLauncherStop,
  stageServiceLauncherInstall,
  waitForServiceLauncherRelease,
  windowsPowerShellBinary,
  windowsSystem32Binary,
  type ControlAclHooks,
} from "../serviceLauncher.ts";
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
  hasWindowsTaskEnvironmentExpansion,
  serviceUnitBaseDirOf as bootServiceBaseDirOf,
  serviceUnitProgramOf as bootServiceProgramOf,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

export { bootServiceBaseDirOf, bootServiceProgramOf };

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";
/** Task Scheduler keeps its own copy; this one lets status and repair read the task back. */
export const BOOT_SERVICE_TASK_FILE = `${BOOT_SERVICE_NAME}-task.xml`;
const BOOT_SERVICE_UNIT_VALUES = new Set([
  BOOT_SERVICE_UNIT_FILE,
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_TASK_FILE,
]);

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

/** Escape embedded quotes and double trailing backslashes per CommandLineToArgvW rules. */
const quoteWindowsArgument = (value: string) =>
  `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

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

/**
 * Task Scheduler can neither set variables nor redirect output, so the launcher takes them as
 * flags. A console program started by a task opens a window unless a headless console hosts it.
 * No XML declaration: schtasks rejects `encoding="UTF-8"` but reads undeclared XML as UTF-8.
 */
export function renderBootServiceTask(
  plan: BootServicePlan,
  options: {
    readonly userId: string;
    readonly homeDir: string;
    readonly conhostPath: string;
    readonly enabled?: boolean;
  },
): string {
  const launcherArguments = [
    ...plan.program,
    "--base-dir",
    plan.baseDir,
    "--log-file",
    plan.logPath,
    "--service-unit",
    BOOT_SERVICE_TASK_FILE,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  // conhost reports exit code 0 whatever the launcher returns, so restart-on-failure never
  // fires. A repeating trigger with IgnoreNew starts the task again within a minute instead.
  // Priority 5 is normal; the default 7 runs below it.
  return [
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>T3 Code server</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <UserId>${escapeXmlText(options.userId)}</UserId>`,
    `    </LogonTrigger>`,
    `    <TimeTrigger>`,
    `      <StartBoundary>2000-01-01T00:00:00</StartBoundary>`,
    `      <Repetition>`,
    `        <Interval>PT1M</Interval>`,
    `      </Repetition>`,
    `    </TimeTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${escapeXmlText(options.userId)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    ...(options.enabled === false ? [`    <Enabled>false</Enabled>`] : []),
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>5</Priority>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${escapeXmlText(options.conhostPath)}</Command>`,
    `      <Arguments>--headless ${escapeXmlText(launcherArguments)}</Arguments>`,
    `      <WorkingDirectory>${escapeXmlText(options.homeDir)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\n");
}

export type BootServiceStep = {
  readonly step: string;
  /** Non-zero exit is logged and ignored. */
  readonly optional?: boolean;
  readonly timeout?: Duration.Input;
} & (
  | { readonly command: string; readonly args: ReadonlyArray<string> }
  /** A step no command can do, such as waiting on the Windows launcher's control channel. */
  | { readonly run: Effect.Effect<void, BootServiceCommandError> }
);

/** Must exceed systemd TimeoutStopSec and launchd ExitTimeOut (both 90s) to avoid shutdown races. */
const STOP_STEP_TIMEOUT = Duration.seconds(120);
/** Covers both passes of `stopWindowsLauncher` (up to 95s graceful stop + 15s fallback release per pass). */
const WINDOWS_STOP_STEP_TIMEOUT = Duration.seconds(240);

export interface BootServiceManager {
  readonly kind: "systemd" | "launchd" | "schtasks";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  readonly prepareStop: ReadonlyArray<BootServiceStep>;
  readonly finishStop: ReadonlyArray<BootServiceStep>;
  readonly stop: ReadonlyArray<BootServiceStep>;
  readonly activate: ReadonlyArray<BootServiceStep>;
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Queue a restart owned by the manager, since stopping would kill the caller. */
  readonly handoff?: ReadonlyArray<BootServiceStep>;
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

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
  const stop: ReadonlyArray<BootServiceStep> = [
    {
      step: "stopping the installed service",
      command: "systemctl",
      args: ["--user", "stop", BOOT_SERVICE_UNIT_FILE],
      timeout: STOP_STEP_TIMEOUT,
    },
  ];
  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    prepareStop: [],
    finishStop: stop,
    stop,
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
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    BOOT_SERVICE_PLIST_FILE,
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${BOOT_SERVICE_LAUNCHD_LABEL}`;
  // bootout --wait is undocumented but waits through ExitTimeOut, preventing bootstrap EIO races.
  const stop: ReadonlyArray<BootServiceStep> = [
    {
      step: "stopping the installed launch agent",
      command: "launchctl",
      args: ["bootout", "--wait", serviceTarget],
      optional: true,
      timeout: STOP_STEP_TIMEOUT,
    },
  ];
  // Unloaded jobs may reject bootout/enable. Bootstrap starts RunAtLoad/KeepAlive jobs; kickstart would restart them.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    prepareStop: [],
    finishStop: stop,
    stop,
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

export interface WindowsSession {
  readonly localAppData: string;
  /** `DOMAIN\\user`, the account whose logon starts the task. */
  readonly userId: string;
  readonly taskName: string;
  readonly systemRoot: string;
}

function schtasksManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly session: WindowsSession;
  /** Disables the scheduled task unless it is already absent, failing if Task Scheduler rejects it. */
  readonly disableTask: Effect.Effect<void, BootServiceCommandError>;
  /** Asks the installed launcher to stop and waits for it; Task Scheduler cannot. */
  readonly stopLauncher: Effect.Effect<void, BootServiceCommandError>;
  /** Removes the scheduled task unless it is already absent, failing if removal leaves it registered. */
  readonly deleteTask: Effect.Effect<void, BootServiceCommandError>;
}): BootServiceManager {
  const unitPath = input.path.join(input.session.localAppData, "t3code", BOOT_SERVICE_TASK_FILE);
  const schtasksBin = windowsSystem32Binary("schtasks.exe", {
    SystemRoot: input.session.systemRoot,
  });
  const conhostBin = windowsSystem32Binary("conhost.exe", {
    SystemRoot: input.session.systemRoot,
  });
  const task = ["/TN", input.session.taskName];
  const register = {
    step: "registering the scheduled task",
    command: schtasksBin,
    args: ["/Create", "/XML", unitPath, ...task, "/F"],
  };
  const run = { step: "starting the service", command: schtasksBin, args: ["/Run", ...task] };
  // Disabled first, or the repeating trigger restarts the task while it should stay stopped.
  const prepareStop: ReadonlyArray<BootServiceStep> = [
    { step: "disabling the scheduled task", run: input.disableTask },
  ];
  const finishStop: ReadonlyArray<BootServiceStep> = [
    {
      step: "stopping the installed service",
      run: input.stopLauncher,
      timeout: WINDOWS_STOP_STEP_TIMEOUT,
    },
  ];
  const stop: ReadonlyArray<BootServiceStep> = [...prepareStop, ...finishStop];
  return {
    kind: "schtasks",
    unitPath,
    render: (plan) =>
      renderBootServiceTask(plan, {
        userId: input.session.userId,
        homeDir: input.homeDir,
        conhostPath: conhostBin,
      }),
    prepareStop,
    finishStop,
    stop,
    // Registration also enables the task.
    activate: [register, run],
    restart: [
      {
        step: "enabling the scheduled task",
        command: schtasksBin,
        args: ["/Change", ...task, "/ENABLE"],
      },
      { ...run, step: "restarting the service after a failed update" },
    ],
    // `IgnoreNew` ignores `/Run` while the previous console host is active, so `/End` runs first:
    // the launcher sees the console close and stops gracefully while the replacement waits for the
    // per-home control lock, and the `PT1M` trigger heals if console close interrupts `/Run`.
    handoff: [
      register,
      {
        step: "ending the scheduled task",
        command: schtasksBin,
        args: ["/End", ...task],
        optional: true,
      },
      { ...run, step: "restarting the service" },
    ],
    deactivate: [...stop, { step: "removing the scheduled task", run: input.deleteTask }],
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
  readonly windows?: {
    readonly session: WindowsSession;
    readonly disableTask: Effect.Effect<void, BootServiceCommandError>;
    readonly stopLauncher: Effect.Effect<void, BootServiceCommandError>;
    readonly deleteTask: Effect.Effect<void, BootServiceCommandError>;
  };
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "win32" && input.windows !== undefined) {
    return schtasksManager({ path: input.path, homeDir: input.homeDir, ...input.windows });
  }
  if (input.platform === "linux") {
    return systemdManager({
      path: input.path,
      unitDir:
        input.systemdUnitDir ??
        input.path.join(
          input.path.isAbsolute(input.xdgConfigHome)
            ? input.xdgConfigHome
            : input.path.join(input.homeDir, ".config"),
          "systemd",
          "user",
        ),
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
  function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const path = yield* Path.Path;
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

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd, macOS with launchd, and Windows with Task Scheduler; this machine reports '${this.platform}'.`;
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
  "service-unhealthy",
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
      return "The service is not running. Check the service log (on Linux, also `systemctl --user status t3code.service`), then run `t3 service install`.";
    case "service-unhealthy":
      return "The service is holding its control lock without answering authenticated control requests. Check the service log, then run `t3 service install` to repair it.";
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

export function sameBootServiceBaseDir(
  path: Path.Path,
  platform: NodeJS.Platform,
  left: string,
  right: string,
): boolean {
  const normalize = (target: string) => {
    const resolved = path.resolve(target);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export class BootServiceOtherBaseDirError extends Schema.TaggedError<BootServiceOtherBaseDirError>()(
  "BootServiceOtherBaseDirError",
  {
    installedBaseDir: Schema.String,
    baseDir: Schema.String,
    unrecognizedTaskName: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.unrecognizedTaskName !== undefined) {
      return `The Windows scheduled task '${this.unrecognizedTaskName}' has an unrecognized configuration, so T3 Code did not overwrite or remove it. Inspect it with \`schtasks /Query /TN "${this.unrecognizedTaskName}" /XML\`, or remove it with \`schtasks /Delete /TN "${this.unrecognizedTaskName}" /F\` and retry.`;
    }
    return `The T3 Code service on this machine serves ${this.installedBaseDir}, not ${this.baseDir}. Pass ${formatBootServiceBaseDirOption(this.installedBaseDir)} to manage it, or run \`t3 service uninstall ${formatBootServiceBaseDirOption(this.installedBaseDir)}\` first to move it; both data directories are kept.`;
  }

  // A refusal the user fixes by rerunning, so the CLI prints the message, not a stack trace.
  override get [CliError.userMessage]() {
    return this.message;
  }
}

export class BootServiceRunningInsideServiceError extends Schema.TaggedError<BootServiceRunningInsideServiceError>()(
  "BootServiceRunningInsideServiceError",
  {},
) {
  override get message(): string {
    return "This command must stop the T3 Code background service, so it cannot run from a terminal inside that service. Run it from an external shell on the host machine instead.";
  }

  override get [CliError.userMessage]() {
    return this.message;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceOtherBaseDirError
  | BootServiceRunningInsideServiceError
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
  readonly controlDir?: (baseDir: string) => string;
  readonly accountControlRoot?: string;
  readonly acl?: ControlAclHooks;
  readonly fallbackReleaseTimeoutMs?: number;
}

type RegisteredWindowsTaskSnapshot =
  | { readonly state: "present"; readonly xml: string }
  | { readonly state: "absent" }
  | { readonly state: "failed" };

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
  const homeDir = yield* Config.String(platform === "win32" ? "USERPROFILE" : "HOME").pipe(
    Config.withDefault(""),
  );
  const xdgConfigHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const runningInsideService = BOOT_SERVICE_UNIT_VALUES.has(
    (yield* Config.String(SERVICE_UNIT_ENV).pipe(Config.withDefault(""))).trim(),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  const probe = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.seconds(5) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
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

  const statOptionalPath = (targetPath: string) =>
    fs.stat(targetPath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<FileSystem.File.Info>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
  const readOptionalFileString = (targetPath: string) =>
    fs.readFileString(targetPath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
  const readOptionalUnitFileString = Effect.fn("boot_service.read_optional_unit_file")(function* (
    targetPath: string,
  ) {
    const info = yield* statOptionalPath(targetPath);
    if (Option.isNone(info) || info.value.type === "Directory") {
      return Option.none<string>();
    }
    return yield* readOptionalFileString(targetPath);
  });

  const systemdUnitDir = platform === "linux" ? yield* readSystemdUnitDirectory() : undefined;
  const windowsVariable = (name: string) =>
    platform === "win32" ? Config.String(name).pipe(Config.withDefault("")) : Config.succeed("");
  const windowsDomain = (yield* windowsVariable("USERDOMAIN")).trim();
  const windowsUser = (yield* windowsVariable("USERNAME")).trim();
  const configuredLocalAppData = (yield* windowsVariable("LOCALAPPDATA")).trim();
  const windowsLocalAppData =
    configuredLocalAppData !== ""
      ? configuredLocalAppData
      : platform === "win32" && homeDir.trim() !== ""
        ? path.join(homeDir.trim(), "AppData", "Local")
        : "";
  const taskNamePath =
    platform === "win32" && windowsLocalAppData !== ""
      ? serviceTaskNamePath(windowsLocalAppData)
      : "";
  const persistedTaskName =
    taskNamePath === ""
      ? Option.none<string>()
      : yield* readOptionalFileString(taskNamePath).pipe(
          Effect.map(
            Option.flatMap((raw) => {
              const trimmed = raw.trim();
              return isValidServiceTaskName(trimmed) ? Option.some(trimmed) : Option.none();
            }),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
  const windowsSession: WindowsSession = {
    localAppData: windowsLocalAppData,
    userId: windowsDomain === "" ? windowsUser : `${windowsDomain}\\${windowsUser}`,
    taskName: Option.getOrElse(persistedTaskName, () =>
      serviceTaskName(windowsDomain, windowsUser),
    ),
    systemRoot: (yield* windowsVariable("SystemRoot")).trim() || "C:\\Windows",
  };
  const windowsBinEnv = { SystemRoot: windowsSession.systemRoot };
  const schtasksCommand = windowsSystem32Binary("schtasks.exe", windowsBinEnv);
  const windowsPowerShellCommand = windowsPowerShellBinary(windowsBinEnv);
  const resolveControlDir =
    host.controlDir ??
    ((targetBaseDir: string) =>
      serviceControlDir(windowsSession.localAppData, targetBaseDir, {
        caseInsensitive: platform === "win32",
      }));
  const accountControlRoot =
    host.accountControlRoot ?? serviceAccountControlRoot(windowsSession.localAppData);
  // Win32 HRESULTs returned by `schtasks /Query /HRESULT` when the task or folder does not exist.
  const SCHED_TASK_NOT_FOUND_HRESULTS = new Set([0x80070002, 0x80070003]);
  const windowsTaskHasActions = (contents: string) => /<Actions\b/i.test(contents);
  const selectEffectiveWindowsUnit = (
    localUnit: Option.Option<string>,
    registeredTaskXml: string | undefined,
  ): Option.Option<string> =>
    registeredTaskXml !== undefined && windowsTaskHasActions(registeredTaskXml)
      ? Option.some(registeredTaskXml)
      : Option.isSome(localUnit)
        ? localUnit
        : Option.fromNullishOr(registeredTaskXml);
  const windowsUnitPath =
    windowsSession.localAppData === ""
      ? ""
      : path.join(windowsSession.localAppData, "t3code", BOOT_SERVICE_TASK_FILE);
  const queryRegisteredWindowsTask = Effect.fn("cloud.boot_service.query_windows_task")(
    function* (): Effect.fn.Return<RegisteredWindowsTaskSnapshot> {
      const queried = yield* runner
        .run({
          command: windowsPowerShellCommand,
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_QUERY_REGISTERED_TASK_SCRIPT,
          ],
          env: { T3_TASK_NAME: windowsSession.taskName },
          timeout: Duration.seconds(15),
        })
        .pipe(Effect.option);
      if (Option.isNone(queried)) return { state: "failed" };
      if (
        queried.value.code === 0 &&
        !queried.value.stdoutInvalidUtf8 &&
        !queried.value.stdoutTruncated
      ) {
        return { state: "present", xml: queried.value.stdout };
      }
      if (Number(queried.value.code) === 2) {
        return { state: "absent" };
      }
      return { state: "failed" };
    },
  );
  // The unit is per user, so the launcher to stop is the one serving the installed unit's home.
  const launcherBaseDir = (unit: Option.Option<string>) =>
    Option.getOrUndefined(Option.flatMapNullishOr(unit, bootServiceBaseDirOf)) ?? input.baseDir;
  const disableWindowsTask = Effect.fn("cloud.boot_service.disable_windows_task")(function* () {
    const runDisable = Effect.gen(function* () {
      const disabled = yield* runner
        .run({
          command: schtasksCommand,
          args: ["/Change", "/TN", windowsSession.taskName, "/DISABLE"],
        })
        .pipe(
          Effect.mapError(
            (cause) => new BootServiceCommandError({ step: "disabling the scheduled task", cause }),
          ),
        );
      if (disabled.code === 0) return;
      const queried = yield* runner
        .run({
          command: schtasksCommand,
          args: ["/Query", "/TN", windowsSession.taskName, "/HRESULT"],
          timeout: Duration.seconds(5),
        })
        .pipe(
          Effect.mapError(
            (cause) => new BootServiceCommandError({ step: "disabling the scheduled task", cause }),
          ),
        );
      if (!SCHED_TASK_NOT_FOUND_HRESULTS.has(Number(queried.code) >>> 0)) {
        return yield* new BootServiceCommandError({
          step: "disabling the scheduled task",
          exitCode: Number(disabled.code),
          stdoutLength: disabled.stdout.length,
          stderrLength: disabled.stderr.length,
        });
      }
    });
    if (windowsUnitPath === "") {
      return yield* runDisable;
    }
    // Serialize with `Launcher.#repointServiceUnit` (`reloadWindowsTaskUnit`), releasing before `stopWindowsLauncher`.
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireServiceSelectionLock(windowsUnitPath),
        catch: (cause) =>
          new BootServiceCommandError({ step: "disabling the scheduled task", cause }),
      }),
      () => runDisable,
      (release) => Effect.sync(release),
    );
  });
  const stopWindowsLauncher = Effect.fn("cloud.boot_service.stop_windows_launcher")(function* () {
    const [localUnit, queriedTask] = yield* Effect.all(
      [
        readOptionalUnitFileString(unitPath).pipe(
          Effect.mapError(
            (cause) =>
              new BootServiceCommandError({ step: "stopping the installed service", cause }),
          ),
        ),
        queryRegisteredWindowsTask(),
      ],
      { concurrency: "unbounded" },
    );
    if (queriedTask.state === "failed") {
      return yield* new BootServiceCommandError({ step: "stopping the installed service" });
    }
    const registeredTaskXml = queriedTask.state === "present" ? queriedTask.xml : undefined;
    const unit = selectEffectiveWindowsUnit(localUnit, registeredTaskXml);
    const targetBaseDir = launcherBaseDir(unit);
    const controlDir = resolveControlDir(targetBaseDir);
    for (let pass = 0; pass < 2; pass++) {
      const fallbackToTaskEnd = yield* Effect.tryPromise({
        try: async (signal) => {
          try {
            await requestServiceLauncherStop(controlDir, {
              signal,
              acl: host.acl,
            });
            return false;
          } catch (cause) {
            if (signal.aborted) throw cause;
            return true;
          }
        },
        catch: (cause) =>
          new BootServiceCommandError({ step: "stopping the installed service", cause }),
      });
      // Agents the server left behind keep its console host, and so the task, running.
      // When control-channel stop failed (for example, a lost or untrusted token), ending the
      // task closes conhost stdin so the launcher exits and releases its lock.
      if (pass === 0 || fallbackToTaskEnd) {
        yield* runner
          .run({ command: schtasksCommand, args: ["/End", "/TN", windowsSession.taskName] })
          .pipe(Effect.ignore);
      }
      if (fallbackToTaskEnd) {
        yield* Effect.tryPromise({
          try: (signal) =>
            waitForServiceLauncherRelease(controlDir, {
              timeoutMs: host.fallbackReleaseTimeoutMs ?? 15_000,
              signal,
              acl: host.acl,
            }),
          catch: (cause) =>
            new BootServiceCommandError({ step: "stopping the installed service", cause }),
        });
      }
      const remaining = yield* Effect.tryPromise({
        try: (signal) =>
          probeServiceLauncher(controlDir, {
            signal,
            acl: host.acl,
          }),
        catch: (cause) =>
          new BootServiceCommandError({ step: "stopping the installed service", cause }),
      });
      if (remaining === "stopped") return;
      if (pass === 1) {
        return yield* new BootServiceCommandError({
          step: "stopping the installed service",
        });
      }
    }
  });
  const deleteWindowsTask = Effect.fn("cloud.boot_service.delete_windows_task")(function* () {
    const deleted = yield* runner
      .run({
        command: schtasksCommand,
        args: ["/Delete", "/TN", windowsSession.taskName, "/F"],
      })
      .pipe(
        Effect.mapError(
          (cause) => new BootServiceCommandError({ step: "removing the scheduled task", cause }),
        ),
      );
    if (deleted.code === 0) return;
    // Succeed only when Task Scheduler specifically confirms the task is absent; preserve the
    // local XML mirror when access errors or an unavailable Task Scheduler prevent verification.
    const queried = yield* runner
      .run({
        command: schtasksCommand,
        args: ["/Query", "/TN", windowsSession.taskName, "/HRESULT"],
        timeout: Duration.seconds(5),
      })
      .pipe(
        Effect.mapError(
          (cause) => new BootServiceCommandError({ step: "removing the scheduled task", cause }),
        ),
      );
    if (!SCHED_TASK_NOT_FOUND_HRESULTS.has(Number(queried.code) >>> 0)) {
      return yield* new BootServiceCommandError({
        step: "removing the scheduled task",
        exitCode: Number(deleted.code),
        stdoutLength: deleted.stdout.length,
        stderrLength: deleted.stderr.length,
      });
    }
  });
  const signalPreviousWindowsLauncher = Effect.fn(
    "cloud.boot_service.signal_previous_windows_launcher",
  )(function* (launcherId: string | undefined) {
    if (launcherId === undefined) return;
    yield* Effect.tryPromise({
      try: (signal) =>
        signalServiceLauncherStop(resolveControlDir(input.baseDir), launcherId, {
          signal,
          acl: host.acl,
        }),
      catch: (cause) =>
        new BootServiceCommandError({ step: "stopping the installed service", cause }),
    }).pipe(Effect.ignore);
  });
  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    xdgConfigHome,
    systemdUnitDir,
    uid,
    path,
    environmentPath,
    ...(windowsSession.localAppData === "" || windowsUser === ""
      ? {}
      : {
          windows: {
            session: windowsSession,
            disableTask: disableWindowsTask(),
            stopLauncher: stopWindowsLauncher(),
            deleteTask: deleteWindowsTask(),
          },
        }),
  });
  const unitPath = detectedManager?.unitPath ?? "";
  const isUnrecognizedWindowsTask = (contents: string): boolean =>
    detectedManager?.kind === "schtasks" &&
    windowsTaskHasActions(contents) &&
    bootServiceBaseDirOf(contents) === undefined;
  const readInstalledUnitSnapshot = Effect.fn("cloud.boot_service.read_installed_unit_snapshot")(
    function* () {
      if (unitPath === "") {
        return {
          localUnit: Option.none<string>(),
          queriedTask: { state: "absent" } as RegisteredWindowsTaskSnapshot,
          registeredTaskXml: undefined,
          effectiveUnit: Option.none<string>(),
        };
      }
      if (detectedManager?.kind !== "schtasks") {
        const localUnit = yield* readOptionalUnitFileString(unitPath);
        return {
          localUnit,
          queriedTask: { state: "absent" } as RegisteredWindowsTaskSnapshot,
          registeredTaskXml: undefined,
          effectiveUnit: localUnit,
        };
      }
      const [localUnit, queriedTask] = yield* Effect.all(
        [readOptionalUnitFileString(unitPath), queryRegisteredWindowsTask()],
        { concurrency: "unbounded" },
      );
      const registeredTaskXml = queriedTask.state === "present" ? queriedTask.xml : undefined;
      const effectiveUnit = selectEffectiveWindowsUnit(localUnit, registeredTaskXml);
      return {
        localUnit,
        queriedTask,
        registeredTaskXml,
        effectiveUnit,
      };
    },
  );
  const withWindowsAccountLock = <A, E, R>(
    manager: BootServiceManager,
    effect: Effect.Effect<A, E, R>,
    mapLockError: (cause: unknown) => E,
  ): Effect.Effect<A, E, R> =>
    manager.kind !== "schtasks"
      ? effect
      : Effect.scoped(
          Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) =>
                acquireServiceAccountLock(accountControlRoot, {
                  signal,
                  acl: host.acl,
                }),
              catch: mapLockError,
            }),
            (lock) => Effect.sync(() => lock.close()),
          ).pipe(Effect.andThen(effect)),
        );
  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const sameBaseDir = (left: string, right: string) =>
    sameBootServiceBaseDir(path, platform, left, right);
  const otherBaseDirOf = (unit: string) => {
    const installedBaseDir = bootServiceBaseDirOf(unit);
    return installedBaseDir !== undefined && !sameBaseDir(installedBaseDir, input.baseDir)
      ? installedBaseDir
      : undefined;
  };
  const guardWindowsSnapshot = (snapshot: {
    readonly queriedTask: RegisteredWindowsTaskSnapshot;
    readonly effectiveUnit: Option.Option<string>;
  }): Effect.Effect<void, BootServiceCommandError | BootServiceOtherBaseDirError> => {
    if (detectedManager?.kind === "schtasks" && snapshot.queriedTask.state === "failed") {
      return Effect.fail(new BootServiceCommandError({ step: "inspecting the scheduled task" }));
    }
    if (Option.isSome(snapshot.effectiveUnit)) {
      if (isUnrecognizedWindowsTask(snapshot.effectiveUnit.value)) {
        return Effect.fail(
          new BootServiceOtherBaseDirError({
            installedBaseDir: "",
            baseDir: input.baseDir,
            unrecognizedTaskName: windowsSession.taskName,
          }),
        );
      }
      const otherBaseDir = otherBaseDirOf(snapshot.effectiveUnit.value);
      if (otherBaseDir !== undefined) {
        return Effect.fail(
          new BootServiceOtherBaseDirError({
            installedBaseDir: otherBaseDir,
            baseDir: input.baseDir,
          }),
        );
      }
    }
    return Effect.void;
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
        const run =
          "run" in entry
            ? entry.run.pipe(
                Effect.timeoutOrElse({
                  duration: entry.timeout ?? Duration.seconds(60),
                  orElse: () => Effect.fail(new BootServiceCommandError({ step: entry.step })),
                }),
                Effect.tapError(logFailure),
              )
            : runStep(
                entry.step,
                entry.command,
                entry.args,
                entry.timeout === undefined ? undefined : { timeout: entry.timeout },
              );
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

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

  const withSelectionLock = <A, E, R>(selectionPath: string, operation: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireServiceSelectionLock(selectionPath),
        catch: (cause) => new BootServiceInstallError({ cause }),
      }),
      () => operation,
      (release) => Effect.sync(release),
    );

  // Running means the launcher answers authenticated control requests while holding its lock:
  // a task can stay running after the launcher exits while orphaned agents hold conhost open,
  // and an occupied lock that fails authentication reports `service-unhealthy` rather than healthy.
  const readSchtasksProblems = Effect.fn("cloud.boot_service.read_schtasks_problems")(function* (
    unit: Option.Option<string>,
    prequeriedTask?: RegisteredWindowsTaskSnapshot,
  ) {
    const targetBaseDir = launcherBaseDir(unit);
    const controlDir = resolveControlDir(targetBaseDir);
    const [task, launcherState] = yield* Effect.all(
      [
        prequeriedTask === undefined
          ? queryRegisteredWindowsTask()
          : Effect.succeed(prequeriedTask),
        Effect.tryPromise({
          try: (signal) =>
            probeServiceLauncher(controlDir, {
              signal,
              acl: host.acl,
            }),
          catch: (cause) =>
            new BootServiceCommandError({ step: "inspecting the installed service", cause }),
        }).pipe(Effect.orElseSucceed(() => "unhealthy" as const)),
      ],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (task.state === "present") {
      const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(task.xml)?.[0] ?? "";
      if (/<Enabled>\s*false\s*<\/Enabled>/i.test(settings)) {
        problems.push("service-disabled");
      }
    } else if (task.state === "absent") {
      problems.push("service-disabled");
    }
    if (launcherState === "stopped") problems.push("service-stopped");
    else if (launcherState === "unhealthy") problems.push("service-unhealthy");
    if (
      (task.state === "failed" || (Option.isSome(unit) && isUnrecognizedWindowsTask(unit.value))) &&
      !problems.includes("service-unhealthy")
    ) {
      problems.push("service-unhealthy");
    }
    return problems;
  });

  const disableScheduledTaskStep: BootServiceStep = {
    step: "keeping the scheduled task disabled",
    run: disableWindowsTask(),
  };

  const schtasksRestoreSteps = (
    manager: BootServiceManager,
    problems: ReadonlyArray<BootServiceProblem>,
    options?: { readonly mayHaveEnabled?: boolean },
  ): ReadonlyArray<BootServiceStep> => {
    const wasEnabled = !problems.includes("service-disabled");
    if (wasEnabled) return manager.restart;
    if (problems.includes("service-stopped")) {
      return options?.mayHaveEnabled === true ? [disableScheduledTaskStep] : [];
    }
    return [
      {
        step: "restarting the service after a failed update",
        run: runSteps(manager.restart).pipe(
          Effect.ensuring(disableWindowsTask().pipe(Effect.ignore)),
        ),
      },
    ];
  };

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    if (
      manager.kind === "schtasks" &&
      [input.baseDir, logPath, runtimePaths.entryPath, homeDir].some(
        hasWindowsTaskEnvironmentExpansion,
      )
    ) {
      return yield* new BootServiceInstallError({
        cause: new Error(
          "Windows Task Scheduler expands '%NAME%' segments in task action paths without an escape syntax; choose paths without '%...%' segments.",
        ),
      });
    }
    // The unit is per user. Rewriting one that serves another home moves the
    // service onto this home's data, which looks like every thread vanished.
    const initialSnapshot = yield* readInstalledUnitSnapshot();
    yield* guardWindowsSnapshot(initialSnapshot);
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
    if (manager.kind === "schtasks") {
      // Pre-Windows-service builds pass `--version` yet accept only bare `__service-launcher`;
      // verify flag support before stopping a working service or repointing its scheduled task.
      yield* runner
        .run({
          command: pinnedRuntimeCommand(runtimePaths).command,
          args: [...pinnedRuntimeCommand(runtimePaths).args, "__service-launcher", "--help"],
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BootServiceCommandError({
                step: "verifying Windows service launcher support",
                cause,
              }),
          ),
          Effect.filterOrFail(
            (result) =>
              result.code === 0 &&
              result.stdout.includes("--base-dir") &&
              result.stdout.includes("--log-file") &&
              result.stdout.includes("--service-unit"),
            (result) =>
              new BootServiceCommandError({
                step: "verifying Windows service launcher support",
                exitCode: Number(result.code),
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
          ),
          Effect.tapError(logFailure),
        );
    }

    return yield* withWindowsAccountLock(
      manager,
      Effect.gen(function* () {
        const existingSnapshot = yield* readInstalledUnitSnapshot();
        yield* guardWindowsSnapshot(existingSnapshot);
        const installed =
          Option.isSome(existingSnapshot.localUnit) ||
          Option.isSome(existingSnapshot.effectiveUnit);
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
        // Task Scheduler restarts the task itself, so the files are written as for a deferred
        // restart while this launcher keeps running, then the restart is handed to the manager.
        const handOff = installed && start && runningInsideService && manager.kind === "schtasks";
        const schtasksProblems =
          installed && !handOff && manager.kind === "schtasks"
            ? yield* readSchtasksProblems(
                existingSnapshot.effectiveUnit,
                existingSnapshot.queriedTask,
              )
            : undefined;
        let canRestoreWindows = false;

        yield* Effect.gen(function* () {
          if (installed && start && !handOff) {
            if (schtasksProblems !== undefined) {
              yield* runSteps(manager.prepareStop);
              canRestoreWindows = true;
              yield* runSteps(manager.finishStop);
            } else {
              yield* runSteps(manager.stop);
            }
          }
          let stagedLauncherId: string | undefined;
          if (manager.kind === "schtasks") {
            const staged = yield* Effect.tryPromise({
              try: (signal) =>
                stageServiceLauncherInstall({
                  controlDir: resolveControlDir(input.baseDir),
                  baseDir: input.baseDir,
                  version: input.cliVersion,
                  signal,
                  acl: host.acl,
                  ...(options?.allowDowngrade === undefined
                    ? {}
                    : { allowDowngrade: options.allowDowngrade }),
                }),
              catch: (cause) => new BootServiceInstallError({ cause }),
            });
            if (staged.status === "update-pending") {
              const psQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;
              return yield* new BootServiceUpdatePendingError(
                !installed && staged.installedVersion !== undefined
                  ? {
                      recoveryCommand: `& ${psQuote(pinnedRuntimePaths(path, input.baseDir, staged.installedVersion, platform).entryPath)} __service-launcher --base-dir ${psQuote(input.baseDir)}`,
                    }
                  : {},
              );
            }
            if (staged.status === "downgrade-refused") {
              return yield* new BootServiceDowngradeRefusedError({
                installedVersion: staged.installedVersion,
                targetVersion: input.cliVersion,
              });
            }
            stagedLauncherId = staged.launcherId;
            // State first, then unit. The launcher acquires only one at a time, and a
            // failure to lock the unit must never prevent its durable update commit.
            yield* withSelectionLock(
              statePath,
              withSelectionLock(
                unitPath,
                Effect.gen(function* () {
                  if (!start || handOff) {
                    const written = yield* fs.readFileString(statePath).pipe(Effect.option);
                    if (
                      Option.isSome(written) &&
                      (serviceStateHasPendingUpdate(written.value) ||
                        serviceStateActiveVersion(written.value) !== input.cliVersion)
                    ) {
                      return yield* new BootServiceUpdatePendingError();
                    }
                  }
                  yield* fs
                    .makeDirectory(path.dirname(unitPath), { recursive: true })
                    .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
                  if (taskNamePath !== "") {
                    yield* writeDurably(taskNamePath, `${windowsSession.taskName}\n`);
                  }
                  yield* writeDurably(unitPath, manager.render(plan));
                }),
              ),
            );
          } else {
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
                  yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, {
                    mode: 0o600,
                  });
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
            );
          }

          if (handOff) {
            yield* runSteps(manager.handoff ?? []);
            yield* signalPreviousWindowsLauncher(stagedLauncherId);
          } else if (start) {
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
          } else if (manager.kind === "schtasks") {
            // Task Scheduler keeps its own copy of the task action; register `<Enabled>false</Enabled>`
            // directly when the task must stay disabled so the minute trigger never fires in between.
            if (!installed || schtasksProblems?.includes("service-disabled") === true) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const latestUnit = Option.getOrElse(
                    yield* fs.readFileString(unitPath).pipe(Effect.option),
                    () => manager.render(plan),
                  );
                  const disabledXml = /<Enabled>\s*false\s*<\/Enabled>/i.test(latestUnit)
                    ? latestUnit
                    : latestUnit.replace(
                        /<\/Settings>/i,
                        "    <Enabled>false</Enabled>\n  </Settings>",
                      );
                  const disabledXmlPath = yield* fs
                    .makeTempFileScoped({
                      directory: path.dirname(unitPath),
                      prefix: ".service-task-",
                    })
                    .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
                  yield* fs
                    .writeFileString(disabledXmlPath, disabledXml, { mode: 0o600 })
                    .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
                  yield* runStep("registering the scheduled task", schtasksCommand, [
                    "/Create",
                    "/XML",
                    disabledXmlPath,
                    "/TN",
                    windowsSession.taskName,
                    "/F",
                  ]);
                }),
              );
            } else {
              yield* runStep("registering the scheduled task", schtasksCommand, [
                "/Create",
                "/XML",
                unitPath,
                "/TN",
                windowsSession.taskName,
                "/F",
              ]);
            }
          }
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) &&
            installed &&
            start &&
            !handOff &&
            (schtasksProblems === undefined || canRestoreWindows)
              ? runSteps(
                  schtasksProblems === undefined
                    ? manager.restart
                    : schtasksRestoreSteps(manager, schtasksProblems, { mayHaveEnabled: true }),
                ).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
        return handOff ? { ...plan, handedOff: true } : plan;
      }),
      (cause) => new BootServiceInstallError({ cause }),
    );
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    return yield* withWindowsAccountLock(
      manager,
      Effect.gen(function* () {
        const snapshot = yield* readInstalledUnitSnapshot();
        if (manager.kind === "schtasks" && snapshot.queriedTask.state === "failed") {
          return yield* new BootServiceCommandError({ step: "inspecting the scheduled task" });
        }
        if (Option.isNone(snapshot.effectiveUnit)) return "skipped" as const;
        const installedBaseDir = bootServiceBaseDirOf(snapshot.effectiveUnit.value);
        if (installedBaseDir === undefined || !sameBaseDir(installedBaseDir, input.baseDir)) {
          return "skipped" as const;
        }
        const localUnitMatchesEffective =
          Option.isSome(snapshot.localUnit) &&
          (() => {
            const localBaseDir = bootServiceBaseDirOf(snapshot.localUnit.value);
            const localProgram = bootServiceProgramOf(snapshot.localUnit.value);
            if (
              localBaseDir === undefined ||
              localProgram === undefined ||
              !sameBaseDir(localBaseDir, input.baseDir)
            ) {
              return false;
            }
            if (
              snapshot.registeredTaskXml !== undefined &&
              windowsTaskHasActions(snapshot.registeredTaskXml)
            ) {
              return localProgram === bootServiceProgramOf(snapshot.registeredTaskXml);
            }
            return true;
          })();
        const directWindowsTaskSteps = manager.kind === "schtasks" && !localUnitMatchesEffective;
        // Writes no state, and the launcher lets an update transition in flight
        // finish before the queued stop tears it down.
        if (runningInsideService && manager.handoff !== undefined) {
          const previousLauncherId =
            manager.kind === "schtasks"
              ? yield* Effect.tryPromise({
                  try: (signal) =>
                    queryServiceLauncherId(resolveControlDir(input.baseDir), {
                      signal,
                      acl: host.acl,
                    }),
                  catch: (cause) =>
                    new BootServiceCommandError({
                      step: "inspecting the installed service",
                      cause,
                    }),
                }).pipe(Effect.orElseSucceed(() => undefined))
              : undefined;
          const handoffSteps: ReadonlyArray<BootServiceStep> = directWindowsTaskSteps
            ? [
                {
                  step: "enabling the scheduled task",
                  command: schtasksCommand,
                  args: ["/Change", "/TN", windowsSession.taskName, "/ENABLE"],
                },
                {
                  step: "ending the scheduled task",
                  command: schtasksCommand,
                  args: ["/End", "/TN", windowsSession.taskName],
                  optional: true,
                },
                {
                  step: "restarting the service",
                  command: schtasksCommand,
                  args: ["/Run", "/TN", windowsSession.taskName],
                },
              ]
            : manager.handoff;
          yield* runSteps(handoffSteps);
          yield* signalPreviousWindowsLauncher(previousLauncherId);
          return "queued" as const;
        }
        if (manager.kind === "schtasks") {
          const schtasksProblems = yield* readSchtasksProblems(
            snapshot.effectiveUnit,
            snapshot.queriedTask,
          );
          const activateSteps: ReadonlyArray<BootServiceStep> = directWindowsTaskSteps
            ? [
                {
                  step: "enabling the scheduled task",
                  command: schtasksCommand,
                  args: ["/Change", "/TN", windowsSession.taskName, "/ENABLE"],
                },
                {
                  step: "starting the service",
                  command: schtasksCommand,
                  args: ["/Run", "/TN", windowsSession.taskName],
                },
              ]
            : manager.activate;
          yield* runSteps(manager.prepareStop);
          yield* Effect.gen(function* () {
            yield* runSteps(manager.finishStop);
            yield* runSteps(activateSteps);
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? runSteps(
                    schtasksRestoreSteps(manager, schtasksProblems, { mayHaveEnabled: true }),
                  ).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
        } else {
          yield* runSteps(manager.stop);
          yield* runSteps(manager.activate).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? runSteps(manager.restart).pipe(Effect.ignore) : Effect.void,
            ),
          );
        }
        yield* fs
          .remove(restartPendingPath, { force: true })
          .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
        return "restarted" as const;
      }),
      (cause) => new BootServiceInstallError({ cause }),
    );
  }).pipe(Effect.withSpan("cloud.boot_service.restart"));

  const withStopped = Effect.fn("cloud.boot_service.with_stopped")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | BootServiceError, R> {
    if (detectedManager === undefined) return yield* operation;
    const manager = detectedManager;
    return yield* withWindowsAccountLock(
      manager,
      Effect.gen(function* () {
        const snapshot = yield* readInstalledUnitSnapshot();
        if (manager.kind === "schtasks" && snapshot.queriedTask.state === "failed") {
          return yield* new BootServiceCommandError({ step: "inspecting the scheduled task" });
        }
        if (Option.isNone(snapshot.effectiveUnit)) return yield* operation;
        const installedBaseDir = bootServiceBaseDirOf(snapshot.effectiveUnit.value);
        if (installedBaseDir === undefined || !sameBaseDir(installedBaseDir, input.baseDir)) {
          return yield* operation;
        }
        if (runningInsideService) {
          return yield* new BootServiceRunningInsideServiceError();
        }
        // `is-active` misses crash-looping systemd units; launchd can be loaded without a pid.
        // Always stop; restore only if previously active, enabled, or loaded,
        // so disabled crash loops stay stopped.
        const schtasksProblems =
          manager.kind === "schtasks"
            ? yield* readSchtasksProblems(snapshot.effectiveUnit, snapshot.queriedTask)
            : undefined;
        const restoreSteps =
          schtasksProblems === undefined
            ? manager.restart
            : schtasksRestoreSteps(manager, schtasksProblems);
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
            : schtasksProblems !== undefined
              ? restoreSteps.length > 0
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
            const start = runSteps(restoreSteps);
            return Exit.isFailure(exit) ? Effect.ignore(start) : start;
          },
        );
      }),
      (cause) => new BootServiceInstallError({ cause }),
    );
  });

  const signalCurrentWindowsLauncherForUninstall = (controlDir: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const signaled = await signalServiceLauncherStop(controlDir, undefined, {
          signal,
          acl: host.acl,
          uninstall: true,
        });
        if (signaled) return;
        const remaining = await probeServiceLauncher(controlDir, {
          signal,
          acl: host.acl,
        });
        if (remaining !== "stopped") {
          throw new Error("Could not signal the running service launcher to stop.");
        }
      },
      catch: (cause) =>
        new BootServiceCommandError({ step: "stopping the installed service", cause }),
    });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    return yield* withWindowsAccountLock(
      manager,
      Effect.gen(function* () {
        if (manager.kind !== "schtasks") {
          const unitInfo = yield* statOptionalPath(unitPath);
          if (Option.isNone(unitInfo) || unitInfo.value.type === "Directory") {
            if (Option.isNone(unitInfo)) {
              yield* Effect.tryPromise({
                try: (signal) =>
                  recoverServiceLauncherUninstall({
                    baseDir: input.baseDir,
                    signal,
                  }),
                catch: (cause) => new BootServiceInstallError({ cause }),
              });
            }
            return false;
          }
          const readableUnit = yield* fs.readFileString(unitPath).pipe(Effect.option);
          const otherBaseDir = Option.isSome(readableUnit)
            ? otherBaseDirOf(readableUnit.value)
            : undefined;
          if (otherBaseDir !== undefined) {
            return yield* new BootServiceOtherBaseDirError({
              installedBaseDir: otherBaseDir,
              baseDir: input.baseDir,
            });
          }
          yield* runSteps(manager.deactivate);
          yield* Effect.tryPromise({
            try: (signal) =>
              recoverServiceLauncherUninstall({
                baseDir: input.baseDir,
                signal,
              }),
            catch: (cause) => new BootServiceInstallError({ cause }),
          });
          yield* withSelectionLock(
            unitPath,
            fs
              .remove(unitPath, { force: true })
              .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
          );
          yield* runSteps(manager.finalize);
          return true;
        }

        const [localUnitInfo, queriedTask] = yield* Effect.all(
          [statOptionalPath(unitPath), queryRegisteredWindowsTask()],
          { concurrency: "unbounded" },
        );
        const localUnit =
          Option.isSome(localUnitInfo) && localUnitInfo.value.type !== "Directory"
            ? yield* fs.readFileString(unitPath).pipe(Effect.option)
            : Option.none<string>();
        const registeredTaskXml = queriedTask.state === "present" ? queriedTask.xml : undefined;
        const effectiveUnit = selectEffectiveWindowsUnit(localUnit, registeredTaskXml);
        yield* guardWindowsSnapshot({ queriedTask, effectiveUnit });

        const hasTaskOrMirror =
          queriedTask.state === "present" ||
          (Option.isSome(localUnitInfo) && localUnitInfo.value.type !== "Directory");
        const controlDir = resolveControlDir(input.baseDir);
        const removePersistedTaskName =
          taskNamePath === ""
            ? Effect.void
            : fs
                .remove(taskNamePath, { force: true })
                .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

        if (!hasTaskOrMirror) {
          const launcherState = yield* Effect.tryPromise({
            try: (signal) =>
              probeServiceLauncher(controlDir, {
                signal,
                acl: host.acl,
              }),
            catch: (cause) =>
              new BootServiceCommandError({ step: "stopping the installed service", cause }),
          });
          if (launcherState === "stopped") {
            yield* Effect.tryPromise({
              try: (signal) =>
                recoverServiceLauncherUninstall({
                  baseDir: input.baseDir,
                  controlDir,
                  signal,
                  acl: host.acl,
                }),
              catch: (cause) => new BootServiceInstallError({ cause }),
            });
            yield* removePersistedTaskName;
            return false;
          }
          if (runningInsideService) {
            if (launcherState === "unhealthy") {
              return yield* new BootServiceCommandError({
                step: "stopping the installed service",
              });
            }
            yield* signalCurrentWindowsLauncherForUninstall(controlDir);
          } else {
            yield* stopWindowsLauncher();
            yield* Effect.tryPromise({
              try: (signal) =>
                recoverServiceLauncherUninstall({
                  baseDir: input.baseDir,
                  controlDir,
                  signal,
                  acl: host.acl,
                }),
              catch: (cause) => new BootServiceInstallError({ cause }),
            });
          }
          yield* removePersistedTaskName;
          return true;
        }

        if (runningInsideService) {
          const launcherState = yield* Effect.tryPromise({
            try: (signal) =>
              probeServiceLauncher(controlDir, {
                signal,
                acl: host.acl,
              }),
            catch: (cause) =>
              new BootServiceCommandError({ step: "stopping the installed service", cause }),
          });
          if (launcherState === "unhealthy") {
            return yield* new BootServiceCommandError({
              step: "stopping the installed service",
            });
          }
          // Remove the local mirror under its selection lease before `/Delete` so an in-flight
          // `#repointServiceUnit` finishes first and any later one sees ENOENT before signaling stop.
          yield* runSteps([{ step: "disabling the scheduled task", run: disableWindowsTask() }]);
          yield* withSelectionLock(
            unitPath,
            fs
              .remove(unitPath, { force: true })
              .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
          );
          yield* runSteps([{ step: "removing the scheduled task", run: deleteWindowsTask() }]);
          if (launcherState === "running") {
            yield* signalCurrentWindowsLauncherForUninstall(controlDir);
          } else {
            yield* Effect.tryPromise({
              try: (signal) =>
                recoverServiceLauncherUninstall({
                  baseDir: input.baseDir,
                  controlDir,
                  signal,
                  acl: host.acl,
                }),
              catch: (cause) => new BootServiceInstallError({ cause }),
            });
          }
          yield* removePersistedTaskName;
          return true;
        }

        yield* runSteps(manager.deactivate);
        yield* Effect.tryPromise({
          try: (signal) =>
            recoverServiceLauncherUninstall({
              baseDir: input.baseDir,
              controlDir,
              signal,
              acl: host.acl,
            }),
          catch: (cause) => new BootServiceInstallError({ cause }),
        });
        yield* withSelectionLock(
          unitPath,
          fs
            .remove(unitPath, { force: true })
            .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
        );
        yield* removePersistedTaskName;
        yield* runSteps(manager.finalize);
        return true;
      }),
      (cause) => new BootServiceInstallError({ cause }),
    );
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    const snapshot = yield* readInstalledUnitSnapshot();
    if (
      detectedManager.kind === "schtasks" &&
      snapshot.queriedTask.state === "failed" &&
      Option.isNone(snapshot.effectiveUnit)
    ) {
      return yield* new BootServiceCommandError({ step: "inspecting the scheduled task" });
    }
    if (Option.isNone(snapshot.effectiveUnit)) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const unit = snapshot.effectiveUnit.value;
    const [runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
      fs
        .exists(runtimePaths.entryPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
      readOptionalFileString(runtimePaths.sentinelPath),
      readOptionalFileString(statePath),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir = bootServiceBaseDirOf(unit);
    const otherBaseDir = otherBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd"
        ? [...(yield* readSystemdProblems(true))]
        : detectedManager.kind === "schtasks"
          ? [...(yield* readSchtasksProblems(Option.some(unit), snapshot.queriedTask))]
          : [];
    if (
      yield* fs
        .exists(restartPendingPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })))
    ) {
      problems.push("restart-pending");
    }
    const registeredWindowsTaskCurrent =
      detectedManager.kind !== "schtasks" ||
      snapshot.registeredTaskXml === undefined ||
      !windowsTaskHasActions(snapshot.registeredTaskXml) ||
      (installedBaseDir !== undefined &&
        sameBaseDir(installedBaseDir, input.baseDir) &&
        bootServiceProgramOf(snapshot.registeredTaskXml) === runtimePaths.entryPath);
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      ...(otherBaseDir === undefined ? {} : { otherBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        Option.isSome(snapshot.localUnit) &&
        normalizeUnit(snapshot.localUnit.value) === normalizeUnit(detectedManager.render(plan)) &&
        registeredWindowsTaskCurrent &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(Effect.withSpan("cloud.boot_service.status"));

  return BootService.of({ install, restart, withStopped, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
