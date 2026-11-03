import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, CLOUD_LINK_REVOKED } from "../cloud/config.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  connectSubcommands,
  disconnectCloud,
  headlessFlag,
  linkEnvironmentForConnect,
  requireConnectAllowed,
  runCloudCommand,
  waitForReachability,
} from "./connect.ts";
import { resolveHostCliCommand } from "./invocation.ts";
import * as CliService from "./service.ts";

type Route = "connect" | "lan";
type Routes = Readonly<Record<Route, boolean>>;

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  /** Null in builds without T3 Connect. Off when T3 Connect revoked the link. */
  readonly connect: boolean | null;
  /** T3 Connect revoked the link; `t3 connect` links again. */
  readonly connectRevoked: boolean;
  readonly lan: boolean;
  /** An installed service with no T3CODE_LAN keeps the old default: on. */
  readonly lanFromOldDefault: boolean;
  readonly host: string | undefined;
}

/**
 * T3 Connect is on when this CLI asked for a managed link, or when the desktop or
 * web app made one: that saves the tunnel config but no CLI marker. Revoked is off.
 */
export const connectEnabled = (link: {
  readonly cliDesired: boolean;
  readonly cliMode: CliState.CliDesiredLinkMode;
  readonly managedTunnel: boolean;
  readonly revoked: boolean;
}) =>
  // The server starts no tunnel for a CLI publish-only link, even with an old tunnel config.
  !link.revoked && (link.cliDesired ? link.cliMode === "managed" : link.managedTunnel);

const readSetup = Effect.fn("cli.up.read_setup")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
  // Parsed as the server parses it.
  const lan = yield* Config.Boolean("T3CODE_LAN")
    .pipe(Config.option)
    .parse(ConfigProvider.fromEnv({ env: entries }));
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connectRevoked =
    hasCloudPublicConfig && Option.isSome(yield* secrets.get(CLOUD_LINK_REVOKED));
  const connect = hasCloudPublicConfig
    ? connectEnabled({
        cliDesired: yield* CliState.readCliDesiredCloudLink,
        cliMode: yield* CliState.readCliDesiredLinkMode,
        managedTunnel: Option.isSome(yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)),
        revoked: connectRevoked,
      })
    : null;
  return {
    service,
    connect,
    connectRevoked,
    lan: Option.getOrElse(lan, () => service.installed),
    lanFromOldDefault: Option.isNone(lan) && service.installed,
    host: entries.T3CODE_HOST,
  } satisfies Setup;
});

/**
 * The routes `t3 up` starts from. With no route flag it asks about every
 * route, starting a machine with no service from T3 Connect. Any route flag
 * means it asks nothing and keeps the routes not named as they are.
 */
export const planRoutes = (
  setup: { readonly installed: boolean; readonly connect: boolean | null; readonly lan: boolean },
  flags: { readonly connect: Option.Option<boolean>; readonly lan: Option.Option<boolean> },
) => {
  const ask = Option.isNone(flags.connect) && Option.isNone(flags.lan);
  const start = {
    connect: setup.connect === true || (ask && !setup.installed && setup.connect !== null),
    lan: setup.lan,
  };
  return {
    routes: {
      connect: Option.getOrElse(flags.connect, () => start.connect),
      lan: Option.getOrElse(flags.lan, () => start.lan),
    } satisfies Routes,
    ask: ask
      ? (["connect", "lan"] as const).filter((r) => r !== "connect" || setup.connect !== null)
      : [],
  };
};

/** A running service reads T3CODE_LAN and its T3 Connect link only when it starts. */
const needsRestart = (before: Routes, after: Routes) =>
  after.lan !== before.lan || (after.connect && !before.connect);

const CHOICES = {
  connect: { title: "T3 Connect", description: "Creates a tunnel to control your PC." },
  lan: { title: "Local network", description: "LAN and tailnet. Pairing code required." },
} satisfies Record<Route, { readonly title: string; readonly description: string }>;

