import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../service/bootService.ts";
import { compareExactServiceVersions } from "../service/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import * as CliService from "./service.ts";

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  readonly lan: boolean;
  /** An installed service with no T3CODE_LAN keeps the old default: on. */
  readonly lanFromOldDefault: boolean;
  readonly host: string | undefined;
}

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  // Parsed as the server parses it.
  const lan = yield* Config.Boolean("T3CODE_LAN")
    .pipe(Config.option)
    .parse(ConfigProvider.fromEnv({ env: entries }));
  // Another home's service doesn't read this home's service.env.
  const servesThisHome = service.installed && service.otherBaseDir === undefined;
  return {
    service,
    lan: Option.getOrElse(lan, () => servesThisHome),
    lanFromOldDefault: Option.isNone(lan) && servesThisHome,
    host: entries.T3CODE_HOST,
  } satisfies Setup;
});

/** Local network access after `t3 up`: the flag when given, otherwise as it is now and asked. */
const planLan = (
  setup: { readonly lan: boolean },
  flags: { readonly lan: Option.Option<boolean> },
) => ({
  lan: Option.getOrElse(flags.lan, () => setup.lan),
  ask: Option.isNone(flags.lan),
});

const formatSetup = (setup: Setup) => {
  const { service } = setup;
  // This home's access settings reach no service, so only the service is shown.
  if (service.otherBaseDir !== undefined) {
    return [
      `  ${"Service".padEnd(15)}installed for another T3 home · ${service.otherBaseDir}`,
      "",
      `Pass \`${BootService.formatBootServiceBaseDirOption(service.otherBaseDir)}\` to manage it.`,
    ].join("\n");
  }
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Service",
      !service.supported
        ? "unavailable"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    [
      "Local network",
      setup.host !== undefined
        ? `overridden · T3CODE_HOST=${setup.host}`
        : setup.lanFromOldDefault
          ? "on · kept from an older install"
          : setup.lan
            ? "on · pairing code only"
            : "off",
    ],
  ];
  const notes = [
    ...(setup.host === undefined && setup.lan
      ? ["Anyone on your LAN or tailnet can reach the port. A pairing code is the only lock."]
      : []),
    ...(setup.lanFromOldDefault
      ? ["Older installs keep LAN access on. Turn it off: `t3 up --no-lan`."]
      : []),
  ];
  return [
    ...rows.map(([label, value]) => `  ${label.padEnd(15)}${value}`),
    ...(notes.length === 0 ? [] : ["", ...notes]),
  ].join("\n");
};

