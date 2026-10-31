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
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  connectSubcommands,
  disconnectCloud,
  headlessFlag,
  linkEnvironmentForConnect,
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
  /** Null in builds without T3 Connect. */
  readonly connect: boolean | null;
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
  const connect = hasCloudPublicConfig
    ? (yield* CliState.readCliDesiredCloudLink) &&
      (yield* CliState.readCliDesiredLinkMode) === "managed"
    : null;
  return {
    service,
    connect,
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
  connect: {
    title: "T3 Connect",
    description: "Sign in with your T3 account on each device. Works from anywhere.",
  },
  lan: {
    title: "Local network",
    description:
      "Devices on your Wi-Fi, wired network, or tailnet connect directly. Anyone on them can reach the port, and a pairing code is the only lock.",
  },
} satisfies Record<Route, { readonly title: string; readonly description: string }>;

const formatSetup = (setup: Setup) => {
  const { service } = setup;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Background service",
      !service.supported
        ? "not available on this machine"
        : service.installed
          ? `installed · t3@${service.installedVersion ?? packageJson.version}`
          : "not installed",
    ],
    ...(setup.connect === null ? [] : [["T3 Connect", setup.connect ? "on" : "off"] as const]),
    [
      "Local network",
      setup.host !== undefined
        ? `decided by T3CODE_HOST=${setup.host} in service.env`
        : setup.lanFromOldDefault
          ? "on, the old default. Turn it off with `t3 up --no-lan`."
          : setup.lan
            ? "on"
            : "off",
    ],
  ];
  return rows.map(([label, value]) => `  ${label.padEnd(20)}${value}`).join("\n");
};

const formatNextSteps = (routes: Routes) =>
  [
    ...(routes.connect
      ? ["On your phone or another computer, sign in to T3 Connect with the same account."]
      : []),
    ...(routes.lan
      ? ["On a device on this network, add this machine with a code from `t3 pair`."]
      : []),
    ...(routes.connect || routes.lan
      ? []
      : ["No other device can reach this machine. Run `t3` to use T3 Code here."]),
    "Change this with `t3 up`. See it with `t3 status`.",
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
  const plan = planRoutes({ ...before, installed: before.service.installed }, flags);
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  if (plan.ask.length > 0 && interactive) {
    if (before.service.installed) yield* Console.log(`Current setup\n${formatSetup(before)}\n`);
    const picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "How can your other devices reach this machine?",
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
      userMessage: `Choose how your other devices reach this machine: ${
        before.connect === null ? "t3 up --lan" : "t3 up --connect, t3 up --lan, or both"
      }. --yes takes the default.`,
    });
  }
  // Nothing to run in the background, but a route left on still gets turned off.
  if (!before.service.installed && !routes.connect && !routes.lan) {
    if (current.connect) yield* disconnectCloud({ clearAuthorization: false });
    if (current.lan) yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: "false" });
    return yield* Console.log(formatNextSteps(routes));
  }
  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  // Asked before anything changes, so a declined restart leaves service.env
  // matching what the running service read when it started.
  const restart =
    before.service.installed && (before.service.current || newer) && needsRestart(current, routes);
  if (restart && interactive) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: "Restart T3 Code to apply this? Running agent turns stop.",
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  if (routes.connect && !current.connect) {
    yield* Console.log("T3 Connect");
    const linked = yield* linkEnvironmentForConnect({
      headless: flags.headless,
      installRelayClient: true,
    });
    if (linked === null) return;
    yield* Console.log(`✓ Signed in${linked.identity ? ` as ${linked.identity}` : ""}\n`);
  }
  if (!routes.connect && current.connect) {
    yield* disconnectCloud({ clearAuthorization: false });
  }
  yield* CliService.writeServiceEnv(baseDir, { T3CODE_LAN: String(routes.lan) });
  if (before.host !== undefined) {
    yield* Console.warn(
      `service.env sets T3CODE_HOST=${before.host}, which decides where T3 Code listens. Remove it to use the local network choice.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    const { command } = yield* resolveHostCliCommand("serve", [
      ...Option.match(flags.baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
      ...(routes.lan ? ["--lan"] : []),
    ]);
    yield* Console.log(`${reason} Run this and keep the terminal open:\n  ${command}\n`);
  });
  let started = false;
  if (!before.service.supported) {
    yield* printServeCommand("This machine cannot run T3 Code in the background.");
  } else {
    if (newer) {
      yield* Console.log(
        `A newer t3@${installedVersion} background service is installed, so it keeps that version.`,
      );
    }
    const result = newer
      ? ({ changed: false } as const)
      : yield* CliService.reconcileService().pipe(
          Effect.catchTags({
            BootServicePrerequisiteError: (error) => Effect.succeed({ failed: error.message }),
            BootServiceUnsupportedError: (error) => Effect.succeed({ failed: error.message }),
          }),
        );
    if ("failed" in result) {
      yield* printServeCommand(`Background setup did not finish: ${result.failed}`);
    } else if (result.changed) {
      yield* Console.log(CliService.formatServiceChange(result));
      started = true;
    } else if (restart) {
      const outcome = yield* service.restart;
      yield* Console.log(
        outcome === "queued"
          ? "Restart queued. This session runs inside the service and disconnects when it goes down."
          : "Restarted the T3 Code service.",
      );
      started = outcome === "restarted";
    }
  }
  if (started && routes.connect && !current.connect) yield* waitForReachability();

  yield* Console.log(
    `\nThis machine\n${formatSetup(yield* readSetup())}\n\n${formatNextSteps(routes)}`,
  );
});

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  connect: Flag.Boolean("connect").pipe(
    Flag.withDescription(
      "Reach this machine through T3 Connect, signed in with your T3 account. --no-connect turns it off.",
    ),
    Flag.optional,
  ),
  lan: Flag.Boolean("lan").pipe(
    Flag.withDescription(
      "Let devices on your local network and tailnet connect directly with a pairing code. --no-lan turns it off.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Ask nothing. A new machine gets T3 Connect; otherwise keep what is set."),
    Flag.withDefault(false),
  ),
  headless: headlessFlag,
}).pipe(
  Command.withDescription(
    "Set up this machine so your other devices can use it, through T3 Connect or your local network. Runs T3 Code in the background.",
  ),
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

export const statusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show how your other devices can reach this machine."),
  Command.withHandler(
    Effect.fn("cli.status")(function* (flags) {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      // Only what readSetup reads: no database, unlike the T3 Connect commands.
      const setup = yield* readSetup().pipe(
        Effect.provide(
          Layer.merge(CliService.layer(config), ServerSecretStore.layer).pipe(
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(`This machine\n${formatSetup(setup)}\n\nChange this with \`t3 up\`.`);
    }),
  ),
);
