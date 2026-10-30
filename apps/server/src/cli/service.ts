import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Terminal from "effect/Terminal";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import * as ServiceProtection from "../cloud/serviceProtection.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveEntryPath } from "./invocation.ts";

export const layer = (config: ServerConfig.ServerConfig["Service"]) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  }).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(FetchHttpClient.layer));

export type ServiceReconcileResult =
  | {
      readonly changed: false;
      readonly status: BootService.BootServiceStatus;
    }
  | {
      readonly changed: true;
      readonly previouslyInstalled: boolean;
      readonly plan: BootService.BootServicePlan;
    };

const reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {
  readonly allowDowngrade?: boolean;
  readonly start?: boolean;
}) {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  if (
    status.installedVersion !== undefined &&
    options?.allowDowngrade !== true &&
    compareExactServiceVersions(packageJson.version, status.installedVersion) < 0
  ) {
    return yield* new BootService.BootServiceDowngradeRefusedError({
      installedVersion: status.installedVersion,
      targetVersion: packageJson.version,
    });
  }
  const plan = yield* service.install(options);
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

function formatServiceChange(
  result: Extract<ServiceReconcileResult, { readonly changed: true }>,
): string {
  if (result.plan.handedOff === true) {
    return `Handed the T3 Code service switch to t3@${packageJson.version} to a separate systemd unit, since this session runs inside the service and disconnects when it restarts.\nResult: ${result.plan.logPath}`;
  }
  return `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`;
}

function formatProtection(
  protection: ServiceProtection.ServiceProtectionState | undefined,
): ReadonlyArray<string> {
  if (protection === undefined) return [];
  return [
    protection.unprotected === undefined
      ? `  Memory protection: on${protection.setByProtect ? " (t3 service protect)" : ""}`
      : `  Memory protection: off, ${protection.unprotected} grants none. Run \`t3 service protect\`.`,
    ...(protection.oomScoreAdj === undefined ? [] : [`  OOM score: ${protection.oomScoreAdj}`]),
  ];
}

function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
  protection?: ServiceProtection.ServiceProtectionState,
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, macOS with launchd";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  if (status.otherBaseDir !== undefined) {
    return [
      "T3 Code service",
      "  Status: installed for another T3 home",
      `  Base dir: ${status.otherBaseDir}`,
      `  Next: Pass \`${BootService.formatBootServiceBaseDirOption(status.otherBaseDir)}\` to manage it.`,
    ].join("\n");
  }
  if (status.unknownBaseDir === true) {
    return [
      "T3 Code service",
      "  Status: installed for a T3 home this CLI cannot read",
      `  Unit: ${status.unitPath}`,
      "  Next: Install leaves it unchanged. To replace it with this home's service, run `t3 service uninstall` first; it keeps every T3 data directory.",
    ].join("\n");
  }
  const installedVersion = status.installedVersion ?? cliVersion;
  const problems = (status.problems ?? []).map(
    (problem) => `  [${problem}] ${BootService.formatBootServiceProblem(problem)}`,
  );
  if (
    !status.current &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, cliVersion) > 0
  ) {
    return [
      "T3 Code service",
      `  Status: installed · t3@${installedVersion} (newer than this t3@${cliVersion} CLI)`,
      `  Unit: ${status.unitPath}`,
      `  Logs: ${status.logPath}`,
      ...formatProtection(protection),
      ...problems,
      `  Next: Run \`t3 update ${installedVersion}\` to match it, or pass \`--allow-downgrade\` to \`t3 service install\` explicitly.`,
    ].join("\n");
  }
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...formatProtection(protection),
    ...problems,
    ...(status.current ? [] : ["  Next: Run `t3 service install` to repair it."]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E, R>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(Effect.provide(layer(config)));
});

const serviceReconcileFlags = {
  ...projectLocationFlags,
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow replacing a newer installed service with this older CLI version."),
    Flag.withDefault(false),
  ),
};

const serviceInstallCommand = Command.make("install", serviceReconcileFlags).pipe(
  Command.withDescription("Install T3 Code as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(
            `T3 Code service is already installed with t3@${packageJson.version} (${yield* resolveEntryPath}).`,
          );
          return;
        }
        yield* Console.log(formatServiceChange(result));
      }),
    ),
  ),
);

