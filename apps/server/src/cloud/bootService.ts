import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically, writeSymbolicLinkAtomically } from "../atomicWrite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";

/**
 * Installs T3 Code as a per-user background service: systemd + linger on
 * Linux, or a LaunchAgent on macOS. The service runs a stable or pinned
 * runtime — never an ephemeral `npx t3` cache whose eviction could break
 * startup.
 */

const BOOT_SERVICE_NAME = "t3code";

export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const BOOT_SERVICE_LAUNCH_AGENT_LABEL = "com.t3tools.t3code.server";
export const BOOT_SERVICE_LAUNCH_AGENT_FILE = `${BOOT_SERVICE_LAUNCH_AGENT_LABEL}.plist`;

const EPHEMERAL_CACHE_SEGMENTS = [
  "/_npx/", // npx
  "\\_npx\\",
  "/pnpm/dlx/", // pnpm dlx (~/.cache/pnpm/dlx and $PNPM_HOME/.pnpm/dlx)
  "/.pnpm/dlx/",
  "/.bun/install/cache/", // bunx
];

/**
 * `npx t3` (and pnpm dlx / bunx) run out of ephemeral package-manager
 * caches that can be evicted at any time — a boot service must never point
 * there. Global installs, repo checkouts, and the pinned runtime below are
 * all stable.
 */
export function isEphemeralCacheEntry(entryPath: string): boolean {
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => entryPath.includes(segment));
}

/**
 * systemd expands `%` specifiers in most directive values, including the
 * `append:` file paths, which take the rest of the line literally and must
 * NOT be quoted.
 */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

/**
 * systemd word-splits ExecStart and Environment values and expands `%`
 * specifiers, so paths with spaces or percents must be quoted and escaped.
 */
export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  /** Absolute path of the node binary running this CLI. */
  readonly nodePath: string;
  /** Absolute path of the pinned t3 entry point the unit will run. */
  readonly t3EntryPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  /** Captured for launchd, whose default PATH omits common CLI install locations. */
  readonly pathEnvironment?: string;
}

export interface LaunchAgentPaths {
  readonly unitPath: string;
  readonly activeRuntimeLinkPath: string;
  readonly activeEntryPath: string;
  readonly serviceTarget: string;
}

export function launchAgentPaths(
  path: Path.Path,
  homeDir: string,
  baseDir: string,
  userId: number,
): LaunchAgentPaths {
  const activeRuntimeLinkPath = path.join(baseDir, "runtime", "service", "current");
  return {
    unitPath: path.join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_LAUNCH_AGENT_FILE),
    activeRuntimeLinkPath,
    activeEntryPath: path.join(activeRuntimeLinkPath, "node_modules", "t3", "dist", "bin.mjs"),
    serviceTarget: `gui/${String(userId)}/${BOOT_SERVICE_LAUNCH_AGENT_LABEL}`,
  };
}

