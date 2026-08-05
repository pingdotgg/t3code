import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const bootServiceLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  }).pipe(Layer.provide(ProcessRunner.layer));

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

export class ServiceDowngradeRefusedError extends Schema.TaggedErrorClass<ServiceDowngradeRefusedError>()(
  "ServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace t3@${this.installedVersion} with older t3@${this.targetVersion}. Re-run with --allow-downgrade to continue.`;
  }
}

export function serviceDowngradeRefusal(input: {
  readonly installedVersion: string | undefined;
  readonly targetVersion: string;
  readonly allowDowngrade: boolean;
}): ServiceDowngradeRefusedError | null {
  return input.installedVersion !== undefined &&
    !input.allowDowngrade &&
    compareExactServiceVersions(input.targetVersion, input.installedVersion) < 0
    ? new ServiceDowngradeRefusedError({
        installedVersion: input.installedVersion,
        targetVersion: input.targetVersion,
      })
    : null;
}

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {
  readonly allowDowngrade?: boolean;
}) {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  const downgradeRefusal = serviceDowngradeRefusal({
    installedVersion: status.installedVersion,
    targetVersion: packageJson.version,
    allowDowngrade: options?.allowDowngrade === true,
  });
  if (downgradeRefusal !== null) {
    return yield* downgradeRefusal;
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
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  const installedVersion = status.installedVersion ?? cliVersion;
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
      `  Next: Use \`npx t3@${installedVersion} service update\` to repair it, or pass \`--allow-downgrade\` explicitly.`,
    ].join("\n");
  }
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...(status.current ? [] : ["  Next: Run `npx t3@latest service update`."]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(Effect.provide(bootServiceLayer(config)));
});

const serviceReconcileFlags = {
  ...projectLocationFlags,
  allowDowngrade: Flag.boolean("allow-downgrade").pipe(
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

const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
  Command.withDescription(
    "Update or repair the background service using this CLI version. Use `npx t3@latest service update` for the latest release.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
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
        yield* Console.log(formatServiceStatus(yield* service.status, packageJson.version));
      }),
    ),
  ),
);

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const { supported, installed, current } = status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return true;
  }
  if (
    installed &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, packageJson.version) > 0
  ) {
    yield* Console.log(
      `A newer t3@${status.installedVersion} background service is installed; leaving it unchanged.`,
    );
    // This CLI cannot verify that the newer unit is healthy, so keep the
    // manual `serve` fallback visible instead of claiming background readiness.
    return false;
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
  offer: Effect.Effect<
    boolean,
    BootService.BootServiceError | ServiceDowngradeRefusedError | Terminal.QuitError,
    R
  >,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceUpdatePendingError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      ServiceDowngradeRefusedError: (error) =>
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