const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
  Command.withDescription("Deprecated. Run `t3 update` to move to a newer release."),
  Command.unlisted,
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log(
          "`t3 service update` is deprecated: run `t3 update` to move to a newer release, or `t3 service install` to repair the service. Repairing now.",
        );
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(
            `T3 Code service is already using t3@${packageJson.version} (${yield* resolveEntryPath}).`,
          );
          return;
        }
        yield* Console.log(formatServiceChange(result));
      }),
    ),
  ),
);

const serviceRestartCommand = Command.make("restart", projectLocationFlags).pipe(
  Command.withDescription(
    "Restart the background service. Picks up a version installed by `t3 update` that was not restarted at the time.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const status = yield* service.status;
        const outcome = yield* service.restart;
        const onVersion =
          status.installedVersion === undefined ? "" : ` on t3@${status.installedVersion}`;
        yield* Console.log(
          outcome === "restarted"
            ? `Restarted the T3 Code service${onVersion}.`
            : outcome === "queued"
              ? `Queued a restart of the T3 Code service${onVersion}. This session runs inside the service and disconnects when it goes down.\nLogs: ${status.logPath}`
              : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", projectLocationFlags).pipe(
  Command.withDescription("Stop and remove the T3 Code background service."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const removed = yield* service.uninstall;
        yield* Console.log(
          removed ? "Removed the T3 Code service." : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStatusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show whether the T3 Code background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const path = yield* Path.Path;
        const status = yield* service.status;
        const protection =
          status.installed && (yield* HostProcess.Platform) === "linux"
            ? yield* ServiceProtection.readProtection(path.dirname(status.unitPath)).pipe(
                Effect.provide(ProcessRunner.layer),
              )
            : undefined;
        yield* Console.log(formatServiceStatus(status, packageJson.version, protection));
      }),
    ),
  ),
);

const formatDropIns = (dropIns: ReadonlyArray<ServiceProtection.DropIn>) =>
  dropIns.map(
    ({ path, contents }) => `  ${path}: ${contents.trimEnd().split("\n").slice(1).join(" ")}`,
  );

const confirm = (yes: boolean, message: string) =>
  yes ? Effect.succeed(true) : Prompt.run(Prompt.Confirm({ message, initial: false }));

const serviceProtectCommand = Command.make("protect", {
  ...projectLocationFlags,
  undo: Flag.Boolean("undo").pipe(
    Flag.withDescription("Remove the protection this command set up."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Answer yes to every question, including SSH and Tailscale."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Protect the T3 Code server from agents under memory pressure (Linux with systemd). Asks for sudo.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const unsupported = "Service protection needs Linux with systemd.";
      if ((yield* HostProcess.Platform) !== "linux") return yield* Console.log(unsupported);
      // Before resolving config, which creates T3 directories that root would then own.
      if ((yield* HostProcess.UserId) === 0) {
        return yield* Console.log(
          "Run `t3 service protect` as the user that runs T3 Code, without sudo. It asks for sudo when it needs root.",
        );
      }
      return yield* runServiceCommand(
        flags,
        Effect.gen(function* () {
          const uid = yield* HostProcess.UserId;
          const remote = yield* ServiceProtection.detectRemoteAccessUnits;
          const { unitPath } = yield* (yield* BootService.BootService).status;
          if (uid === undefined || remote === undefined || unitPath === "") {
            return yield* Console.log(unsupported);
          }
          const userUnitDir = (yield* Path.Path).dirname(unitPath);

          if (flags.undo) {
            const installed = yield* ServiceProtection.installedProtection(
              ServiceProtection.protectionPlan({
                uid,
                userUnitDir,
                remoteAccessUnits: ServiceProtection.REMOTE_ACCESS_UNITS,
              }),
            );
            if (installed === undefined) {
              return yield* Console.log("T3 Code service protection is not set up.");
            }
            yield* Console.log(
              [
                "Removes:",
                ...[...installed.system, ...installed.user, installed.managerDefaults].map(
                  ({ path, shared }) =>
                    `  ${path}${shared === true ? " (kept while another user is protected)" : ""}`,
                ),
              ].join("\n"),
            );
            if (!(yield* confirm(flags.yes, "Remove T3 Code service protection?"))) return;
            yield* ServiceProtection.removeProtection(installed);
            return yield* Console.log(
              "Removed T3 Code service protection. The server's OOM score returns to normal after `t3 service restart`.",
            );
          }

          yield* Console.log(
            [
              "Keeps T3 Code running when agents fill this machine's memory:",
              "  - reserves memory for the T3 Code server, so the kernel takes memory from agents first",
              "  - makes the out-of-memory killer pick agents before the server",
              "It adds systemd drop-in files and changes nothing else. Undo with `t3 service protect --undo`.",
            ].join("\n"),
          );
          const names = remote.map((unit) => unit.replace(/\.service$/, "")).join(" and ");
          const protectRemote =
            remote.length > 0 &&
            (yield* confirm(
              flags.yes,
              `Also protect ${names} so you can still reach this machine under memory pressure?`,
            ));
          const plan = ServiceProtection.protectionPlan({
            uid,
            userUnitDir,
            remoteAccessUnits: protectRemote ? remote : [],
          });
          yield* Console.log(
            [
              "Drop-ins it writes, as root through sudo:",
              ...formatDropIns(plan.system),
              "As you:",
              ...formatDropIns([plan.managerDefaults, ...plan.user]),
            ].join("\n"),
          );
          if (!(yield* confirm(flags.yes, "Apply these settings?"))) return;
          yield* ServiceProtection.applyProtection(plan);
          yield* Console.log(
            "Protected T3 Code. Memory protection applies now; the server takes its OOM score after `t3 service restart`. Undo with `t3 service protect --undo`.",
          );
        }).pipe(Effect.provide(ProcessRunner.layer)),
      );
    }),
  ),
);

