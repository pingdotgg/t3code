/**
 * Windows boot service. Everything in this file is the Windows path.
 *
 * Windows has no systemd, so the equivalent of the user unit is a shortcut in
 * the per-user Startup folder. The shell (`explorer.exe`) runs that shortcut at
 * every sign-in. The shortcut points at PowerShell, PowerShell spawns the
 * launcher with its console hidden, then PowerShell exits.
 *
 * Three differences from the Linux path are deliberate and load bearing:
 *
 * - Nothing supervises the launcher, so the launcher restarts its own child.
 *   The generated logon script sets `SERVICE_SELF_SUPERVISE_ENV` to say so.
 * - Nothing captures the launcher's output, so the logon script redirects it
 *   through the command shell (`cmd.exe`) rather than the launcher opening it.
 * - Windows has no SIGTERM, so stopping goes through a request file that the
 *   launcher watches. That stop is not graceful: the child is terminated
 *   without running its shutdown finalizer.
 */
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  BootService,
  BootServiceCommandError,
  BootServiceInstallError,
  BootServiceUnsupportedError,
  BootServiceUpdatePendingError,
  type BootServiceHost,
  type BootServicePlan,
} from "./bootService.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_PID_FILE,
  SERVICE_STATE_FILE,
  SERVICE_STOP_REQUEST_FILE,
  parseServiceState,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

/** Windows only. The shortcut basename doubles as the title of the window that
    blinks once at sign-in, because a console launched from a shortcut takes its
    title from the shortcut. "Server" rather than "Code" because the desktop app
    is a separate thing the user may also start. */
export const SHORTCUT_NAME = "T3 Code Server";
export const SHORTCUT_FILE = `${SHORTCUT_NAME}.lnk`;
const STARTUP_SCRIPT_FILE = "service-startup.ps1";
const SHORTCUT_SCRIPT_FILE = "service-shortcut.ps1";

/**
 * Windows only. How long the CLI waits for a running launcher to shut down.
 *
 * It must comfortably exceed the launcher's own worst case. That is a restart
 * backoff (5s, now interruptible) plus one watch interval (2s), so 30s leaves
 * room for a slow database backup holding the launcher's transition queue.
 */
const STOP_REQUEST_TIMEOUT = Duration.seconds(30);
/** Windows only. How often the CLI re-checks whether the launcher has gone. */
const STOP_REQUEST_ACK_POLL = Duration.millis(250);
const POWERSHELL_TIMEOUT = Duration.seconds(30);

/**
 * Windows only. The absolute interpreter path, rather than trusting PATH.
 * The shortcut has to spell it out anyway, so every call site uses the same one.
 */
const powershellPath = (systemRoot: string) =>
  `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * Windows only. The command shell expands `%VAR%` on its command line, even
 * inside double quotes, and there is no escape that works there. A path holding
 * a percent sign would therefore be rewritten before the launcher ever starts,
 * silently, with a successful install and nothing running. The Linux renderer
 * guards the same hazard for systemd in `escapeSystemdSpecifiers`; here the only
 * honest option is to refuse.
 */
export function findPercentInPaths(
  paths: ReadonlyArray<readonly [label: string, value: string]>,
): string | undefined {
  const offender = paths.find(([, value]) => value.includes("%"));
  return offender === undefined ? undefined : offender[0];
}

/**
 * Windows only. Signal 0 asks the kernel whether a process exists without
 * touching it. Node implements it on Windows too. A permission error means the
 * process is there but not ours, which still counts as running.
 */
const processIsAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException | undefined)?.code === "EPERM";
    }
  });

/** Windows only. PowerShell single-quoted strings escape a quote by doubling it. */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export interface WindowsBootServicePlan extends BootServicePlan {
  readonly startupScriptPath: string;
  readonly shortcutScriptPath: string;
}

/** Windows only. What the preflight learned about this machine. */
export interface WindowsPreflight {
  readonly shellRunning: boolean;
  readonly entryDisabled: boolean;
  /** Absent when no shortcut exists yet. */
  readonly shortcutTarget?: string;
  readonly shortcutArguments?: string;
}

/** Windows only. What the shortcut must point at for the service to work. */
export function expectedShortcutArguments(plan: WindowsBootServicePlan): string {
  return `-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${plan.startupScriptPath}"`;
}

