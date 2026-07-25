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
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";

/**
 * Installs T3 Code as a per-user boot service. Linux-only for now: systemd
 * user unit + loginctl enable-linger. The service runs a stable or pinned
 * runtime — never an ephemeral `npx t3` cache whose eviction could break
 * startup.
 */

const BOOT_SERVICE_NAME = "t3code";

export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const SERVICE_SUPERVISOR_ENV = "T3_SERVICE_SUPERVISOR";
export const S6_SERVICE_DIR_ENV = "T3_S6_SERVICE_DIR";

export type ServiceSupervisor = "systemd" | "s6";

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

export function isBunEmbeddedEntryPath(entryPath: string): boolean {
  return entryPath.replaceAll("\\", "/").startsWith("/$bunfs/");
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
  readonly supervisor?: ServiceSupervisor;
  /** Absolute executable used to launch the CLI. */
  readonly nodePath: string;
  /** Optional JavaScript entry point. Empty for a standalone executable. */
  readonly t3EntryPath: string;
  readonly baseDir: string;
  /** Optional network interface persisted into the service environment. */
  readonly serverHost?: string;
  /** Optional fixed HTTP/WebSocket port persisted into the service environment. */
  readonly serverPort?: number;
  readonly logPath: string;
  readonly unitPath: string;
}

function serviceExecArgs(plan: BootServicePlan): ReadonlyArray<string> {
  return plan.t3EntryPath === ""
    ? [plan.nodePath, "serve"]
    : [plan.nodePath, plan.t3EntryPath, "serve"];
}

export function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
    ...(plan.serverHost === undefined
      ? []
      : [`Environment=T3CODE_HOST=${quoteSystemdValue(plan.serverHost)}`]),
    ...(plan.serverPort === undefined
      ? []
      : [`Environment=T3CODE_PORT=${String(plan.serverPort)}`]),
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `Environment=${SERVICE_SUPERVISOR_ENV}=systemd`,
    `ExecStart=${serviceExecArgs(plan).map(quoteSystemdValue).join(" ")}`,
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

/** Classic s6/scan-directory service script. The service directory is
 * explicit because s6-overlay and hand-managed scan directories do not share
 * a portable default location. */
export function renderS6RunScript(plan: BootServicePlan): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `export T3CODE_HOME=${quoteShellValue(plan.baseDir)}`,
    ...(plan.serverHost === undefined
      ? []
      : [`export T3CODE_HOST=${quoteShellValue(plan.serverHost)}`]),
    ...(plan.serverPort === undefined
      ? []
      : [`export T3CODE_PORT=${quoteShellValue(String(plan.serverPort))}`]),
    `export ${SERVICE_SUPERVISOR_ENV}=s6`,
    `export ${S6_SERVICE_DIR_ENV}=${quoteShellValue(pathForS6ServiceDir(plan.unitPath))}`,
    `exec ${serviceExecArgs(plan).map(quoteShellValue).join(" ")} >>${quoteShellValue(plan.logPath)} 2>&1`,
    "",
  ].join("\n");
}