const formatSetup = (setup: Setup) => {
  const { service } = setup;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Service",
      !service.supported
        ? "unavailable"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    ...(setup.connect === null
      ? []
      : [
          [
            "T3 Connect",
            setup.connect
              ? "on · your T3 account"
              : setup.connectRevoked
                ? "off · link revoked. Run `t3 connect`."
                : "off",
          ] as const,
        ]),
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

const formatNextSteps = (routes: Routes, serviceInstalled: boolean) =>
  [
    ...(routes.connect
      ? ["On your other device, sign in to T3 Connect with the same account."]
      : []),
    ...(routes.lan ? ["Run `t3 pair`. Use the code on your other device."] : []),
    ...(routes.connect || routes.lan
      ? []
      : [
          serviceInstalled
            ? "Remote access is off. T3 Code still runs here in the background."
            : "Remote access is off. Run `t3` to use T3 Code here.",
        ]),
  ].join("\n");

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const setUp = Effect.fn("cli.up")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly connect: Option.Option<boolean>;
  readonly lan: Option.Option<boolean>;
  readonly yes: boolean;
  readonly headless: boolean;
}) {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const before = yield* readSetup();
  if (before.connect === null && Option.getOrElse(flags.connect, () => false)) {
    return yield* new CliError.UserError({
      cause: "connect",
      userMessage: "T3 Connect is unavailable in this build.",
    });
  }

  const current = { connect: before.connect === true, lan: before.lan };
  // A publish-only link is not "on", but a rollback must put it back.
  const priorPublishOnly =
    hasCloudPublicConfig &&
    (yield* CliState.readCliDesiredCloudLink) &&
    (yield* CliState.readCliDesiredLinkMode) === "publish_only";
  const plan = planRoutes({ ...before, installed: before.service.installed }, flags);
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  if (plan.ask.length > 0 && interactive) {
    if (before.service.installed) yield* Console.log(`Current setup\n${formatSetup(before)}\n`);
    const picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Allow connections through:",
        selectAll: "Select all",
        selectNone: "Clear all",
        inverseSelection: "Invert selection",
        choices: plan.ask.map((route) => ({
          ...CHOICES[route],
          value: route,
          selected: plan.routes[route],
        })),
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (picked === null) return yield* Console.log("Nothing changed.");
    routes = { connect: picked.includes("connect"), lan: picked.includes("lan") };
  } else if (plan.ask.length > 0 && !flags.yes && !before.service.installed) {
    return yield* new CliError.UserError({
      cause: "routes",
      userMessage: `No terminal. Choose access with ${
        before.connect === null ? "--lan" : "--connect or --lan"
      }, or use --yes for the default. See \`t3 up --help\`.`,
    });
  }
  if (routes.connect && !current.connect) yield* requireConnectAllowed;
  if (routes.lan && !current.lan) {
    const policy = yield* ManagedPolicy.ManagedPolicy;
    if (!ManagedLimits.allowsRemoteClients(policy)) {
      return yield* ManagedLimits.refuseRemoteClients(policy);
    }
  }
  // Nothing to run in the background, but a route left on still gets turned off.
  if (!before.service.installed && !routes.connect && !routes.lan) {
    if (current.connect || before.connectRevoked) {
      yield* disconnectCloud({ clearAuthorization: false });
    }
    if (current.lan) yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: "false" });
    return yield* Console.log(formatNextSteps(routes, false));
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
    (needsRestart(current, routes) || stopped);
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

  if (routes.connect && !current.connect) {
    const linked = yield* linkEnvironmentForConnect({
      headless: flags.headless,
      installRelayClient: true,
    });
    if (linked === null) return;
    yield* Console.log(
      `✓ Signed in to T3 Connect${linked.identity ? ` as ${linked.identity}` : ""}`,
    );
  }
  // A running server unlinks live; when that fails, only a restart stops its tunnel.
  const unlinkFailed =
    !routes.connect && (current.connect || before.connectRevoked)
      ? (yield* disconnectCloud({ clearAuthorization: false })).status === "failed"
      : false;
  const previousLan = (yield* CliService.readServiceEnv(baseDir)).entries.T3CODE_LAN;
  // Also with no service manager: the file records the choice that `t3 status` shows.
  yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: String(routes.lan) });
  // When the service step fails, an installed service still runs with the old
  // value, so the file goes back to match it.
  // A new T3 Connect link is undone too, with any tunnel the failed start saved, so a
  // rerun sees it as a change and restarts. The sign-in stays.
  const restoreServiceEnv = before.service.installed
    ? CliService.writeServiceEnv(baseDir, { T3CODE_LAN: previousLan }).pipe(
        Effect.andThen(
          !routes.connect || current.connect
            ? Effect.void
            : priorPublishOnly
              ? CliState.setCliDesiredCloudLink(true, "publish_only")
              : disconnectCloud({ clearAuthorization: false }).pipe(Effect.asVoid),
        ),
      )
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
      ...Option.match(flags.baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
      // Explicit either way, so a T3CODE_LAN in the shell cannot override the choice.
      routes.lan ? "--lan" : "--no-lan",
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
  let started = false;
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
      yield* Console.log(
        `Service setup failed: ${result.failed} Fix that, then run \`t3 up\` again.`,
      );
    } else if ("failed" in result) {
      yield* printServeCommand(`Service setup failed: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
      started = true;
    } else if (restart || (unlinkFailed && before.service.installed)) {
      const confirmed =
        restart ||
        !interactive ||
        (yield* Prompt.run(
          Prompt.Confirm({
            message:
              "The running service still has T3 Connect on. Restart it? Running agent turns will stop.",
            initial: true,
          }),
        ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) })));
      if (!confirmed) {
        yield* Console.log("Run `t3 service restart` to turn T3 Connect off.");
      } else {
        if (!interactive && !stopped) {
          yield* Console.log("Restarting T3 Code. Running agent turns will stop.");
        }
        const outcome = yield* service.restart.pipe(Effect.tapError(() => rollBack));
        if (outcome === "queued") {
          yield* Console.log("Restart queued. This session will disconnect.");
        }
        if (outcome === "skipped") {
          yield* Console.log(
            "The installed service runs another T3 home, so it was not restarted. Pass its --base-dir.",
          );
        }
        started = outcome === "restarted";
      }
    }
  }
  if (started && routes.connect && !current.connect) yield* waitForReachability();

  const after = yield* readSetup();
  yield* Console.log(
    // From what took effect: a failed service step can undo a choice.
    `\nThis machine\n${formatSetup(after)}\n\n${formatNextSteps(
      { connect: after.connect === true, lan: after.lan },
      after.service.installed,
    )}`,
  );
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  connect: Flag.Boolean("connect").pipe(
    Flag.withDescription(
      "Allow access through T3 Connect with your T3 account. Turn off with --no-connect.",
    ),
    Flag.optional,
  ),
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Allow LAN and tailnet connections. Anyone there can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the access settings; a new machine gets T3 Connect. A restart stops running agent turns.",
    ),
    Flag.withDefault(false),
  ),
  headless: headlessFlag,
}).pipe(
  Command.withShortDescription("Set up remote access and the T3 Code background service."),
  Command.withDescription(
    "Set up remote access and the T3 Code background service. Access flags skip the question, and routes not named keep their settings. Without a terminal, a needed restart runs without asking and stops running agent turns.",
  ),
  Command.withExamples([
    { command: "t3 up", description: "Choose remote access." },
    { command: "t3 up --connect", description: "Turn on T3 Connect. Keep other settings." },
    { command: "t3 up --lan", description: "Allow LAN access with pairing codes." },
    { command: "t3 up --no-lan", description: "Stop LAN access." },
    { command: "t3 up --yes", description: "Take the defaults with no questions." },
    { command: "t3 status --json", description: "Read the settings from a script." },
  ]),
  Command.withHandler((flags) => runCloudCommand(flags, setUp(flags), { quietLogs: true })),
);

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Set up T3 Connect for this machine. Same as `t3 up --connect`."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      setUp({ ...flags, connect: Option.some(true), lan: Option.none(), yes: false }),
      { quietLogs: true },
    ),
  ),
  Command.withSubcommands(connectSubcommands),
);

/** `t3 status --json`, for scripts and agents. */
const setupJson = (setup: Setup) =>
  JSON.stringify(
    {
      service: {
        supported: setup.service.supported,
        installed: setup.service.installed,
        installedVersion: setup.service.installedVersion ?? null,
      },
      connect:
        setup.connect === null ? null : { enabled: setup.connect, revoked: setup.connectRevoked },
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
      // Only what readSetup reads: no database, unlike the T3 Connect commands.
      const setup = yield* readSetup().pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ServerSecretStore.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(
        flags.json
          ? setupJson(setup)
          : `This machine\n${formatSetup(setup)}\n\nChange access: \`t3 up\`.`,
      );
    }),
  ),
);