export function escapeLaunchdXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Pure so it is testable byte-for-byte. systemd user units run with a
 * minimal environment: every path must be absolute, and the service must
 * not rely on PATH, nvm shims, or shell profiles. Failures land in
 * `logPath` because `systemctl --user` failures are otherwise invisible.
 */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // No After=network-online.target: it does not exist in the systemd *user*
  // manager, so ordering on it is silently ignored. The server retries its
  // relay connection, and Restart=always covers early-boot failures.
  return [
    "[Unit]",
    "Description=T3 Code server",
    // Give up after 5 crashes in 5 minutes so a persistently broken install
    // (deleted runtime, broken workspace) stops instead of restarting every
    // 5s forever and growing the unrotated append log without bound.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.t3EntryPath)} serve`,
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

/**
 * LaunchAgents are loaded for a user's GUI session after login. KeepAlive
 * restarts crashes, while the stable entry path lets remote updates switch
 * exact runtimes without rewriting or unloading the plist from inside the
 * process it owns.
 */
export function renderBootServiceLaunchAgent(plan: BootServicePlan): string {
  const value = escapeLaunchdXml;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${BOOT_SERVICE_LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${value(plan.nodePath)}</string>`,
    `    <string>${value(plan.t3EntryPath)}</string>`,
    "    <string>serve</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>T3CODE_HOME</key>",
    `    <string>${value(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_LAUNCH_AGENT_LABEL}</string>`,
    ...(plan.pathEnvironment === undefined
      ? []
      : ["    <key>PATH</key>", `    <string>${value(plan.pathEnvironment)}</string>`]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${value(plan.baseDir)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${value(plan.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${value(plan.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const LAUNCH_AGENT_PATH_BLOCK = /    <key>PATH<\/key>\n    <string>[^\n]*<\/string>\n/;

function isCurrentLaunchAgentDefinition(plist: string, plan: BootServicePlan): boolean {
  if (!LAUNCH_AGENT_PATH_BLOCK.test(plist)) {
    return false;
  }
  const planWithoutPath: BootServicePlan = {
    nodePath: plan.nodePath,
    t3EntryPath: plan.t3EntryPath,
    baseDir: plan.baseDir,
    logPath: plan.logPath,
    unitPath: plan.unitPath,
  };
  return (
    plist.replace(LAUNCH_AGENT_PATH_BLOCK, "") === renderBootServiceLaunchAgent(planWithoutPath)
  );
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
    supervisor: Schema.optional(Schema.Literals(["systemd", "launchd"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.exitCode === undefined
        ? `Background setup failed while ${this.step}.`
        : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
    return this.supervisor === "launchd"
      ? `${detail} If macOS blocked the background item, allow T3 Code in System Settings > General > Login Items & Extensions.`
      : detail;
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

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  /** False when the installed service no longer matches what install would write. */
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    /** Installs the runtime + user service and starts it immediately. */
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Stops and removes the unit; leaves the pinned runtime for reuse.
     * Returns whether a unit was actually removed.
     */
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly cliEntryPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const hostArguments = yield* HostProcessArguments;
  const host = input.host ?? {
    execPath: hostExecPath,
    // When running the packed CLI this is dist/bin.mjs. Linux can reuse a
    // stable global install or checkout; macOS pins the exact CLI version.
    cliEntryPath: hostArguments[1] ?? "",
  };
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const userId = yield* HostProcessUserId;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const systemdUnitDir = path.join(homeDir, ".config", "systemd", "user");
  const systemdUnitPath = path.join(systemdUnitDir, BOOT_SERVICE_UNIT_FILE);
  const launchAgent =
    userId === null ? null : launchAgentPaths(path, homeDir, input.baseDir, userId);
  const unitDir =
    platform === "darwin" && launchAgent !== null
      ? path.dirname(launchAgent.unitPath)
      : systemdUnitDir;
  const unitPath =
    platform === "darwin" && launchAgent !== null ? launchAgent.unitPath : systemdUnitPath;
  const logPath = path.join(input.logsDir, "boot-service.log");
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);

  const requireSupportedPlatform = Effect.gen(function* () {
    if (
      homeDir === "" ||
      (platform !== "linux" && platform !== "darwin") ||
      (platform === "darwin" && userId === null)
    ) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeout?: Duration.Input;
      readonly supervisor?: "systemd" | "launchd";
    },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError(
        (cause) =>
          new BootServiceCommandError({
            step,
            cause,
            supervisor: options?.supervisor,
          }),
      ),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
            supervisor: options?.supervisor,
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

  const runOptionalStep = Effect.fn("cloud.boot_service.run_optional_step")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* runner.run({ command, args }).pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
    );
  });
  const isLaunchAgentLoaded = Effect.fn("cloud.boot_service.is_launch_agent_loaded")(function* () {
    if (launchAgent === null) {
      return false;
    }
    return yield* runner
      .run({
        command: "/bin/launchctl",
        args: ["print", launchAgent.serviceTarget],
      })
      .pipe(
        Effect.map((result) => result.code === 0),
        Effect.mapError(
          (cause) =>
            new BootServiceCommandError({
              step: "checking the LaunchAgent",
              supervisor: "launchd",
              cause,
            }),
        ),
      );
  });
  const readLaunchAgentDisabled = Effect.fn("cloud.boot_service.read_launch_agent_disabled")(
    function* () {
      if (launchAgent === null || userId === null) {
        return Option.none<boolean>();
      }
      return yield* runner
        .run({
          command: "/bin/launchctl",
          args: ["print-disabled", `gui/${String(userId)}`],
        })
        .pipe(
          Effect.map((result) =>
            result.code === 0
              ? Option.some(
                  result.stdout
                    .split("\n")
                    .some(
                      (line) =>
                        line.includes(BOOT_SERVICE_LAUNCH_AGENT_LABEL) && line.includes("=> true"),
                    ),
                )
              : Option.none<boolean>(),
          ),
          Effect.orElseSucceed(() => Option.none<boolean>()),
        );
    },
  );
  const runLaunchAgentStep = Effect.fn("cloud.boot_service.run_launch_agent_step")(function* (
    step: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* runStep(step, "/bin/launchctl", args, { supervisor: "launchd" });
  });

  /**
   * Ensures plannedRuntimeEntryPath exists before the service points at it.
   * macOS always gets an exact managed runtime so the LaunchAgent can use a
   * stable symlink across remote updates. Linux can reuse a stable global or
   * checkout entry; ephemeral cache entries are pinned on both platforms.
   */
  const ensurePinnedRuntime = Effect.gen(function* () {
    if (platform !== "darwin" && !isEphemeralCacheEntry(host.cliEntryPath)) {
      return;
    }
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
    }).pipe(
      Effect.mapError((error) =>
        error.step.startsWith("installing")
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error.cause,
            })
          : new BootServiceInstallError({ cause: error }),
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

  // Where the service definition will point; install materializes it first.
  const plannedRuntimeEntryPath =
    platform === "darwin" || isEphemeralCacheEntry(host.cliEntryPath)
      ? runtimePaths.entryPath
      : host.cliEntryPath;
  const plannedEntryPath =
    platform === "darwin" && launchAgent !== null
      ? launchAgent.activeEntryPath
      : plannedRuntimeEntryPath;
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
    pathEnvironment: hostEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };

  const writeUnit = (contents: string) =>
    writeFileStringAtomically({ filePath: unitPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const writeActiveRuntimeLink = (targetPath: string) => {
    if (launchAgent === null) {
      return Effect.void;
    }
    return writeSymbolicLinkAtomically({
      linkPath: launchAgent.activeRuntimeLinkPath,
      targetPath,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSupportedPlatform;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    yield* ensurePinnedRuntime;

    const previousUnit = yield* fs.exists(unitPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(unitPath).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );

    const previousRuntimeLink =
      platform === "darwin" && launchAgent !== null
        ? yield* fs.exists(launchAgent.activeRuntimeLinkPath).pipe(
            Effect.flatMap((exists) =>
              exists
                ? fs.readLink(launchAgent.activeRuntimeLinkPath).pipe(Effect.map(Option.some))
                : Effect.succeed(Option.none<string>()),
            ),
            Effect.mapError((cause) => new BootServiceInstallError({ cause })),
          )
        : Option.none<string>();
    const previousLaunchAgentDisabled =
      platform === "darwin" ? yield* readLaunchAgentDisabled() : Option.none<boolean>();
    const previousLaunchAgentLoaded = platform === "darwin" ? yield* isLaunchAgentLoaded() : false;

    yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
      Effect.andThen(
        platform === "darwin"
          ? writeActiveRuntimeLink(runtimePaths.versionDir).pipe(
              Effect.andThen(writeUnit(renderBootServiceLaunchAgent(plan))),
            )
          : writeUnit(renderBootServiceUnit(plan)),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
      Effect.tapError(() =>
        rollbackFailedInstall(
          previousUnit,
          previousRuntimeLink,
          previousLaunchAgentDisabled,
          previousLaunchAgentLoaded,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      if (platform === "darwin" && launchAgent !== null && userId !== null) {
        const domain = `gui/${String(userId)}`;
        // An explicit install repairs a background item the user previously
        // disabled in System Settings.
        yield* runLaunchAgentStep("enabling the LaunchAgent", [
          "enable",
          launchAgent.serviceTarget,
        ]);
        // bootout is expected to fail on first install. On repair it stops
        // the old job before bootstrap loads the new definition.
        yield* runOptionalStep("/bin/launchctl", ["bootout", launchAgent.serviceTarget]);
        yield* runLaunchAgentStep("loading the LaunchAgent", ["bootstrap", domain, unitPath]);
        yield* runLaunchAgentStep("checking the LaunchAgent", ["print", launchAgent.serviceTarget]);
        return;
      }

      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
      yield* runStep("enabling the service", "systemctl", [
        "--user",
        "enable",
        BOOT_SERVICE_UNIT_FILE,
      ]);
      // restart rather than enable --now: --now does not replace an already
      // running process, so repairing a stale unit would leave the old
      // server running until reboot. restart also starts a stopped service.
      yield* runStep("starting the service", "systemctl", [
        "--user",
        "restart",
        BOOT_SERVICE_UNIT_FILE,
      ]);
      // Linger keeps the user manager (and this service) running without an
      // open session — the whole point on a box reached over SSH. No
      // username argument: loginctl defaults to the calling user, which is
      // always right, while $USER can be stale (su without -l) or unset.
      yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
    }).pipe(
      Effect.tapError(() =>
        rollbackFailedInstall(
          previousUnit,
          previousRuntimeLink,
          previousLaunchAgentDisabled,
          previousLaunchAgentLoaded,
        ),
      ),
    );

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  // If activation fails partway (e.g. enable succeeds but restart/linger
  // fails), leave nothing behind: disable removes the enable symlink, remove
  // deletes the file, daemon-reload clears the stale definition — otherwise a
  // dangling wants/ symlink logs "Failed to load unit" at every boot and the
  // next lifecycle command misreports the state.
  const rollbackFailedInstall = Effect.fn("cloud.boot_service.rollback_failed_install")(function* (
    previousUnit: Option.Option<string>,
    previousRuntimeLink: Option.Option<string>,
    previousLaunchAgentDisabled: Option.Option<boolean>,
    previousLaunchAgentLoaded: boolean,
  ) {
    if (platform === "darwin" && launchAgent !== null && userId !== null) {
      yield* runOptionalStep("/bin/launchctl", ["bootout", launchAgent.serviceTarget]);
      if (Option.isSome(previousRuntimeLink)) {
        yield* writeActiveRuntimeLink(previousRuntimeLink.value).pipe(Effect.ignore);
      } else {
        yield* fs.remove(launchAgent.activeRuntimeLinkPath).pipe(Effect.ignore);
      }
      if (Option.isSome(previousUnit)) {
        yield* writeUnit(previousUnit.value).pipe(Effect.ignore);
        if (Option.getOrElse(previousLaunchAgentDisabled, () => false)) {
          yield* runOptionalStep("/bin/launchctl", ["disable", launchAgent.serviceTarget]);
        } else if (previousLaunchAgentLoaded) {
          yield* runOptionalStep("/bin/launchctl", [
            "bootstrap",
            `gui/${String(userId)}`,
            unitPath,
          ]);
        }
      } else {
        yield* fs.remove(unitPath).pipe(Effect.ignore);
        if (Option.getOrElse(previousLaunchAgentDisabled, () => false)) {
          yield* runOptionalStep("/bin/launchctl", ["disable", launchAgent.serviceTarget]);
        }
      }
      return;
    }

    if (Option.isSome(previousUnit)) {
      yield* writeUnit(previousUnit.value).pipe(Effect.ignore);
    } else {
      yield* runStep("cleaning up the service", "systemctl", [
        "--user",
        "disable",
        "--now",
        BOOT_SERVICE_UNIT_FILE,
      ]).pipe(Effect.ignore);
      yield* fs.remove(unitPath).pipe(Effect.ignore);
    }
    yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]).pipe(
      Effect.ignore,
    );
    if (Option.isSome(previousUnit)) {
      yield* runStep("restoring the previous service", "systemctl", [
        "--user",
        "restart",
        BOOT_SERVICE_UNIT_FILE,
      ]).pipe(Effect.ignore);
    }
  });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireSupportedPlatform;
    let stoppedLaunchAgent = false;
    if (platform === "darwin" && launchAgent !== null) {
      if (yield* isLaunchAgentLoaded()) {
        yield* runLaunchAgentStep("stopping the LaunchAgent", [
          "bootout",
          launchAgent.serviceTarget,
        ]);
        stoppedLaunchAgent = true;
      } else {
        // Catch a job loaded between the print and bootout without treating
        // the expected "not loaded" result as an uninstall failure.
        stoppedLaunchAgent = yield* runOptionalStep("/bin/launchctl", [
          "bootout",
          launchAgent.serviceTarget,
        ]);
      }
    }
    const exists = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (!exists) {
      return stoppedLaunchAgent;
    }
    if (platform === "darwin" && launchAgent !== null) {
      yield* fs
        .remove(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      return true;
    }
    yield* runStep("stopping the service", "systemctl", [
      "--user",
      "disable",
      "--now",
      BOOT_SERVICE_UNIT_FILE,
    ]);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (
      homeDir === "" ||
      (platform !== "linux" && platform !== "darwin") ||
      (platform === "darwin" && launchAgent === null)
    ) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    const unitExists = yield* fs.exists(unitPath);
    if (!unitExists) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const unit = yield* fs.readFileString(unitPath);
    const entryExists = yield* fs.exists(plannedEntryPath);
    if (platform === "darwin" && launchAgent !== null) {
      const activeRuntimeIsCurrent = yield* fs.readLink(launchAgent.activeRuntimeLinkPath).pipe(
        Effect.map((target) => target === runtimePaths.versionDir),
        Effect.orElseSucceed(() => false),
      );
      const loaded = yield* runOptionalStep("/bin/launchctl", ["print", launchAgent.serviceTarget]);
      const disabled = yield* readLaunchAgentDisabled();
      const current =
        isCurrentLaunchAgentDefinition(unit, plan) &&
        entryExists &&
        activeRuntimeIsCurrent &&
        loaded &&
        !Option.getOrElse(disabled, () => false);
      return { supported: true, installed: true, current, unitPath, logPath };
    }

    // A unit is current only if it matches what install would write now (an
    // older CLI wrote a different runtime/node path) AND the entry point it
    // references still exists (a pinned runtime under ~/.t3 can be deleted to
    // reclaim space). Either mismatch makes connect offer a repair.
    const current = unit === renderBootServiceUnit(plan) && entryExists;
    return { supported: true, installed: true, current, unitPath, logPath };
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