export type ServiceOnboardingOutcome = "ready" | "pending" | "skipped";

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const { supported, installed, current } = status;
  if (!supported) {
    return "skipped" as const;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return "ready" as const;
  }
  for (const problem of status.problems ?? []) {
    yield* Console.warn(`[${problem}] ${BootService.formatBootServiceProblem(problem)}`);
  }
  if (
    installed &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, packageJson.version) > 0
  ) {
    yield* Console.log(
      `A newer t3@${status.installedVersion} background service is installed. Leaving it unchanged.`,
    );
    return "skipped" as const;
  }
  if (installed && (status.otherBaseDir !== undefined || status.unknownBaseDir === true)) {
    yield* Console.log(
      `The background service on this machine serves ${status.otherBaseDir ?? "a T3 home this CLI cannot read"}. Leaving it unchanged.`,
    );
    return "skipped" as const;
  }
  const platform = yield* HostProcess.Platform;
  const wanted = yield* Prompt.run(
    Prompt.Confirm({
      message: installed
        ? "The installed T3 Code service needs an update or repair. Update it now?"
        : platform === "darwin"
          ? "Run T3 Code in the background whenever you log in to this Mac? " +
            "It stays reachable through T3 Connect while you are logged in."
          : "Run T3 Code in the background whenever this machine boots? " +
            "It stays reachable through T3 Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return "skipped" as const;
  }
  const result = yield* reconcileService();
  if (result.changed) {
    yield* Console.log(
      result.plan.handedOff === true
        ? formatServiceChange(result)
        : `Background service ${result.previouslyInstalled ? "updated" : "installed"}. Logs: ${result.plan.logPath}`,
    );
  }
  return result.changed && result.plan.handedOff === true
    ? ("pending" as const)
    : ("ready" as const);
});

const reportServiceSetupFailure = (error: BootService.BootServiceError) =>
  Console.warn(`Background setup did not finish: ${error.message}`).pipe(
    Effect.as("skipped" as const),
  );

export const recoverServiceOnboardingOffer = <R>(
  offer: Effect.Effect<
    ServiceOnboardingOutcome,
    BootService.BootServiceError | Terminal.QuitError,
    R
  >,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed("skipped" as const),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(
          Effect.as("skipped" as const),
        ),
      BootServiceCommandError: reportServiceSetupFailure,
      BootServiceInstallError: reportServiceSetupFailure,
      BootServicePrerequisiteError: reportServiceSetupFailure,
      BootServiceUpdatePendingError: reportServiceSetupFailure,
      BootServiceDowngradeRefusedError: reportServiceSetupFailure,
      BootServiceOtherBaseDirError: reportServiceSetupFailure,
      BootServiceUnknownBaseDirError: reportServiceSetupFailure,
    }),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the T3 Code background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceRestartCommand,
    serviceUninstallCommand,
    serviceStatusCommand,
    serviceProtectCommand,
    serviceUpdateCommand,
  ]),
);