/**
 * Windows only. Pure renderer for the script the shortcut runs at sign-in.
 *
 * The command shell does the redirect because PowerShell cannot append, and
 * cannot send both streams to the same file. Doubling the outer quote is the
 * documented way to pass a fully quoted command line through `cmd /c`.
 */
export function renderStartupScript(plan: WindowsBootServicePlan): string {
  const command = `""${plan.nodePath}" "${plan.launcherPath}" >> "${plan.logPath}" 2>&1"`;
  return [
    "# Generated by `t3 service install`. Do not edit; it is rewritten on update.",
    "$ErrorActionPreference = 'Stop'",
    "# Belt and braces. The blink is usually titled from the shortcut name.",
    `try { $Host.UI.RawUI.WindowTitle = ${quotePowerShellLiteral(SHORTCUT_NAME)} } catch { }`,
    `$env:T3CODE_HOME = ${quotePowerShellLiteral(plan.baseDir)}`,
    "# Nothing supervises a Startup folder entry, so the launcher supervises itself.",
    "$env:T3_SERVICE_SELF_SUPERVISE = '1'",
    `$logDir = Split-Path -Parent ${quotePowerShellLiteral(plan.logPath)}`,
    "if (-not (Test-Path -LiteralPath $logDir)) {",
    "  New-Item -ItemType Directory -Path $logDir -Force | Out-Null",
    "}",
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    "$startInfo.FileName = $env:ComSpec",
    `$startInfo.Arguments = ${quotePowerShellLiteral(`/c ${command}`)}`,
    "$startInfo.UseShellExecute = $false",
    "# The whole point: the launcher runs with no console window at all.",
    "$startInfo.CreateNoWindow = $true",
    `$startInfo.WorkingDirectory = ${quotePowerShellLiteral(plan.baseDir)}`,
    "[System.Diagnostics.Process]::Start($startInfo) | Out-Null",
    "",
  ].join("\n");
}

/**
 * Windows only. Pure renderer for the script that probes, creates and removes
 * the shortcut. One script owns every shortcut interaction so there is a single
 * place to read when the Startup entry misbehaves.
 */
export function renderShortcutScript(plan: WindowsBootServicePlan): string {
  return [
    "# Generated by `t3 service install`. Do not edit; it is rewritten on update.",
    "param([Parameter(Mandatory = $true)][ValidateSet('Probe', 'Install')][string]$Action)",
    "$ErrorActionPreference = 'Stop'",
    `$shortcutPath = ${quotePowerShellLiteral(plan.unitPath)}`,
    `$shortcutFile = ${quotePowerShellLiteral(SHORTCUT_FILE)}`,
    "",
    "if ($Action -eq 'Probe') {",
    "  # The shell is what runs Startup folder entries. A different shell is a",
    "  # deliberate choice, so this is reported and not treated as a failure.",
    "  $shell = @(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue).Count -gt 0",
    "  # Windows records entries disabled through Settings here. The low bit of",
    "  # the first byte is the disabled flag.",
    "  $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'",
    "  $disabled = $false",
    "  if (Test-Path -LiteralPath $key) {",
    "    $value = (Get-ItemProperty -LiteralPath $key -Name $shortcutFile -ErrorAction SilentlyContinue).$shortcutFile",
    "    if ($null -ne $value -and $value.Length -gt 0) { $disabled = ($value[0] -band 1) -eq 1 }",
    "  }",
    '  Write-Output "shell=$shell"',
    '  Write-Output "disabled=$disabled"',
    "  exit 0",
    "}",
    "",
    "$startupDir = Split-Path -Parent $shortcutPath",
    "if (-not (Test-Path -LiteralPath $startupDir)) {",
    "  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null",
    "}",
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($shortcutPath)",
    "$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$shortcut.Arguments = ${quotePowerShellLiteral(expectedShortcutArguments(plan))}`,
    "$shortcut.WorkingDirectory = $env:USERPROFILE",
    `$shortcut.Description = ${quotePowerShellLiteral(`${SHORTCUT_NAME}, started at sign-in`)}`,
    "# Minimized, because PowerShell paints a console before it hides itself.",
    "$shortcut.WindowStyle = 7",
    "$shortcut.Save()",
    "",
  ].join("\n");
}

