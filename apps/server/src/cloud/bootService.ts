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
  HostProcessGroupId,
  HostProcessPlatform,
  HostProcessUserId,
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
export const S6_SERVICE_USER_ENV = "T3_S6_SERVICE_USER";
export const S6_SERVICE_GROUP_ENV = "T3_S6_SERVICE_GROUP";
export const S6_SERVICE_LAUNCHER_ENV = "T3_S6_SERVICE_LAUNCHER";

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
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly serviceLauncherPath?: string;
  /** Absolute executable used to launch the CLI. */
  readonly nodePath: string;
  /** Optional JavaScript entry point. Empty for a standalone executable. */
  readonly t3EntryPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

function serviceExecArgs(plan: BootServicePlan): ReadonlyArray<string> {
  return plan.t3EntryPath === ""
    ? [plan.nodePath, "serve"]
    : [plan.nodePath, plan.t3EntryPath, "serve"];
}

function serviceExecutableArgs(plan: BootServicePlan): ReadonlyArray<string> {
  return plan.t3EntryPath === "" ? [plan.nodePath] : [plan.nodePath, plan.t3EntryPath];
}

export function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface S6ServiceIdentity {
  readonly serviceUser: string;
  readonly serviceGroup?: string;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve an s6 identity without trusting USER/LOGNAME. A non-root caller can
 * safely use its kernel identity. A root caller may inherit the original
 * identity from sudo, but otherwise must select a user explicitly.
 */
export function resolveS6ServiceIdentity(input: {
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly processUserId?: number;
  readonly processGroupId?: number;
  readonly env: NodeJS.ProcessEnv;
}): S6ServiceIdentity | undefined {
  const selectedUser = input.serviceUser?.trim();
  const selectedGroup = input.serviceGroup?.trim();
  if (selectedUser) {
    return {
      serviceUser: selectedUser,
      ...(selectedGroup ? { serviceGroup: selectedGroup } : {}),
    };
  }

  if (input.processUserId !== undefined && input.processUserId > 0) {
    return {
      serviceUser: String(input.processUserId),
      ...(selectedGroup
        ? { serviceGroup: selectedGroup }
        : input.processGroupId === undefined
          ? {}
          : { serviceGroup: String(input.processGroupId) }),
    };
  }

  const sudoUserId = parseNonNegativeInteger(input.env.SUDO_UID);
  const sudoGroupId = parseNonNegativeInteger(input.env.SUDO_GID);
  if (sudoUserId !== undefined && sudoUserId > 0 && sudoGroupId !== undefined) {
    return {
      serviceUser: String(sudoUserId),
      serviceGroup: selectedGroup ?? String(sudoGroupId),
    };
  }

  return undefined;
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
  if (plan.serviceUser === undefined) {
    throw new Error("An s6 service user is required.");
  }
  const serviceCommand =
    plan.serviceLauncherPath === undefined
      ? serviceExecArgs(plan)
      : [plan.serviceLauncherPath, "serve"];
  const serviceDir = pathForS6ServiceDir(plan.unitPath);
  const shellCommand = `exec "$@" >>${quoteShellValue(plan.logPath)} 2>&1`;
  const privilegeDropArgs =
    plan.serviceGroup === undefined
      ? ["s6-setuidgid", plan.serviceUser]
      : [
          "s6-envuidgid",
          "-nB",
          `${plan.serviceUser}:${plan.serviceGroup}`,
          "/bin/sh",
          "-c",
          'exec s6-applyuidgid -Uz -G "$GID" "$@"',
          "t3code-applyuidgid",
        ];
  return [
    "#!/bin/sh",
    "set -eu",
    `export T3CODE_HOME=${quoteShellValue(plan.baseDir)}`,
    `export ${SERVICE_SUPERVISOR_ENV}=s6`,
    `export ${S6_SERVICE_DIR_ENV}=${quoteShellValue(pathForS6ServiceDir(plan.unitPath))}`,
    `export ${S6_SERVICE_USER_ENV}=${quoteShellValue(plan.serviceUser)}`,
    ...(plan.serviceGroup === undefined
      ? []
      : [`export ${S6_SERVICE_GROUP_ENV}=${quoteShellValue(plan.serviceGroup)}`]),
    ...(plan.serviceLauncherPath === undefined
      ? []
      : [`export ${S6_SERVICE_LAUNCHER_ENV}=${quoteShellValue(plan.serviceLauncherPath)}`]),
    ...(plan.serviceGroup === undefined
      ? [
          `service_group=$(id -g ${quoteShellValue(plan.serviceUser)})`,
          `s6-svperms -G ":$service_group" ${quoteShellValue(serviceDir)}`,
        ]
      : [
          `s6-svperms -G ${quoteShellValue(
            /^\d+$/u.test(plan.serviceGroup) ? `:${plan.serviceGroup}` : plan.serviceGroup,
          )} ${quoteShellValue(serviceDir)}`,
        ]),
    `exec ${[...privilegeDropArgs, "/bin/sh", "-c", shellCommand, "t3code", ...serviceCommand]
      .map(quoteShellValue)
      .join(" ")}`,
    "",
  ].join("\n");
}

/** The root-owned s6 run script executes this mutable launcher only after
 * dropping privileges. Automatic updates can safely replace the launcher
 * without gaining a path to root execution. */
export function renderS6LauncherScript(plan: BootServicePlan): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `exec ${serviceExecutableArgs(plan).map(quoteShellValue).join(" ")} "$@"`,
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

export class BootServiceIdentityError extends Schema.TaggedErrorClass<BootServiceIdentityError>()(
  "BootServiceIdentityError",
  {
    reason: Schema.Literals(["missing", "root"]),
  },
) {
  override get message(): string {
    if (this.reason === "missing") {
      return "Installing an s6 service as root requires --service-user (and optionally --service-group), unless sudo provides a non-root invoking identity.";
    }
    return "The s6 service user must resolve to a non-root UID.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceIdentityError
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
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const hostArguments = yield* HostProcessArguments;
  const platform = yield* HostProcessPlatform;
  const processEnvironment = yield* HostProcessEnvironment;
  const processUserId = yield* HostProcessUserId;
  const processGroupId = yield* HostProcessGroupId;
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
  const serviceIdentity =
    supervisor === "s6"
      ? resolveS6ServiceIdentity({
          ...(input.serviceUser === undefined ? {} : { serviceUser: input.serviceUser }),
          ...(input.serviceGroup === undefined ? {} : { serviceGroup: input.serviceGroup }),
          ...(processUserId === undefined ? {} : { processUserId }),
          ...(processGroupId === undefined ? {} : { processGroupId }),
          env: processEnvironment,
        })
      : undefined;
  const serviceLauncherPath =
    supervisor === "s6" ? path.join(input.baseDir, "runtime", "s6-service-launcher") : undefined;
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
    ...serviceIdentity,
    ...(serviceLauncherPath === undefined ? {} : { serviceLauncherPath }),
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    baseDir: input.baseDir,
    logPath,
    unitPath: definitionPath,
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSupportedLinux;
    yield* fs
      .makeDirectory(input.baseDir, { recursive: true })
      .pipe(Effect.andThen(fs.makeDirectory(input.logsDir, { recursive: true })))
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    yield* ensurePinnedRuntime;

    if (supervisor === "s6") {
      if (serviceIdentity === undefined) {
        return yield* new BootServiceIdentityError({ reason: "missing" });
      }
      const numericUserId = parseNonNegativeInteger(serviceIdentity.serviceUser);
      if (numericUserId === 0) {
        return yield* new BootServiceIdentityError({ reason: "root" });
      }
      if (numericUserId === undefined) {
        const resolvedUser = yield* runStep("resolving the s6 service user", "id", [
          "-u",
          serviceIdentity.serviceUser,
        ]);
        const resolvedUserId = parseNonNegativeInteger(resolvedUser.stdout.trim());
        if (resolvedUserId === undefined || resolvedUserId === 0) {
          return yield* new BootServiceIdentityError({ reason: "root" });
        }
      }
    }

    const previousUnit = yield* fs.exists(definitionPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(definitionPath).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
    const previousLauncher =
      supervisor === "s6" && serviceLauncherPath !== undefined
        ? yield* fs.exists(serviceLauncherPath).pipe(
            Effect.flatMap((exists) =>
              exists
                ? fs.readFileString(serviceLauncherPath).pipe(Effect.map(Option.some))
                : Effect.succeed(Option.none<string>()),
            ),
            Effect.mapError((cause) => new BootServiceInstallError({ cause })),
          )
        : Option.none<string>();

    yield* Effect.gen(function* () {
      if (supervisor === "s6" && serviceLauncherPath !== undefined) {
        yield* fs.makeDirectory(path.dirname(serviceLauncherPath), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(serviceLauncherPath, renderS6LauncherScript(plan))),
          Effect.andThen(fs.chmod(serviceLauncherPath, 0o755)),
          Effect.mapError((cause) => new BootServiceInstallError({ cause })),
        );
      }

      if (supervisor === "s6" && serviceIdentity !== undefined) {
        const owner =
          serviceIdentity.serviceGroup === undefined
            ? serviceIdentity.serviceUser
            : `${serviceIdentity.serviceUser}:${serviceIdentity.serviceGroup}`;
        yield* runStep("reconciling s6 service state ownership", "chown", [
          "-R",
          "--",
          owner,
          ...new Set([input.baseDir, input.logsDir]),
        ]);
      }

      const definition =
        supervisor === "systemd" ? renderBootServiceUnit(plan) : renderS6RunScript(plan);
      yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(definitionPath, definition)),
        Effect.andThen(supervisor === "s6" ? fs.chmod(definitionPath, 0o755) : Effect.void),
        Effect.mapError((cause) => new BootServiceInstallError({ cause })),
      );

      // If any install or activation step fails after replacing a definition,
      // restore both the previous unit and the mutable s6 launcher.
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
    }).pipe(Effect.tapError(() => rollbackFailedInstall(previousUnit, previousLauncher)));

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  // If activation fails partway (e.g. enable succeeds but restart/linger
  // fails), leave nothing behind: disable removes the enable symlink, remove
  // deletes the file, daemon-reload clears the stale definition — otherwise a
  // dangling wants/ symlink logs "Failed to load unit" at every boot and the
  // next lifecycle command misreports the state.
  const rollbackFailedInstall = Effect.fn("cloud.boot_service.rollback_failed_install")(function* (
    previousUnit: Option.Option<string>,
    previousLauncher: Option.Option<string>,
  ) {
    if (supervisor === "s6" && serviceLauncherPath !== undefined) {
      if (Option.isSome(previousLauncher)) {
        yield* fs
          .writeFileString(serviceLauncherPath, previousLauncher.value)
          .pipe(Effect.andThen(fs.chmod(serviceLauncherPath, 0o755)), Effect.ignore);
      } else {
        yield* fs.remove(serviceLauncherPath).pipe(Effect.ignore);
      }
    }
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
    const launcherCurrent =
      supervisor !== "s6" || serviceLauncherPath === undefined
        ? true
        : yield* fs
            .exists(serviceLauncherPath)
            .pipe(
              Effect.flatMap((exists) =>
                exists
                  ? fs
                      .readFileString(serviceLauncherPath)
                      .pipe(Effect.map((launcher) => launcher === renderS6LauncherScript(plan)))
                  : Effect.succeed(false),
              ),
            );
    const expected =
      supervisor === "systemd"
        ? renderBootServiceUnit(plan)
        : serviceIdentity === undefined
          ? undefined
          : renderS6RunScript(plan);
    const current = expected !== undefined && unit === expected && entryExists && launcherCurrent;
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
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
}) => Layer.effect(BootService, make(input));
