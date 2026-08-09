import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import { Command, GlobalFlag, Prompt } from "effect/unstable/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const bootServiceLayer = (config: ServerConfig.ServerConfig["Service"]) => {
  const input = {
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  };
  // Windows has no systemd, so it gets its own backend. Loading it lazily keeps
  // the Linux path free of any Windows import.
  return Layer.unwrap(
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform !== "win32") return BootService.layer(input);
      const windows = yield* Effect.promise(() => import("../cloud/bootServiceWindows.ts"));
      return windows.layer(input);
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
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
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, or Windows";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${cliVersion}` : "needs an update or repair"}`,
    `  ${status.kind === "systemd" ? "Unit" : "Shortcut"}: ${status.unitPath}`,
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

/** Windows only. The blink at sign-in looks alarming until you know what it is. */
const WINDOWS_SERVICE_NOTICE = [
  'A small window named "T3 Code Server" blinks once when you sign in. That is expected.',
  "It appears under Startup apps in Windows Settings, where you can switch it off.",
  "It starts at sign-in, not at boot, and it stops when you sign out.",
].join("\n");

/** Shared by install and update. The Linux output is unchanged. */
const reportReconcileResult = Effect.fn("cli.service.report")(function* (
  result: ServiceReconcileResult,
  unchangedMessage: string,
) {
  if (!result.changed) {
    yield* Console.log(unchangedMessage);
    return;
  }
  yield* Console.log(
    `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
  );
  if ((yield* HostProcessPlatform) === "win32") {
    yield* Console.log(WINDOWS_SERVICE_NOTICE);
  }
});

const serviceInstallCommand = Command.make("install", projectLocationFlags).pipe(
  Command.withDescription("Install T3 Code as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        yield* reportReconcileResult(
          result,
          `T3 Code service is already installed with t3@${packageJson.version}.`,
        );
      }),
    ),
  ),
);

const serviceUpdateCommand = Command.make("update", projectLocationFlags).pipe(
  Command.withDescription(
    "Update or repair the background service using this CLI version. Use `npx t3@latest service update` for the latest release.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService();
        yield* reportReconcileResult(
          result,
          `T3 Code service is already using t3@${packageJson.version}.`,
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
  const { supported, installed, current } = yield* service.status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return true;
  }
  // Windows starts the service at sign-in, not at boot, and it stops at
  // sign-out. Promising otherwise here would be a lie.
  const windows = (yield* HostProcessPlatform) === "win32";
  const wanted = yield* Prompt.run(
    Prompt.confirm({
      message: installed
        ? "The installed T3 Code service needs an update or repair. Update it now?"
        : windows
          ? "Run T3 Code in the background whenever you sign in to Windows? " +
            "It starts again after every reboot, and stops when you sign out."
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
    if (windows) yield* Console.log(WINDOWS_SERVICE_NOTICE);
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
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceUpdatePendingError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      // Both carry guidance the user has to act on, so print the message itself
      // rather than the generic "did not finish" wrapper.
      BootServicePathHasPercentError: (error) =>
        Console.warn(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceStartupEntryDisabledError: (error) =>
        Console.warn(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
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