/**
 * Windows only. Parses the two lines the Probe action writes.
 *
 * Returns undefined when either line is missing. Defaulting to false would read
 * as "the entry is not disabled", so a probe that failed to run would look
 * exactly like a probe that passed, and the install would sail past a check it
 * never actually performed.
 */
export function parseProbeOutput(stdout: string): WindowsPreflight | undefined {
  const read = (key: string) => {
    const match = new RegExp(`^${key}=(True|False)\\s*$`, "im").exec(stdout)?.[1];
    return match === undefined ? undefined : match === "True";
  };
  const readText = (key: string) => new RegExp(`^${key}=(.*)$`, "im").exec(stdout)?.[1]?.trim();
  const shellRunning = read("shell");
  const entryDisabled = read("disabled");
  if (shellRunning === undefined || entryDisabled === undefined) return undefined;
  const shortcutTarget = readText("target");
  const shortcutArguments = readText("arguments");
  return {
    shellRunning,
    entryDisabled,
    ...(shortcutTarget === undefined ? {} : { shortcutTarget }),
    ...(shortcutArguments === undefined ? {} : { shortcutArguments }),
  };
}

export interface WindowsBootServiceInput {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
  /** Overridable so tests do not sit through the real wait. */
  readonly stopRequestTimeout?: Duration.Duration;
}

