import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Terminal from "effect/Terminal";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const bootServiceLayer = (
  config: ServerConfig.ServerConfig["Service"],
  options?: {
    readonly supervisor?: BootService.ServiceSupervisor;
    readonly s6ServiceDir?: string;
    readonly serviceUser?: string;
    readonly serviceGroup?: string;
  },
) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
    ...(options?.supervisor === undefined ? {} : { supervisor: options.supervisor }),
    ...(options?.s6ServiceDir === undefined ? {} : { s6ServiceDir: options.s6ServiceDir }),
    ...(options?.serviceUser === undefined ? {} : { serviceUser: options.serviceUser }),
    ...(options?.serviceGroup === undefined ? {} : { serviceGroup: options.serviceGroup }),
  }).pipe(Layer.provide(ProcessRunner.layer));

const supervisorFlag = Flag.choice("supervisor", ["systemd", "s6"] as const).pipe(
  Flag.withDescription("Service supervisor to configure."),
  Flag.withDefault("systemd"),
);

const s6ServiceDirFlag = Flag.string("service-dir").pipe(
  Flag.withDescription("Absolute s6 scan-directory service path (required with --supervisor s6)."),
  Flag.optional,
);

const serviceUserFlag = Flag.string("service-user").pipe(
  Flag.withDescription(
    "Non-root user for the s6 service (defaults to the invoking non-root or sudo identity).",
  ),
  Flag.optional,
);

const serviceGroupFlag = Flag.string("service-group").pipe(
  Flag.withDescription("Group for the s6 service (defaults with the invoking identity)."),
  Flag.optional,
);

const serviceFlags = {
  ...projectLocationFlags,
  supervisor: supervisorFlag,
  s6ServiceDir: s6ServiceDirFlag,
  serviceUser: serviceUserFlag,
  serviceGroup: serviceGroupFlag,
};

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

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  const plan = yield* service.install;
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
  options?: {
    readonly supervisor?: BootService.ServiceSupervisor;
    readonly s6ServiceDir?: string;
    readonly serviceUser?: string;
    readonly serviceGroup?: string;
  },
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable for this configuration\n  Supported on: Linux with systemd, or s6 with --service-dir";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  const repairCommandParts = ["npx t3@latest service update"];
  if (options?.supervisor === "s6" && options.s6ServiceDir !== undefined) {
    repairCommandParts.push(
      "--supervisor s6",
      `--service-dir ${BootService.quoteShellValue(options.s6ServiceDir)}`,
    );
    if (options.serviceUser !== undefined) {
      repairCommandParts.push(`--service-user ${BootService.quoteShellValue(options.serviceUser)}`);
    }
    if (options.serviceGroup !== undefined) {
      repairCommandParts.push(
        `--service-group ${BootService.quoteShellValue(options.serviceGroup)}`,
      );
    }
  }
  const repairCommand = repairCommandParts.join(" ");
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${cliVersion}` : "needs an update or repair"}`,
    `  Definition: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...(status.current ? [] : [`  Next: Run \`${repairCommand}\`.`]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: {
    readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"];
    readonly supervisor: BootService.ServiceSupervisor;
    readonly s6ServiceDir: Option.Option<string>;
    readonly serviceUser: Option.Option<string>;
    readonly serviceGroup: Option.Option<string>;
  },
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(
    Effect.provide(
      bootServiceLayer(config, {
        supervisor: flags.supervisor,
        ...(Option.isSome(flags.s6ServiceDir) ? { s6ServiceDir: flags.s6ServiceDir.value } : {}),
        ...(Option.isSome(flags.serviceUser) ? { serviceUser: flags.serviceUser.value } : {}),
        ...(Option.isSome(flags.serviceGroup) ? { serviceGroup: flags.serviceGroup.value } : {}),
      }),
    ),
  );
});

const serviceInstallCommand = Command.make("install", serviceFlags).pipe(
  Command.withDescription("Install T3 Code as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        if (!result.changed) {
          yield* Console.log(
            `T3 Code service is already installed with t3@${packageJson.version}.`,
          );
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUpdateCommand = Command.make("update", serviceFlags).pipe(
  Command.withDescription(
    "Update or repair the background service using this CLI version. Use `npx t3@latest service update` for the latest release.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        if (!result.changed) {
          yield* Console.log(`T3 Code service is already using t3@${packageJson.version}.`);
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", serviceFlags).pipe(
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

const serviceStatusCommand = Command.make("status", serviceFlags).pipe(
  Command.withDescription("Show whether the T3 Code background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        yield* Console.log(
          formatServiceStatus(yield* service.status, packageJson.version, {
            supervisor: flags.supervisor,
            ...(Option.isSome(flags.s6ServiceDir)
              ? { s6ServiceDir: flags.s6ServiceDir.value }
              : {}),
            ...(Option.isSome(flags.serviceUser) ? { serviceUser: flags.serviceUser.value } : {}),
            ...(Option.isSome(flags.serviceGroup)
              ? { serviceGroup: flags.serviceGroup.value }
              : {}),
          }),
        );
      }),
    ),
  ),
);

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const { supported, installed, current } = yield* service.status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return true;
  }
  const wanted = yield* Prompt.run(
    Prompt.confirm({
      message: installed
        ? "The installed T3 Code service needs an update or repair. Update it now?"
        : "Run T3 Code in the background whenever this machine boots? " +
          "It stays reachable through T3 Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return false;
  }
  const result = yield* reconcileService();
  if (result.changed) {
    yield* Console.log(
      `Background service ${result.previouslyInstalled ? "updated" : "installed"}. Logs: ${result.plan.logPath}`,
    );
  }
  return true;
});

export const recoverServiceOnboardingOffer = <R>(
  offer: Effect.Effect<boolean, BootService.BootServiceError | Terminal.QuitError, R>,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceIdentityError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
    }),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the T3 Code background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceUpdateCommand,
    serviceStatusCommand,
  ]),
);
