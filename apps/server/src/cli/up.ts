import { TAILNET_APP_CAPABILITY, tailnetGrantSnippet } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import {
  isTailscaleIpv4Address,
  readTailscaleStatus,
  readTailscaleWhois,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { REQUIRE_GRANT_FILE } from "../auth/TailnetSignIn.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, CLOUD_LINK_REVOKED } from "../cloud/config.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { renderTerminalQrCode } from "../startupAccess.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as TailscaleServe from "../tailscaleServe.ts";
import {
  isSupportedTailscaleVersion,
  MINIMUM_TAILSCALE_VERSION,
} from "../tailscale/TailscaleHost.ts";
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
import { turnOnRequireGrant } from "./tailscale.ts";

type Route = "tailscale" | "connect" | "lan";
type Routes = Readonly<Record<Route, boolean>>;
type RouteFlags = Readonly<Record<Route, Option.Option<boolean>>>;

const upError = (reason: string) => new CliError.UserError({ cause: reason, userMessage: reason });

// The values the server's Config.Boolean accepts.
const parseBoolean = (value: string | undefined) =>
  value === undefined
    ? undefined
    : ["true", "yes", "on", "1", "y"].includes(value)
      ? true
      : ["false", "no", "off", "0", "n"].includes(value)
        ? false
        : undefined;

/** What a running service read from `service.env` when it started. */
const serviceSettings = (entries: Readonly<Record<string, string>>, installed: boolean) => ({
  // An installed service with no T3CODE_LAN keeps the old default: on.
  lan: parseBoolean(entries.T3CODE_LAN) ?? installed,
  tailscale: parseBoolean(entries.T3CODE_TAILSCALE_SIGN_IN) ?? false,
  owner: entries.T3CODE_TAILSCALE_OWNER ?? null,
  port: entries.T3CODE_PORT ?? String(ServerConfig.DEFAULT_PORT),
  tailscaleServe: parseBoolean(entries.T3CODE_TAILSCALE_SERVE) ?? false,
});

type ServiceSettings = ReturnType<typeof serviceSettings>;

const sameSettings = (a: ServiceSettings, b: ServiceSettings) =>
  a.lan === b.lan &&
  a.tailscale === b.tailscale &&
  a.owner === b.owner &&
  a.port === b.port &&
  a.tailscaleServe === b.tailscaleServe;

/** How other devices reach this machine now. */
interface Setup {
  readonly service: BootService.BootServiceStatus;
  /** Null in builds without T3 Connect. Off when T3 Connect revoked the link. */
  readonly connect: boolean | null;
  /** T3 Connect revoked the link; `t3 connect` links again. */
  readonly connectRevoked: boolean;
  readonly entries: Readonly<Record<string, string>>;
  readonly settings: ServiceSettings;
  readonly lanFromOldDefault: boolean;
  readonly requireGrant: boolean;
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
  const { baseDir, stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* (yield* BootService.BootService).status;
  const { entries } = yield* CliService.readServiceEnv(baseDir);
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
    entries,
    settings: serviceSettings(entries, service.installed),
    lanFromOldDefault: entries.T3CODE_LAN === undefined && service.installed,
    requireGrant: yield* fs.exists(path.join(stateDir, REQUIRE_GRANT_FILE)),
    host: entries.T3CODE_HOST,
  } satisfies Setup;
});

/**
 * The routes `t3 up` starts from. With no route flag it asks about every
 * route it can offer, starting a machine with no service from Tailscale when
 * it runs here, else T3 Connect. Any route flag means it asks nothing and
 * keeps the routes not named as they are.
 */
export const planRoutes = (
  setup: {
    readonly installed: boolean;
    readonly current: Routes;
    /** False where this machine cannot offer the route. */
    readonly available: Readonly<Record<"tailscale" | "connect", boolean>>;
  },
  flags: RouteFlags & {
    /** Another setup flag was given, such as `--no-tailscale-serve`: nothing is asked. */
    readonly other?: boolean;
  },
) => {
  const ask = [flags.tailscale, flags.connect, flags.lan].every(Option.isNone) && !flags.other;
  const start: Routes =
    ask && !setup.installed
      ? {
          tailscale: setup.available.tailscale,
          connect: setup.available.connect && !setup.available.tailscale,
          lan: false,
        }
      : setup.current;
  return {
    routes: {
      tailscale: Option.getOrElse(flags.tailscale, () => start.tailscale),
      connect: Option.getOrElse(flags.connect, () => start.connect),
      lan: Option.getOrElse(flags.lan, () => start.lan),
    } satisfies Routes,
    ask: ask
      ? (["tailscale", "connect", "lan"] as const).filter(
          // A route that is on can always be turned off.
          (route) => route === "lan" || setup.available[route] || setup.current[route],
        )
      : [],
  };
};