function pathForS6ServiceDir(runPath: string): string {
  return runPath.endsWith("/run") ? runPath.slice(0, -4) : runPath;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd or an explicit s6 service directory; this machine reports '${this.platform}'.`;
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
  readonly standalone?: boolean;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
  readonly serverHost?: string;
  readonly serverPort?: number;
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const hostArguments = yield* HostProcessArguments;
  const platform = yield* HostProcessPlatform;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const argumentEntryPath = hostArguments[1] ?? "";
  const standalone =
    !path.isAbsolute(argumentEntryPath) || isBunEmbeddedEntryPath(argumentEntryPath);
  const host = input.host ?? {
    execPath: hostExecPath,
    // A compiled Bun executable exposes its embedded entry at the absolute
    // virtual /$bunfs path. That path cannot be passed back to a new process.
    cliEntryPath: standalone ? "" : argumentEntryPath,
    standalone,
  };

  const supervisor = input.supervisor ?? "systemd";
  const unitDir =
    supervisor === "systemd"
      ? path.join(homeDir, ".config", "systemd", "user")
      : (input.s6ServiceDir ?? "");
  const unitPath = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const definitionPath =
    supervisor === "systemd" ? unitPath : path.join(input.s6ServiceDir ?? "", "run");
  const logPath = path.join(input.logsDir, "boot-service.log");
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);

  const requireSupportedLinux = Effect.gen(function* () {
    if (
      platform !== "linux" ||
      (supervisor === "systemd" && homeDir === "") ||
      (supervisor === "s6" &&
        (input.s6ServiceDir === undefined || !path.isAbsolute(input.s6ServiceDir)))
    ) {
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

  const waitForS6Supervision = Effect.fn("cloud.boot_service.wait_for_s6_supervision")(function* (
    serviceDir: string,
  ) {
    const attempts = 100;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = yield* runner.run({ command: "s6-svok", args: [serviceDir] }).pipe(
        Effect.mapError(
          (cause) =>
            new BootServiceCommandError({
              step: "waiting for s6 supervision",
              cause,
            }),
        ),
      );
      if (result.code === 0) return;
      if (attempt < attempts) {
        yield* Effect.sleep(Duration.millis(50));
      }
    }
    return yield* new BootServiceCommandError({
      step: "waiting for s6 supervision",
    });
  });

  /**
   * Ensures plannedEntryPath exists before the unit points at it. A stable
   * install (global bin, repo checkout) is used as-is; an ephemeral cache
   * entry is replaced by `npm install --prefix`-ing the exact running
   * version into <baseDir>/runtime/versions/<v>. A real install (not a copy
   * of bin.mjs) because t3 ships native deps like node-pty.
   */
  const ensurePinnedRuntime = Effect.gen(function* () {
    if (host.standalone === true || !isEphemeralCacheEntry(host.cliEntryPath)) {
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

  // Where the unit will point: derivable without touching the network, so
  // status can compare units purely; install materializes it first.
  const plannedEntryPath =
    host.standalone === true
      ? ""
      : isEphemeralCacheEntry(host.cliEntryPath)
        ? runtimePaths.entryPath
        : host.cliEntryPath;
  const plan: BootServicePlan = {
    supervisor,
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    baseDir: input.baseDir,
    ...(input.serverHost === undefined ? {} : { serverHost: input.serverHost }),
    ...(input.serverPort === undefined ? {} : { serverPort: input.serverPort }),
    logPath,
    unitPath: definitionPath,
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSupportedLinux;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    yield* ensurePinnedRuntime;

    const previousUnit = yield* fs.exists(definitionPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(definitionPath).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );

    const definition =
      supervisor === "systemd" ? renderBootServiceUnit(plan) : renderS6RunScript(plan);
    yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(definitionPath, definition)),
      Effect.andThen(supervisor === "s6" ? fs.chmod(definitionPath, 0o755) : Effect.void),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );

    // If any activation step fails, remove the unit again: a leftover file
    // would make service status report it as installed even though it was
    // never enabled or lingered.
    yield* Effect.gen(function* () {
      if (supervisor === "systemd") {
        yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
        yield* runStep("enabling the service", "systemctl", [
          "--user",
          "enable",
          BOOT_SERVICE_UNIT_FILE,
        ]);
        yield* runStep("starting the service", "systemctl", [
          "--user",
          "restart",
          BOOT_SERVICE_UNIT_FILE,
        ]);
        yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
      } else {
        yield* runStep("rescanning the s6 service directory", "s6-svscanctl", [
          "-a",
          path.dirname(unitDir),
        ]);
        yield* waitForS6Supervision(unitDir);
        yield* runStep(
          Option.isSome(previousUnit) ? "restarting the s6 service" : "starting the s6 service",
          "s6-svc",
          [Option.isSome(previousUnit) ? "-r" : "-u", unitDir],
        );
      }
    }).pipe(Effect.tapError(() => rollbackFailedInstall(previousUnit)));

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  // If activation fails partway (e.g. enable succeeds but restart/linger
  // fails), leave nothing behind: disable removes the enable symlink, remove
  // deletes the file, daemon-reload clears the stale definition — otherwise a
  // dangling wants/ symlink logs "Failed to load unit" at every boot and the
  // next lifecycle command misreports the state.
  const rollbackFailedInstall = Effect.fn("cloud.boot_service.rollback_failed_install")(function* (
    previousUnit: Option.Option<string>,
  ) {
    if (Option.isSome(previousUnit)) {
      yield* fs.writeFileString(definitionPath, previousUnit.value).pipe(Effect.ignore);
    } else {
      if (supervisor === "systemd") {
        yield* runStep("cleaning up the service", "systemctl", [
          "--user",
          "disable",
          "--now",
          BOOT_SERVICE_UNIT_FILE,
        ]).pipe(Effect.ignore);
      } else {
        yield* runStep("cleaning up the s6 service", "s6-svc", ["-d", unitDir]).pipe(Effect.ignore);
      }
      yield* fs.remove(definitionPath).pipe(Effect.ignore);
    }
    if (supervisor === "systemd") {
      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]).pipe(
        Effect.ignore,
      );
    }
    if (Option.isSome(previousUnit)) {
      yield* (
        supervisor === "systemd"
          ? runStep("restoring the previous service", "systemctl", [
              "--user",
              "restart",
              BOOT_SERVICE_UNIT_FILE,
            ])
          : runStep("restoring the previous s6 service", "s6-svc", ["-r", unitDir])
      ).pipe(Effect.ignore);
    }
  });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireSupportedLinux;
    const exists = yield* fs
      .exists(definitionPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (!exists) {
      return false;
    }
    if (supervisor === "systemd") {
      yield* runStep("stopping the service", "systemctl", [
        "--user",
        "disable",
        "--now",
        BOOT_SERVICE_UNIT_FILE,
      ]);
    } else {
      yield* runStep("stopping the s6 service", "s6-svc", ["-d", unitDir]);
    }
    yield* fs
      .remove(definitionPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (supervisor === "systemd") {
      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    }
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (
      platform !== "linux" ||
      (supervisor === "systemd" && homeDir === "") ||
      (supervisor === "s6" &&
        (input.s6ServiceDir === undefined || !path.isAbsolute(input.s6ServiceDir)))
    ) {
      return {
        supported: false,
        installed: false,
        current: false,
        unitPath: definitionPath,
        logPath,
      };
    }
    const unitExists = yield* fs.exists(definitionPath);
    if (!unitExists) {
      return {
        supported: true,
        installed: false,
        current: false,
        unitPath: definitionPath,
        logPath,
      };
    }
    const unit = yield* fs.readFileString(definitionPath);
    // A unit is current only if it matches what install would write now (an
    // older CLI wrote a different runtime/node path) AND the entry point it
    // references still exists (a pinned runtime under ~/.t3 can be deleted to
    // reclaim space). Either mismatch makes connect offer a repair.
    const entryExists = yield* fs.exists(
      plannedEntryPath === "" ? host.execPath : plannedEntryPath,
    );
    const expected =
      supervisor === "systemd" ? renderBootServiceUnit(plan) : renderS6RunScript(plan);
    const current = unit === expected && entryExists;
    return { supported: true, installed: true, current, unitPath: definitionPath, logPath };
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
  readonly serverHost?: string;
  readonly serverPort?: number;
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
}) => Layer.effect(BootService, make(input));