export const make = Effect.fn("cloud.boot_service_windows.make")(function* (
  input: WindowsBootServiceInput,
) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const appData = yield* Config.string("APPDATA").pipe(Config.withDefault(""));
  const systemRoot = yield* Config.string("SystemRoot").pipe(Config.withDefault("C:\\Windows"));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };

  const startupDir = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const unitPath = path.join(startupDir, SHORTCUT_FILE);
  const logPath = path.join(input.logsDir, "boot-service.log");
  const runtimeDir = path.join(input.baseDir, "runtime");
  const launcherPath = path.join(runtimeDir, SERVICE_LAUNCHER_FILE);
  const statePath = path.join(runtimeDir, SERVICE_STATE_FILE);
  const stopRequestPath = path.join(runtimeDir, SERVICE_STOP_REQUEST_FILE);
  const pidPath = path.join(runtimeDir, SERVICE_PID_FILE);
  const startupScriptPath = path.join(runtimeDir, STARTUP_SCRIPT_FILE);
  const shortcutScriptPath = path.join(runtimeDir, SHORTCUT_SCRIPT_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);
  const launcherSourcePath =
    host.launcherSourcePath ??
    path.join(path.dirname(runtimePaths.entryPath), SERVICE_LAUNCHER_FILE);

  const plan: WindowsBootServicePlan = {
    nodePath: host.execPath,
    launcherPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
    startupScriptPath,
    shortcutScriptPath,
  };

  /**
   * Windows only. A copy of the Linux durable write, minus its final directory
   * sync. Windows cannot open a directory as a file, so that sync always fails
   * here. Every other step is identical on purpose.
   */
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

  const requireWindows = Effect.gen(function* () {
    if (platform !== "win32" || appData === "") {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

  /** Windows only. A copy of the Linux step runner, duplicated for the same
      reason as the pinned-runtime step below: extracting it would restructure
      the systemd path. Fix bugs here and in bootService.ts together. */
  const runStep = Effect.fn("cloud.boot_service_windows.run_step")(function* (
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

  const powershell = powershellPath(systemRoot);

  const runPowerShellScript = (
    step: string,
    scriptPath: string,
    extraArgs: ReadonlyArray<string> = [],
  ) =>
    runStep(
      step,
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...extraArgs,
      ],
      { timeout: POWERSHELL_TIMEOUT },
    );

  const runShortcutScript = (step: string, action: "Probe" | "Install") =>
    runPowerShellScript(step, shortcutScriptPath, ["-Action", action]);

  /**
   * Windows only. Proves the Startup folder is usable and reports what would
   * silently stop the entry from ever running. The shortcut script must already
   * be on disk, which is safe: it lives under the data directory, not the
   * Startup folder, so nothing outside our own tree has been touched yet.
   */
  const preflight: Effect.Effect<
    WindowsPreflight,
    BootServiceUnsupportedError | BootServiceInstallError | BootServiceCommandError
  > = Effect.gen(function* () {
    yield* requireWindows;
    yield* fs
      .makeDirectory(startupDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // Prove it is writable now, rather than failing halfway through an install.
    yield* Effect.scoped(
      fs.makeTempFileScoped({ directory: startupDir, prefix: ".t3-service-probe-" }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const probe = yield* runShortcutScript("checking the Windows Startup folder", "Probe");
    const findings = parseProbeOutput(probe.stdout);
    if (findings === undefined) {
      return yield* new BootServiceCommandError({
        step: "reading the Windows Startup folder check",
        stdoutLength: probe.stdout.length,
        stderrLength: probe.stderr.length,
      });
    }
    return findings;
  });

  /**
   * Windows only. Asks a running launcher to stop, because Windows has no
   * SIGTERM. The stop is not graceful: the launcher terminates its child
   * without letting it run its shutdown finalizer.
   *
   * The pid file is what makes the answer unambiguous. Its absence means no
   * launcher is running, and its disappearance means one stopped. Treating a
   * vanished request file as proof instead would let a slow launcher look
   * stopped, and the install would then rewrite the runtime underneath it and
   * start a second server on the same database.
   */
  const requestStop = Effect.gen(function* () {
    const recordedPid = yield* fs.readFileString(pidPath).pipe(Effect.option);
    if (Option.isNone(recordedPid)) return false;
    const pid = Number.parseInt(recordedPid.value.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || !(yield* processIsAlive(pid))) {
      // The launcher died without cleaning up. Nothing to wait for.
      yield* fs.remove(pidPath, { force: true }).pipe(Effect.ignore);
      return false;
    }

    // A launcher is confirmed alive, so a failed write must fail the whole
    // operation. Swallowing it would let the caller carry on and start a second
    // server against the same database.
    yield* fs
      .writeFileString(stopRequestPath, "")
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const timeoutMs = Duration.toMillis(input.stopRequestTimeout ?? STOP_REQUEST_TIMEOUT);
    const pollMs = Math.min(timeoutMs, Duration.toMillis(STOP_REQUEST_ACK_POLL));
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      yield* Effect.sleep(Duration.millis(pollMs));
      const stillRunning = yield* fs.exists(pidPath).pipe(Effect.orElseSucceed(() => true));
      if (!stillRunning) return true;
    }
    // Refusing here is the whole point. Carrying on would write over a launcher
    // we could not confirm dead.
    return yield* new BootServiceCommandError({
      step: `stopping the running service (process ${pid} did not exit in ${Math.round(timeoutMs / 1000)}s)`,
    });
  });

  /** Windows only. A copy of the Linux install's pinned-runtime step, which
      validates the runtime by asking it for its own version. It is identical,
      and it is duplicated rather than extracted because pulling it out of the
      Linux `make` would restructure the systemd path. That path is deliberately
      left alone. Fix bugs here and in bootService.ts together. */
  const installPinnedRuntime = ensurePinnedRuntimeInstalled({
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
              new PinnedRuntimeInstallError({ step: "verifying the pinned t3 runtime", cause }),
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

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireWindows;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const percentIn = findPercentInPaths([
      ["the Node executable", plan.nodePath],
      ["the data directory", plan.launcherPath],
      ["the log directory", plan.logPath],
    ]);
    if (percentIn !== undefined) {
      return yield* new BootServiceInstallError({
        cause: new Error(
          `The path to ${percentIn} contains a percent sign, and the Windows command ` +
            "shell would rewrite it before the service could start. Move T3 Code to a " +
            "path without one, or set T3CODE_HOME to such a path, then run this again.",
        ),
      });
    }

    // Write the shortcut script first so the preflight has something to run.
    // It lives under the data directory, so nothing user-visible changes yet.
    yield* writeDurably(shortcutScriptPath, renderShortcutScript(plan));
    const checks = yield* preflight;
    if (!checks.shellRunning) {
      // Not fatal. Running a different shell is a deliberate choice, and it is
      // the user's to make. Saying nothing would leave them with a service that
      // silently never starts.
      yield* Console.warn(
        "Windows Explorer is not running, and it is what starts Startup folder entries.\n" +
          "If you use a different shell, T3 Code may never start when you sign in.",
      );
    }
    if (checks.entryDisabled) {
      return yield* new BootServiceInstallError({
        cause: new Error(
          `"${SHORTCUT_NAME}" is switched off under Startup apps in Windows Settings. ` +
            "Turn it back on, then run this again.",
        ),
      });
    }

    // Prepare every immutable artifact before stopping a running launcher.
    yield* installPinnedRuntime;
    const launcherSource = yield* fs
      .readFileString(launcherSourcePath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    // Keyed on the pid file, never on the shortcut. A launcher outlives a
    // manually deleted shortcut, and starting a second one alongside it would
    // put two servers on the same database.
    const stopped = yield* requestStop;

    yield* Effect.gen(function* () {
      const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
      if (
        Option.isSome(previousStateText) &&
        serviceStateHasPendingUpdate(previousStateText.value)
      ) {
        return yield* new BootServiceUpdatePendingError();
      }
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
      yield* writeDurably(startupScriptPath, renderStartupScript(plan));

      yield* runShortcutScript("creating the Windows Startup shortcut", "Install");
      // Start last. No administrative state write occurs after this succeeds.
      yield* runPowerShellScript("starting the service", startupScriptPath);
    }).pipe(
      Effect.tapError(() =>
        installed || stopped
          ? runPowerShellScript(
              "restarting the service after a failed update",
              startupScriptPath,
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    return plan satisfies BootServicePlan;
  }).pipe(Effect.withSpan("cloud.boot_service_windows.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireWindows;
    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // Stop first, and decide that on the pid file rather than the shortcut. A
    // launcher survives someone deleting the shortcut by hand, and leaving it
    // running is exactly what the user asked us not to do.
    const stopped = yield* requestStop;
    if (!installed && !stopped) return false;

    // A shortcut is an ordinary file, so removing it needs no PowerShell. That
    // also means a missing or broken generated script cannot strand the entry.
    yield* fs
      .remove(unitPath, { force: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* fs.remove(startupScriptPath, { force: true }).pipe(Effect.ignore);
    yield* fs.remove(shortcutScriptPath, { force: true }).pipe(Effect.ignore);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service_windows.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    const base = { kind: "win32-startup-shortcut", unitPath, logPath } as const;
    if (platform !== "win32" || appData === "") {
      return { supported: false, installed: false, current: false, ...base };
    }
    if (!(yield* fs.exists(unitPath))) {
      return { supported: true, installed: false, current: false, ...base };
    }
    const [
      startupScript,
      shortcutScript,
      launcherExists,
      runtimeEntryExists,
      runtimeSentinel,
      stateText,
    ] = yield* Effect.all([
      fs.readFileString(startupScriptPath).pipe(Effect.option),
      fs.readFileString(shortcutScriptPath).pipe(Effect.option),
      fs.exists(launcherPath),
      fs.exists(runtimePaths.entryPath),
      fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
      fs.readFileString(statePath).pipe(Effect.option),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    // Read the shortcut itself back, because the script that wrote it matching
    // proves nothing about the .lnk someone may have edited or replaced since.
    const shortcut = yield* runShortcutScript(
      "checking the Windows Startup shortcut",
      "Probe",
    ).pipe(
      Effect.map((probe) => parseProbeOutput(probe.stdout)),
      Effect.orElseSucceed(() => undefined),
    );
    const shortcutMatches =
      shortcut?.shortcutTarget === powershell &&
      shortcut.shortcutArguments === expectedShortcutArguments(plan);
    // Duplicated from the Linux status. The runtime and state checks are the
    // same, but the Linux copy also compares the systemd unit, so it cannot be
    // shared without changing the Linux path.
    return {
      supported: true,
      installed: true,
      current:
        shortcutMatches &&
        Option.isSome(startupScript) &&
        startupScript.value === renderStartupScript(plan) &&
        // The shortcut script embeds the shortcut path, the interpreter and the
        // window style, so comparing it is what catches shortcut drift.
        Option.isSome(shortcutScript) &&
        shortcutScript.value === renderShortcutScript(plan) &&
        launcherExists &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      ...base,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service_windows.status"),
  );

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: WindowsBootServiceInput) => Layer.effect(BootService, make(input));