const CHOICES = {
  tailscale: {
    title: "Tailscale",
    description: "Devices your policy grants, else your untagged devices. No pairing code.",
  },
  connect: { title: "T3 Connect", description: "Creates a tunnel to control your PC." },
  lan: { title: "Local network", description: "LAN and tailnet. Pairing code required." },
} satisfies Record<Route, { readonly title: string; readonly description: string }>;

const formatSetup = (setup: Setup) => {
  const { service, settings } = setup;
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
      "Tailscale",
      !settings.tailscale
        ? "off"
        : setup.requireGrant
          ? "on · policy grants required"
          : "on · policy grants, else your untagged devices",
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
          : settings.lan
            ? "on · pairing code only"
            : "off",
    ],
  ];
  const notes = [
    ...(setup.host === undefined && settings.lan
      ? [
          "Anyone on your LAN or tailnet can reach the port. A pairing code is the only lock.",
          "Turn it off: `t3 up --no-lan`.",
        ]
      : []),
    ...(settings.tailscale && setup.requireGrant
      ? ["No device can sign in through Tailscale until your tailnet policy grants it."]
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
    ...(routes.connect || routes.lan || routes.tailscale
      ? []
      : [
          serviceInstalled
            ? "Remote access is off. T3 Code still runs here in the background."
            : "Remote access is off. Run `t3` to use T3 Code here.",
        ]),
  ].join("\n");

// Serve only runs with Tailscale on in `t3 up`, so turning Tailscale off stops it too.
// Written as false, not removed, so a value the service inherits cannot turn them back on.
const TAILSCALE_OFF = { T3CODE_TAILSCALE_SIGN_IN: "false", T3CODE_TAILSCALE_SERVE: "false" };

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

interface Owner {
  readonly userId: string;
  readonly login: string | null;
}

const loginOf = (status: TailscaleStatus, userId: string | null) =>
  status.users.find((user) => user.userId === userId)?.loginName ?? null;

const ownerForLogin = (status: TailscaleStatus, login: string) => {
  const wanted = login.trim().toLowerCase();
  const user = status.users.find((candidate) => candidate.loginName?.toLowerCase() === wanted);
  return user === undefined
    ? Effect.fail(
        upError(
          `No Tailscale user with the login ${login.trim()} is visible from this host. Check the spelling, or sign in to Tailscale on one of that user's devices first.`,
        ),
      )
    : Effect.succeed({ userId: user.userId, login: user.loginName } satisfies Owner);
};

/** The SSH client's user, when it connects over the tailnet from one of its own devices. */
const proposeSshOwner = Effect.fn("cli.up.proposeSshOwner")(function* () {
  const env = yield* HostProcess.Environment;
  const clientAddress = env.SSH_CONNECTION?.trim().split(/\s+/u)[0];
  if (clientAddress === undefined || !isTailscaleIpv4Address(clientAddress)) {
    return Option.none<Owner>();
  }
  const node = yield* readTailscaleWhois(clientAddress).pipe(Effect.option);
  return Option.filter(
    node,
    (value) => value.tags.length === 0 && value.sharerUserId === null,
  ).pipe(Option.map((value): Owner => ({ userId: value.userId, login: value.loginName })));
});

export const resolveOwner = Effect.fn("cli.up.resolveOwner")(function* (
  status: TailscaleStatus,
  ownerLogin: Option.Option<string>,
  /** The owner a previous `t3 up` saved, kept unless `--owner` names another. */
  savedUserId: string | undefined,
  /** False with `--yes` or no terminal: fail with the flag to pass instead. */
  interactive: boolean,
) {
  if (status.selfTags.length === 0) {
    if (status.selfUserId === null) {
      return yield* upError("Tailscale did not report this host's user.");
    }
    const own: Owner = { userId: status.selfUserId, login: loginOf(status, status.selfUserId) };
    if (Option.isSome(ownerLogin)) {
      const requested = yield* ownerForLogin(status, ownerLogin.value);
      if (requested.userId !== own.userId) {
        return yield* upError(
          `This host is not tagged, so its owner is its own Tailscale user (${own.login ?? own.userId}). Drop --owner, or tag the host first.`,
        );
      }
    }
    return own;
  }
  if (Option.isSome(ownerLogin)) return yield* ownerForLogin(status, ownerLogin.value);
  if (savedUserId !== undefined)
    return { userId: savedUserId, login: loginOf(status, savedUserId) };
  if (!interactive) {
    return yield* upError(
      "This machine is tagged. Set its Tailscale owner with `--owner <login>`, or use `--require-grant`.",
    );
  }
  const proposed = yield* proposeSshOwner();
  if (Option.isSome(proposed)) {
    const accepted = yield* Prompt.run(
      Prompt.Confirm({
        message: `Use ${proposed.value.login ?? proposed.value.userId} as this machine's Tailscale owner?`,
        initial: true,
      }),
    );
    if (accepted) return proposed.value;
  }
  const login = yield* Prompt.run(Prompt.String({ message: "Tailscale owner login:" }));
  return yield* ownerForLogin(status, login);
});

/** Tailscale's state here, or why Tailscale sign-in cannot work on this machine. */
const checkTailscale = Effect.fn("cli.up.checkTailscale")(function* () {
  const status = yield* readTailscaleStatus("active").pipe(Effect.option);
  if (Option.isNone(status)) {
    return {
      ok: false,
      reason: "Tailscale did not answer. Install it and run `sudo tailscale up`.",
    } as const;
  }
  const { value } = status;
  if (value.backendState !== "Running") {
    return {
      ok: false,
      reason: `Tailscale is ${value.backendState ?? "not running"}. Run \`sudo tailscale up\`.`,
    } as const;
  }
  if (value.userspaceNetworking === true) {
    return {
      ok: false,
      reason:
        "Tailscale sign-in needs device addresses, and userspace networking hides them. Give the container /dev/net/tun and run tailscaled without --tun=userspace-networking.",
    } as const;
  }
  if (!isSupportedTailscaleVersion(value.version)) {
    return {
      ok: false,
      reason: `Tailscale ${value.version ?? "(unknown version)"} is too old for Tailscale sign-in. Update to ${MINIMUM_TAILSCALE_VERSION} or newer.`,
    } as const;
  }
  const address = value.tailnetIpv4Addresses[0];
  if (address === undefined) {
    return { ok: false, reason: "Tailscale reported no IPv4 address for this host." } as const;
  }
  return { ok: true, status: value, address } as const;
});

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/**
 * Discovery probes only the default port, so `t3 up` pins it rather than let
 * the server fall back to the next free one. A port the user set is kept.
 */
export const upPortCheck = (input: {
  readonly configuredPort: string | undefined;
  /** Whether the port the service will use, configured or default, is free. */
  readonly portFree: boolean;
  /** The live server this T3 home already runs, if any. */
  readonly running: { readonly port: number; readonly serviceManaged: boolean } | null;
}): "ok" | "taken" | "custom" | "manual" => {
  // The service cannot take this home over from a server started by hand.
  if (input.running !== null && !input.running.serviceManaged) return "manual";
  const port =
    input.configuredPort === undefined ? ServerConfig.DEFAULT_PORT : Number(input.configuredPort);
  if (!input.portFree && input.running?.port !== port) return "taken";
  return port === ServerConfig.DEFAULT_PORT ? "ok" : "custom";
};

/** The `service.env` entries Tailscale sign-in needs, after checking the port and owner. */
const tailscaleEntries = Effect.fn("cli.up.tailscale_entries")(function* (
  tailscale: { readonly status: TailscaleStatus },
  flags: {
    readonly owner: Option.Option<string>;
    readonly tailscaleServe: Option.Option<boolean>;
    readonly yes: boolean;
  },
  requireGrant: boolean,
) {
  const config = yield* ServerConfig.ServerConfig;
  const { entries, path: serviceEnvPath } = yield* CliService.readServiceEnv(config.baseDir);
  const tagged = tailscale.status.selfTags.length > 0;
  // With grants required, the policy names who gets in, so the box needs no owner.
  // A requested owner is saved even when grants decide who gets in.
  const owner =
    requireGrant && Option.isNone(flags.owner)
      ? null
      : yield* resolveOwner(
          tailscale.status,
          flags.owner,
          entries.T3CODE_TAILSCALE_OWNER,
          !flags.yes && interactiveTerminal(),
        );
  const configuredPort = entries.T3CODE_PORT;
  const port = Number(configuredPort ?? ServerConfig.DEFAULT_PORT);
  const net = yield* NetService.NetService;
  const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  const running = Option.filter(runtime, (state) => isProcessAlive(state.pid));
  const portCheck = upPortCheck({
    configuredPort,
    portFree: yield* net.canListenOnHost(port, "0.0.0.0"),
    running: Option.match(running, {
      onNone: () => null,
      onSome: (state) => ({ port: state.port, serviceManaged: state.serviceManaged === true }),
    }),
  });
  if (portCheck === "manual") {
    return yield* upError(
      `T3 Code is already running outside the service for ${config.baseDir}. Stop it, then run \`t3 up\`.`,
    );
  }
  if (portCheck === "taken") {
    return yield* upError(
      `Port ${port} is in use. Free it, or set T3CODE_PORT in ${serviceEnvPath} and add this machine by name and port.`,
    );
  }
  if (portCheck === "custom") {
    yield* Console.warn(
      `Custom port ${configuredPort} from ${serviceEnvPath}. Other devices find machines only on port ${ServerConfig.DEFAULT_PORT}, so add this one by name and port.`,
    );
  }
  const saved = entries.T3CODE_TAILSCALE_OWNER;
  return {
    // A saved owner still names the box in the printed grant when grants are required.
    owner:
      owner ??
      (saved === undefined || !tagged
        ? null
        : { userId: saved, login: loginOf(tailscale.status, saved) }),
    port,
    entries: {
      T3CODE_TAILSCALE_SIGN_IN: "true",
      T3CODE_PORT: configuredPort ?? String(ServerConfig.DEFAULT_PORT),
      // The user ID, never the login: logins can be renamed.
      ...(owner === null ? {} : { T3CODE_TAILSCALE_OWNER: tagged ? owner.userId : undefined }),
      ...Option.match(flags.tailscaleServe, {
        onNone: () => ({}),
        onSome: (on) => ({ T3CODE_TAILSCALE_SERVE: on ? "true" : "false" }),
      }),
    },
  };
});

const formatTailscale = (
  tailscale: { readonly status: TailscaleStatus; readonly address: string },
  owner: Owner | null,
  port: number,
  requireGrant: boolean,
) => {
  const { status, address } = tailscale;
  const tagged = status.selfTags.length > 0;
  const directUrl = `http://${address}:${port}`;
  const dst = status.selfTags[0] ?? address;
  // The owner, or the host's own user on an untagged box. A tagged box's user is the
  // shared "tagged-devices" user, which no policy can name, so it gets a placeholder.
  const src =
    owner?.login ??
    (tagged || status.selfUserId === null ? null : loginOf(status, status.selfUserId)) ??
    "you@example.com";
  return [
    `Tailscale: ${status.magicDnsName ?? address}`,
    ...(owner === null ? [] : [`Owner: ${owner.login ?? owner.userId}`]),
    `Add this machine: ${directUrl}`,
    // A QR code is noise in a log.
    ...(process.stdout.isTTY ? [renderTerminalQrCode(directUrl)] : []),
    "Tailnet devices find this machine automatically.",
    "",
    ...(requireGrant
      ? [
          "Add this grant to your tailnet policy:",
          indent(tailnetGrantSnippet(src, dst, port)),
          "Let your untagged devices in without a grant: `t3 tailscale require-grant off`.",
        ]
      : [
          "While your tailnet policy grants no device here, your untagged devices can sign in, agents on them included.",
          "Require policy grants: `t3 tailscale require-grant on`.",
        ]),
  ].join("\n");
};

const setUp = Effect.fn("cli.up")(function* (
  flags: RouteFlags & {
    readonly baseDir: Option.Option<string>;
    readonly yes: boolean;
    readonly headless: boolean;
    readonly owner: Option.Option<string>;
    readonly requireGrant: boolean;
    readonly tailscaleServe: Option.Option<boolean>;
  },
) {
  // The service runs under `systemctl --user`, so root would set up a separate root install.
  if ((yield* HostProcess.UserId) === 0) {
    const env = yield* HostProcess.Environment;
    return yield* upError(
      `Run t3 up as the user who should own T3 Code, not as root:\n  sudo -iu ${env.SUDO_USER ?? "<user>"} npx t3 up`,
    );
  }
  const config = yield* ServerConfig.ServerConfig;
  const service = yield* BootService.BootService;
  const before = yield* readSetup();
  if (before.connect === null && Option.getOrElse(flags.connect, () => false)) {
    return yield* upError("T3 Connect is unavailable in this build.");
  }
  const current: Routes = {
    tailscale: before.settings.tailscale,
    connect: before.connect === true,
    lan: before.settings.lan,
  };
  // A publish-only link is not "on", but a rollback must put it back.
  const priorPublishOnly =
    hasCloudPublicConfig &&
    (yield* CliState.readCliDesiredCloudLink) &&
    (yield* CliState.readCliDesiredLinkMode) === "publish_only";
  const other = Option.isSome(flags.tailscaleServe);
  const asks = [flags.tailscale, flags.connect, flags.lan].every(Option.isNone) && !other;
  const tailscale =
    asks || Option.getOrElse(flags.tailscale, () => current.tailscale)
      ? yield* checkTailscale()
      : ({ ok: false, reason: "Tailscale was not checked." } as const);
  const plan = planRoutes(
    {
      installed: before.service.installed,
      current,
      available: { tailscale: tailscale.ok, connect: before.connect !== null },
    },
    { ...flags, other },
  );
  const interactive = !flags.yes && interactiveTerminal();
  let routes = plan.routes;
  // An older install's LAN access stays marked as such until someone chooses it.
  let lanChosen = Option.isSome(flags.lan) || !before.lanFromOldDefault;
  if (plan.ask.length > 0 && interactive) {
    lanChosen = true;
    if (before.service.installed) yield* Console.log(`Current setup\n${formatSetup(before)}\n`);
    if (!tailscale.ok) yield* Console.log(`${tailscale.reason}\n`);
    const picked = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Allow connections through:",
        selectAll: "Select all",
        selectNone: "Clear all",
        inverseSelection: "Invert selection",
        choices: plan.ask.map((route) => ({
          ...CHOICES[route],
          ...(route === "tailscale" && before.requireGrant
            ? { description: "Devices your policy grants. No pairing code." }
            : {}),
          value: route,
          selected: plan.routes[route],
        })),
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
    if (picked === null) return yield* Console.log("Nothing changed.");
    routes = {
      tailscale: picked.includes("tailscale"),
      connect: picked.includes("connect"),
      lan: picked.includes("lan"),
    };
  } else if (plan.ask.length > 0 && !flags.yes && !before.service.installed) {
    const offered = [
      ...(tailscale.ok ? ["--tailscale"] : []),
      ...(before.connect === null ? [] : ["--connect"]),
      "--lan",
    ];
    return yield* upError(
      `No terminal. Choose access with ${offered.join(", ")}, or use --yes for the default. See \`t3 up --help\`.`,
    );
  }
  // An explicit off is written even when the file says nothing, since the service may
  // inherit the setting, and a restart applies it. Unchecking Tailscale is one too.
  const tailscaleOffChosen =
    Option.getOrUndefined(flags.tailscale) === false ||
    (interactive && plan.ask.includes("tailscale") && !routes.tailscale);
  const serveOffChosen = Option.getOrUndefined(flags.tailscaleServe) === false;
  // Nothing to run in the background, but a route left on still gets turned off.
  if (!before.service.installed && !routes.connect && !routes.lan && !routes.tailscale) {
    if (current.connect || before.connectRevoked) {
      yield* disconnectCloud({ clearAuthorization: false });
    }
    yield* CliService.writeServiceEnv(config.baseDir, {
      ...(current.lan ? { T3CODE_LAN: "false" } : {}),
      ...(current.tailscale || tailscaleOffChosen ? TAILSCALE_OFF : {}),
      ...(serveOffChosen ? { T3CODE_TAILSCALE_SERVE: "false" } : {}),
    });
    // service.env is read only by the background service, so a server started by hand
    // keeps the access it started with.
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    const handStarted = Option.exists(
      runtime,
      (state) => state.serviceManaged !== true && isProcessAlive(state.pid),
    );
    const runningElsewhere =
      "T3 Code is running here outside the background service, with the access it started with. In the desktop app, turn access off in Settings → Sharing & access. Otherwise, stop the server.";
    if (handStarted) return yield* Console.log(runningElsewhere);
    // Nothing runs here to remove a Serve mapping a stopped server left, so do it now,
    // holding the T3 home's lock so no server starts meanwhile.
    if (yield* TailscaleServe.hasRecord(config.stateDir)) {
      const record = yield* TailscaleServe.recordPath(config.stateDir);
      const orDelete = `or delete ${record} if you no longer use Tailscale here.`;
      const leftover = yield* ServerOwnership.acquireServerOwnership(
        config.serverRuntimeStatePath,
      ).pipe(
        Effect.provide(ProcessRunner.layer),
        Effect.andThen(TailscaleServe.releaseRecorded(config.stateDir)),
        Effect.scoped,
        Effect.catchTags({ ServerAlreadyRunningError: () => Effect.succeed(null) }),
        Effect.catch((error) => {
          switch (error._tag) {
            case "ServeRecordError":
              return upError(
                error.reason === "unreadable"
                  ? error.message
                  : error.reason === "switched"
                    ? `${error.message} Run this again.`
                    : error.reason === "unlisted"
                      ? `${error.message} Run this again, ${orDelete}`
                      : `${error.message} Then run this again, ${orDelete}`,
              );
            case "PlatformError":
              return upError(`Could not update the Tailscale Serve record: ${error.message}`);
            case "ServerOwnershipError":
            case "OlderBootServiceError":
              return upError(error.message);
            default:
              return upError(
                `Tailscale did not answer, so a Serve mapping an earlier run left may remain. Run this again once Tailscale runs, ${orDelete}`,
              );
          }
        }),
      );
      if (leftover === null) return yield* Console.log(runningElsewhere);
      if (leftover.released) {
        yield* Console.log("Removed a Tailscale Serve mapping an earlier run left.");
      }
      if (leftover.otherAccounts.length > 0) {
        yield* Console.log(formatNextSteps(routes, false));
        const one = leftover.otherAccounts.length === 1;
        return yield* upError(
          `A Tailscale Serve mapping an earlier run left may remain on ${one ? "another Tailscale account" : "other Tailscale accounts"}: ${leftover.otherAccounts.join(", ")}. Switch Tailscale to ${one ? "it" : "each"} and run this again, or delete ${record} if ${one ? "that account is" : "they are"} gone.`,
        );
      }
    }
    return yield* Console.log(formatNextSteps(routes, false));
  }
  // Tailscale left on while it is down here keeps its settings; turning it on needs it.
  const tailscaleKept = routes.tailscale && current.tailscale && Option.isNone(flags.tailscale);
  if (routes.tailscale && !tailscale.ok && !tailscaleKept) {
    return yield* upError(`${tailscale.reason} Then run t3 up again.`);
  }
  if (tailscaleKept && !tailscale.ok && !(plan.ask.length > 0 && interactive)) {
    yield* Console.log(
      `${tailscale.reason} ${serveOffChosen ? "Serve turns off. Other Tailscale settings" : "Tailscale settings"} stay as they are.`,
    );
  }

  const requireGrant = flags.requireGrant || before.requireGrant;
  // Its settings, owner included, are looked up again only when Tailscale is turned on or
  // chosen, so a run that changes something else never asks for an owner.
  const tailscaleChosen =
    !current.tailscale || Option.isSome(flags.tailscale) || (plan.ask.length > 0 && interactive);
  const signIn =
    routes.tailscale && tailscale.ok && tailscaleChosen
      ? yield* tailscaleEntries(tailscale, flags, requireGrant)
      : null;
  const pinsOff =
    (tailscaleOffChosen &&
      (before.entries.T3CODE_TAILSCALE_SIGN_IN !== "false" ||
        before.entries.T3CODE_TAILSCALE_SERVE !== "false")) ||
    (serveOffChosen && before.entries.T3CODE_TAILSCALE_SERVE !== "false");
  const writes: Readonly<Record<string, string | undefined>> = {
    ...(lanChosen ? { T3CODE_LAN: String(routes.lan) } : {}),
    ...(routes.tailscale
      ? (signIn?.entries ?? {})
      : current.tailscale || tailscaleOffChosen
        ? TAILSCALE_OFF
        : {}),
    ...(serveOffChosen ? { T3CODE_TAILSCALE_SERVE: "false" } : {}),
  };
  const planned = Object.fromEntries(
    Object.entries({ ...before.entries, ...writes }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
  const { installedVersion } = before.service;
  const newer =
    installedVersion !== undefined &&
    compareExactServiceVersions(installedVersion, packageJson.version) > 0;
  // A running service reads these settings only at start. Asked before anything
  // changes, so a declined restart leaves service.env matching what it runs.
  // A stopped service of this version is not current, so reconcile starts it;
  // a newer one is left alone and needs this restart to start.
  const stopped = before.service.problems?.includes("service-stopped") === true;
  const changed =
    !sameSettings(before.settings, serviceSettings(planned, true)) ||
    (routes.connect && !current.connect);
  const restart =
    before.service.installed &&
    (before.service.current || newer) &&
    (changed || pinsOff || stopped);
  // An older or broken service is reinstalled, which restarts it too.
  const update = before.service.installed && !before.service.current && !newer && !stopped;
  if ((restart || update) && interactive && !stopped) {
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: update
          ? "Update and restart T3 Code? Running agent turns will stop."
          : changed
            ? "Apply changes and restart? Running agent turns will stop."
            : `Write Tailscale ${tailscaleOffChosen ? "" : "Serve "}off, so the service cannot inherit it, and restart? Running agent turns will stop.`,
        initial: true,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) return yield* Console.log("Nothing changed.");
  }

  // Once on, it stays on: rerunning without the flag must never widen access.
  if (routes.tailscale && flags.requireGrant) {
    yield* turnOnRequireGrant(config.stateDir, "turned on with t3 up --require-grant");
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
  // Settings land before the service starts, so it never runs with sign-in half set up.
  // Also with no service manager: the file records the choices that `t3 status` shows.
  yield* CliService.writeServiceEnv(config.baseDir, writes);
  // When the service step fails, an installed service still runs with the old values,
  // so the file goes back to match it. A new T3 Connect link is undone too, with any
  // tunnel the failed start saved, so a rerun sees it as a change. The sign-in stays.
  const restoreServiceEnv = before.service.installed
    ? CliService.writeServiceEnv(
        config.baseDir,
        Object.fromEntries(Object.keys(writes).map((key) => [key, before.entries[key]])),
      ).pipe(
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
      `T3CODE_HOST=${before.host} in service.env overrides the network choices. Remove it to apply them.`,
    );
  }

  const printServeCommand = Effect.fn(function* (reason: string) {
    // The same settings the service would read from service.env.
    const { command } = yield* resolveHostCliCommand("serve", [
      ...Option.match(flags.baseDir, { onNone: () => [], onSome: (dir) => ["--base-dir", dir] }),
      // Explicit either way, so settings in the shell cannot override the choices.
      routes.lan ? "--lan" : "--no-lan",
      routes.tailscale ? "--tailscale-sign-in" : "--no-tailscale-sign-in",
      ...(planned.T3CODE_PORT === undefined ? [] : ["--port", planned.T3CODE_PORT]),
      ...(routes.tailscale && planned.T3CODE_TAILSCALE_OWNER !== undefined
        ? ["--tailscale-owner", planned.T3CODE_TAILSCALE_OWNER]
        : []),
      routes.tailscale && parseBoolean(planned.T3CODE_TAILSCALE_SERVE) === true
        ? "--tailscale-serve"
        : "--no-tailscale-serve",
    ]);
    yield* Console.log(`${reason} Keep this command running:\n  ${command}`);
    // A host wins over these flags, as it does in service.env.
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
      // A failure, so a script sees that the running service kept its old access.
      return yield* upError(
        `Service setup failed: ${result.failed} The service kept its old settings. Fix that, then run \`t3 up\` again.`,
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
  yield* Console.log(`\nThis machine\n${formatSetup(after)}\n`);
  if (signIn !== null && tailscale.ok && after.settings.tailscale) {
    yield* Console.log(formatTailscale(tailscale, signIn.owner, signIn.port, requireGrant));
  }
  // From what took effect: a failed service step can undo a choice.
  const nextSteps = formatNextSteps(
    {
      tailscale: after.settings.tailscale,
      connect: after.connect === true,
      lan: after.settings.lan,
    },
    after.service.installed,
  );
  if (nextSteps !== "") yield* Console.log(nextSteps);
});

const routeFlag = (name: Route, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.optional);

export const upCommand = Command.make("up", {
  ...projectLocationFlags,
  tailscale: routeFlag(
    "tailscale",
    "Allow Tailscale sign-in with no pairing code. Policy grants decide access; with none, your untagged devices can sign in. Turn off with --no-tailscale.",
  ),
  connect: routeFlag(
    "connect",
    "Allow access through T3 Connect with your T3 account. Turn off with --no-connect.",
  ),
  lan: routeFlag(
    "lan",
    "Allow LAN and tailnet connections. Anyone there can reach the port; a pairing code is the only lock. Turn off with --no-lan.",
  ),
  owner: Flag.String("owner").pipe(
    Flag.withDescription("Tailscale owner login for a tagged machine. Implies --tailscale."),
    Flag.optional,
  ),
  requireGrant: Flag.Boolean("require-grant").pipe(
    Flag.withDescription(
      `Require a ${TAILNET_APP_CAPABILITY} policy grant for Tailscale sign-in. Saved for later runs. Implies --tailscale.`,
    ),
    Flag.withDefault(false),
  ),
  tailscaleServe: Flag.Boolean("tailscale-serve").pipe(
    Flag.withDescription(
      "Serve HTTPS through Tailscale Serve. Implies --tailscale. --no-tailscale-serve turns it off and leaves sign-in as it is.",
    ),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription(
      "Ask nothing. Keep the access settings; a new machine gets Tailscale if it runs here, else T3 Connect. A restart stops running agent turns.",
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
    { command: "t3 up --tailscale", description: "Turn on Tailscale. Keep other settings." },
    { command: "t3 up --connect", description: "Turn on T3 Connect. Keep other settings." },
    { command: "t3 up --lan", description: "Allow LAN access with pairing codes." },
    { command: "t3 up --no-lan", description: "Stop LAN access." },
    {
      command: "t3 up --tailscale --no-connect --no-lan --require-grant",
      description: "Allow only Tailscale devices your policy grants.",
    },
    {
      command: "t3 up --tailscale --owner you@example.com",
      description: "Set the owner of a tagged machine.",
    },
    { command: "t3 up --yes", description: "Take the defaults with no questions." },
    { command: "t3 status --json", description: "Read the settings from a script." },
  ]),
  Command.withHandler((flags) => {
    const tailscaleOnly = [
      ...(Option.isSome(flags.owner) ? ["--owner"] : []),
      ...(flags.requireGrant ? ["--require-grant"] : []),
      ...(Option.getOrUndefined(flags.tailscaleServe) === true ? ["--tailscale-serve"] : []),
    ];
    if (Option.getOrUndefined(flags.tailscale) === false && tailscaleOnly.length > 0) {
      return Effect.fail(upError(`--no-tailscale conflicts with ${tailscaleOnly.join(", ")}.`));
    }
    return runCloudCommand(
      flags,
      setUp({
        ...flags,
        // The Tailscale settings only mean something with Tailscale on.
        tailscale: tailscaleOnly.length > 0 ? Option.some(true) : flags.tailscale,
      }),
      { quietLogs: true },
    );
  }),
);

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Set up T3 Connect for this machine. Same as `t3 up --connect`."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      setUp({
        ...flags,
        connect: Option.some(true),
        tailscale: Option.none(),
        lan: Option.none(),
        yes: false,
        owner: Option.none(),
        requireGrant: false,
        tailscaleServe: Option.none(),
      }),
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
      tailscale: { enabled: setup.settings.tailscale, requireGrant: setup.requireGrant },
      connect:
        setup.connect === null ? null : { enabled: setup.connect, revoked: setup.connectRevoked },
      lan: {
        enabled: setup.settings.lan,
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
          : `This machine\n${formatSetup(setup)}\n\nChange access: \`t3 up\`. Tailscale details: \`t3 tailscale status\`.`,
      );
    }),
  ),
);