const formatNextSteps = (lan: boolean, serviceInstalled: boolean, pairCommand: string) =>
  lan
    ? `Run \`${pairCommand}\`. Use the code on your other device.`
    : serviceInstalled
      ? "Remote access is off. T3 Code still runs here in the background."
      : "Remote access is off. Run `t3` to use T3 Code here.";

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const setUp = Effect.fn("cli.up")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly lan: Option.Option<boolean>;
  readonly yes: boolean;
}) {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const baseDirArgs = Option.match(flags.baseDir, {
    onNone: () => [],
    onSome: (dir) => ["--base-dir", dir],
  });
  const { command: pairCommand } = yield* resolveHostCliCommand("pair", baseDirArgs);
  const before = yield* readSetup();
  // Before any question or write: install would refuse only after both.
  if (before.service.otherBaseDir !== undefined) {
    return yield* new BootService.BootServiceOtherBaseDirError({
      installedBaseDir: before.service.otherBaseDir,
      baseDir,
    });
  }
  const plan = planLan(before, flags);
  const interactive = !flags.yes && interactiveTerminal();
  let lan = plan.lan;
  if (plan.ask && interactive) {
    if (before.service.installed) yield* Console.log(`Current setup\n${formatSetup(before)}\n`);
    const picked = yield* Prompt.run(
      Prompt.Confirm({
        message: "Allow LAN and tailnet connections? A pairing code is the only lock.",
        initial: plan.lan,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (picked === null) return yield* Console.log("Nothing changed.");
    lan = picked;
  } else if (plan.ask && !flags.yes && !before.service.installed) {
    return yield* new CliError.UserError({
      cause: "routes",
      userMessage:
        "No terminal. Choose access with --lan or --no-lan, or use --yes for the default. See `t3 up --help`.",
    });
  }
  if (lan && !before.lan) {
    const policy = yield* ManagedPolicy.ManagedPolicy;
    if (!ManagedLimits.allowsRemoteClients(policy)) {
      return yield* ManagedLimits.refuseRemoteClients(policy);
    }
  }
  // Nothing to run in the background, but local network access left on still gets turned off.
  if (!before.service.installed && !lan) {
    if (before.lan) yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: "false" });
    return yield* Console.log(formatNextSteps(false, false, pairCommand));
  }
  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  // Asked before anything changes, so a declined restart leaves service.env
  // matching what the running service read when it started.
  // A stopped service of this version is not current, so reconcile starts it;
  // a newer one is left alone and needs this restart to start.
  const stopped = before.service.problems?.includes("service-stopped") === true;
  const restart =
    before.service.installed &&
    (before.service.current || newer) &&
    (lan !== before.lan || stopped);
  // An older or broken service is reinstalled, which restarts it too.
  const update = before.service.installed && !before.service.current && !newer && !stopped;
  if ((restart || update) && interactive && !stopped) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: update
          ? "Update and restart T3 Code? Running agent turns will stop."
          : "Apply changes and restart? Running agent turns will stop.",
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  const previousLan = (yield* CliService.readServiceEnv(baseDir)).entries.T3CODE_LAN;
  // Also with no service manager: the file records the choice that `t3 status` shows.
  yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: String(lan) });
  // When the service step fails, an installed service still runs with the old
  // value, so the file goes back to match it.
  const restoreServiceEnv = before.service.installed
    ? CliService.writeServiceEnv(baseDir, { T3CODE_LAN: previousLan })
    : Effect.void;
  // A failed update or restart may still have started the service with the new
  // settings, so restart it once more on the old ones.
  const rollBack = before.service.installed
    ? restoreServiceEnv.pipe(Effect.andThen(service.restart.pipe(Effect.ignore)))
    : Effect.void;
  if (before.host !== undefined) {
    yield* Console.warn(
      `T3CODE_HOST=${before.host} in service.env overrides the network choice. Remove it to apply it.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    const { command } = yield* resolveHostCliCommand("serve", [
      ...baseDirArgs,
      // Explicit either way, so a T3CODE_LAN in the shell cannot override the choice.
      lan ? "--lan" : "--no-lan",
    ]);
    yield* Console.log(`${reason} Keep this command running:\n  ${command}`);
    // A host wins over --lan and --no-lan, as it does in service.env.
    const shellHost = (yield* HostProcess.Environment).T3CODE_HOST;
    if (shellHost !== undefined) {
      yield* Console.warn(
        `T3CODE_HOST=${shellHost} in this shell overrides that choice. Unset it before you run the command.`,
      );
    }
  });
  if (!before.service.supported) {
    yield* printServeCommand("Background service unavailable.");
  } else {
    if (newer) {
      yield* Console.log(`Keeping installed service version t3@${installedVersion}.`);
    }
    if (update && !interactive) {
      yield* Console.log("Updating T3 Code. Running agent turns will stop.");
    }
    const result = newer
      ? ({ changed: false } as const)
      : yield* CliService.reconcileService().pipe(
          Effect.catchTags({
            BootServicePrerequisiteError: (error) => Effect.succeed({ failed: error.message }),
            BootServiceUnsupportedError: (error) => Effect.succeed({ failed: error.message }),
          }),
          Effect.tapError(() => rollBack),
        );
    if ("failed" in result && before.service.installed) {
      // The old service still runs, so a foreground server would clash with it.
      yield* restoreServiceEnv;
      const { command } = yield* resolveHostCliCommand("up", baseDirArgs);
      yield* Console.log(
        `Service setup failed: ${result.failed} Fix that, then run \`${command}\` again.`,
      );
    } else if ("failed" in result) {
      yield* printServeCommand(`Service setup failed: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
    } else if (restart) {
      if (!interactive && !stopped) {
        yield* Console.log("Restarting T3 Code. Running agent turns will stop.");
      }
      const outcome = yield* service.restart.pipe(Effect.tapError(() => rollBack));
      if (outcome === "queued") {
        yield* Console.log("Restart queued. This session will disconnect.");
      }
      if (outcome === "skipped") {
        yield* Console.log(
          "The installed service was not restarted. Run `t3 service status` to see why.",
        );
      }
    }
  }

  const after = yield* readSetup();
  yield* Console.log(
    // From what took effect: a failed service step can undo a choice.
    `\nThis machine\n${formatSetup(after)}\n\n${formatNextSteps(
      after.lan,
      after.service.installed,
      pairCommand,
    )}`,
  );
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Allow LAN and tailnet connections. Anyone there can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the access settings. A restart stops running agent turns.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withShortDescription("Set up remote access and the T3 Code background service."),
  Command.withDescription(
    "Set up remote access and the T3 Code background service. An access flag skips the question. Without a terminal, a needed restart runs without asking and stops running agent turns.",
  ),
  Command.withExamples([
    { command: "t3 up", description: "Choose remote access." },
    { command: "t3 up --lan", description: "Allow LAN access with pairing codes." },
    { command: "t3 up --no-lan", description: "Stop LAN access." },
    { command: "t3 up --yes", description: "Take the defaults with no questions." },
    { command: "t3 status --json", description: "Read the settings from a script." },
  ]),
  Command.withHandler(
    Effect.fn("cli.up.run")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      yield* setUp(flags).pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ManagedPolicy.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      );
    }),
  ),
);

/** `t3 status --json`, for scripts and agents. */
const setupJson = (setup: Setup) =>
  JSON.stringify(
    {
      service: {
        supported: setup.service.supported,
        installed: setup.service.installed,
        installedVersion: setup.service.installedVersion ?? null,
        otherBaseDir: setup.service.otherBaseDir ?? null,
      },
      lan: {
        enabled: setup.lan,
        inheritedDefault: setup.lanFromOldDefault,
        hostOverride: setup.host ?? null,
      },
    },
    null,
    2,
  );

export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the settings as JSON. Does not test connections."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show service setup and remote access settings."),
  Command.withExamples([
    { command: "t3 status", description: "Show the settings." },
    { command: "t3 status --json", description: "Print them for scripts and agents." },
  ]),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: flags.json,
      });
      const setup = yield* readSetup().pipe(
        Effect.provide(
          CliService.layer(config).pipe(Layer.provideMerge(ServerConfig.layer(config))),
        ),
      );
      yield* Console.log(
        flags.json
          ? setupJson(setup)
          : setup.service.otherBaseDir !== undefined
            ? `This machine\n${formatSetup(setup)}`
            : `This machine\n${formatSetup(setup)}\n\nChange access: \`t3 up\`.`,
      );
    }),
  ),
);
