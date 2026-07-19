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
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Installs T3 Code as a per-user boot service so a connected machine stays
 * reachable through T3 Connect after the SSH session ends. Linux-only for
 * now: systemd user unit + loginctl enable-linger. The service runs a pinned
 * runtime installed under <baseDir>/runtime — never `npx t3`, whose cache is
 * ephemeral and whose registry fetch at boot would make startup depend on
 * the network.
 */

const BOOT_SERVICE_NAME = "t3code";
const BOOT_RUNTIME_DIR = "runtime";

const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);

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
    "Description=T3 Code server (T3 Connect)",
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

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup currently supports Linux with systemd; this machine reports '${this.platform}'.`;
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

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  /** False when the installed unit no longer matches what install would write. */
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    /** Installs the pinned runtime + unit, enables linger, starts the service. */
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
    // When running the packed CLI this is dist/bin.mjs; when stable (global
    // install, repo checkout) the boot service runs this same artifact.
    cliEntryPath: hostArguments[1] ?? "",
  };
  const platform = yield* HostProcessPlatform;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const unitDir = path.join(homeDir, ".config", "systemd", "user");
  const unitPath = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const logPath = path.join(input.logsDir, "boot-service.log");
  const runtimeVersionDir = path.join(
    input.baseDir,
    BOOT_RUNTIME_DIR,
    "versions",
    input.cliVersion,
  );
  const runtimeEntryPath = path.join(runtimeVersionDir, "node_modules", "t3", "dist", "bin.mjs");
  const runtimeSentinelPath = path.join(runtimeVersionDir, ".install-complete");

  const requireSystemdLinux = Effect.gen(function* () {
    if (platform !== "linux" || homeDir === "") {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

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

  /**
   * Ensures plannedEntryPath exists before the unit points at it. A stable
   * install (global bin, repo checkout) is used as-is; an ephemeral cache
   * entry is replaced by `npm install --prefix`-ing the exact running
   * version into <baseDir>/runtime/versions/<v>. A real install (not a copy
   * of bin.mjs) because t3 ships native deps like node-pty.
   */
  const ensurePinnedRuntime = Effect.gen(function* () {
    if (!isEphemeralCacheEntry(host.cliEntryPath)) {
      return;
    }
    // The sentinel is written only after npm exits 0. Checking the entry
    // file alone is not enough: npm extracts files before running native
    // builds (node-pty), so a killed install leaves a plausible-looking but
    // broken tree behind.
    const alreadyPinned = yield* Effect.all([
      fs.exists(runtimeSentinelPath),
      fs.exists(runtimeEntryPath),
    ]).pipe(
      Effect.map(([sentinelExists, entryExists]) => sentinelExists && entryExists),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
    if (alreadyPinned) {
      return;
    }
    yield* fs.remove(runtimeVersionDir, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.makeDirectory(runtimeVersionDir, { recursive: true })),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
    yield* runStep(
      "installing the pinned t3 runtime (this can take a few minutes)",
      "npm",
      [
        "install",
        "--prefix",
        runtimeVersionDir,
        "--no-fund",
        "--no-audit",
        `t3@${input.cliVersion}`,
      ],
      // Native deps (node-pty) can compile from source on slow boxes; the
      // ProcessRunner default of 60s would kill a healthy install.
      { timeout: PINNED_RUNTIME_INSTALL_TIMEOUT },
    ).pipe(
      Effect.tapError(() =>
        fs.remove(runtimeVersionDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fs
      .writeFileString(runtimeSentinelPath, `${input.cliVersion}\n`)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  });

  // Where the unit will point: derivable without touching the network, so
  // status can compare units purely; install materializes it first.
  const plannedEntryPath = isEphemeralCacheEntry(host.cliEntryPath)
    ? runtimeEntryPath
    : host.cliEntryPath;
  const plan: BootServicePlan = {
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSystemdLinux;
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

    yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(unitPath, renderBootServiceUnit(plan))),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );

    // If any activation step fails, remove the unit again: a leftover file
    // would make the next `t3 connect` report the service as already set up
    // even though it was never enabled or lingered.
    yield* Effect.gen(function* () {
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
    }).pipe(Effect.tapError(() => rollbackFailedInstall(previousUnit)));

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  // If activation fails partway (e.g. enable succeeds but restart/linger
  // fails), leave nothing behind: disable removes the enable symlink, remove
  // deletes the file, daemon-reload clears the stale definition — otherwise a
  // dangling wants/ symlink logs "Failed to load unit" at every boot and the
  // next connect misreports the state.
  const rollbackFailedInstall = Effect.fn("cloud.boot_service.rollback_failed_install")(function* (
    previousUnit: Option.Option<string>,
  ) {
    if (Option.isSome(previousUnit)) {
      yield* fs.writeFileString(unitPath, previousUnit.value).pipe(Effect.ignore);
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
    yield* requireSystemdLinux;
    const exists = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (!exists) {
      return false;
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
    if (platform !== "linux" || homeDir === "") {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    const unitExists = yield* fs.exists(unitPath);
    if (!unitExists) {
      return { supported: true, installed: false, current: false, unitPath, logPath };
    }
    const unit = yield* fs.readFileString(unitPath);
    // A unit is current only if it matches what install would write now (an
    // older CLI wrote a different runtime/node path) AND the entry point it
    // references still exists (a pinned runtime under ~/.t3 can be deleted to
    // reclaim space). Either mismatch makes connect offer a repair.
    const entryExists = yield* fs.exists(plannedEntryPath);
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
