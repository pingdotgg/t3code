import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as CliConfig from "effect/unstable/cli/CliConfig";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { routeCacheLayer } from "alchemy/Alchemist/Session";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import packageJson from "../../package.json" with { type: "json" };

import * as CliKit from "./CliKit/index.ts";
import { checkLatestVersion } from "./checkVersion.ts";
import { GlobalLogLive, logRunHeader } from "./GlobalLog.ts";
import { handleCliErrors } from "./commands/errors.ts";
import {
  compatibilityCommand,
  compatibilityCommands,
  type CompatibilityCommand,
} from "./commands/compat.ts";
import { selectCliServices } from "./selectCli.ts";

const commandMetadata = [
  ["provider", "Manage cloud provider prerequisites and utilities"],
  ["deploy", "Deploy a stack"],
  ["dev", "Develop a stack with live reload"],
  ["destroy", "Destroy a deployed stack"],
  ["plan", "Preview changes to a stack"],
  ["logs", "Fetch or tail logs from stack resources"],
  ["profile", "Manage authentication profiles and accounts"],
  ["state", "Inspect and manage deployment state"],
  ["drift", "Detect infrastructure drift"],
  ["unsafe", "Unsafe maintenance commands"],
] as const;

type CommandName = (typeof commandMetadata)[number][0];

const placeholderCommand = (name: CommandName, description: string) =>
  Command.make(name, {}, () => Effect.void).pipe(
    Command.withDescription(description),
    name === "unsafe" ? Command.unlisted : (command) => command,
  );

const loadCommand = async (name: CommandName) => {
  switch (name) {
    case "provider":
      return (await import("./commands/provider.ts")).providerCommand;
    case "deploy":
      return (await import("./commands/deploy.ts")).deployCommand;
    case "dev":
      return (await import("./commands/dev.ts")).devCommand;
    case "destroy":
      return (await import("./commands/deploy.ts")).destroyCommand;
    case "plan":
      return (await import("./commands/deploy.ts")).planCommand;
    case "logs":
      return (await import("./commands/logs.ts")).logsCommand;
    case "profile":
      return (await import("./commands/profile/index.ts")).profileCommand;
    case "state":
      return (await import("./commands/state.ts")).stateCommand;
    case "drift":
      return (await import("./commands/drift.ts")).driftCommand;
    case "unsafe":
      return (await import("./commands/nuke.ts")).unsafeCommand;
  }
};

const argv = process.argv.slice(2);
const compatibilityName = Object.hasOwn(compatibilityCommands, argv[0] ?? "")
  ? (argv[0] as CompatibilityCommand)
  : undefined;

// Compatibility commands only print their replacement. Discard everything
// after the old command name so historical positional arguments and flags are
// accepted without teaching the retired parser surface about every old form.
if (compatibilityName !== undefined) {
  const index = process.argv.indexOf(compatibilityName, 2);
  process.argv.splice(index + 1);
}

const commandNames = new Set<CommandName>(
  commandMetadata.map(([name]) => name),
);
const requestedCommand = argv.find((value): value is CommandName =>
  commandNames.has(value as CommandName),
);
const loadEveryCommand = argv.includes("--completions");
const commands = await Promise.all(
  commandMetadata.map(([name, description]) =>
    loadEveryCommand || name === requestedCommand
      ? loadCommand(name)
      : placeholderCommand(name, description),
  ),
);

/**
 * `--no-input` forces plain, prompt-free output regardless of TTY or env
 * detection. The value is read via an argv scan in `Util/interactive.ts`
 * (capability detection runs while the service layers are built, before flag
 * parsing); this registration exists so the parser accepts the flag.
 */
const NoInput = GlobalFlag.Setting("no-input")({
  flag: Flag.Boolean("no-input").pipe(
    Flag.withDescription(
      "Disable prompts and the interactive TUI (plain output; commands needing input fail)",
    ),
    Flag.withDefault(false),
  ),
});

const root = Command.make("alchemy", {}, () =>
  Effect.fail(new CliError.ShowHelp({ commandPath: ["alchemy"], errors: [] })),
).pipe(
  Command.withDescription(
    "Define, deploy, and operate cloud infrastructure with type-safe Effect programs.",
  ),
  Command.withExamples([
    { command: "alchemy deploy" },
    { command: "alchemy plan --stage prod" },
    { command: "alchemy dev" },
    { command: "alchemy logs --tail" },
  ]),
  Command.withSubcommands([
    ...commands,
    ...Object.keys(compatibilityCommands).map((name) =>
      compatibilityCommand(name as CompatibilityCommand),
    ),
  ]),
  Command.withGlobalFlags([NoInput]),
);

/**
 * How this CLI process is running, appended to `--version` in a checkout
 * for debugging the launcher's implicit mode selection (`bin/cli.js`): the
 * runtime, and whether we're executing `.ts` source (bun, or node with type
 * stripping + the Oxc register hook) or built output — `node <x>, lib` is
 * the tell for the old-node fallback that still needs a build. Published
 * installs print the plain version string.
 */
const devRunMode = import.meta.url.includes("/node_modules/")
  ? undefined
  : `${
      typeof globalThis.Bun !== "undefined"
        ? `bun ${globalThis.Bun.version}`
        : `node ${process.versions.node}`
    }, ${import.meta.url.endsWith(".ts") ? "src" : "lib"}`;

const cli = Command.run(root, {
  version:
    devRunMode === undefined
      ? packageJson.version
      : `${packageJson.version} (${devRunMode})`,
});

const services = Layer.mergeAll(
  CliConfig.layer({
    builtIns: [
      GlobalFlag.Help,
      GlobalFlag.Version,
      GlobalFlag.Completions,
      GlobalFlag.LogLevel,
    ],
  }),
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  // Ambient per-CLI-run artifact root. Commands that define their own run
  // boundary (deploy, drift) provide a fresh store closer to the work, which
  // wins over this one.
  Layer.succeed(ArtifactStore, createArtifactStore()),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  routeCacheLayer,
  Layer.provide(
    Layer.provideMerge(
      Layer.mergeAll(selectCliServices(), CliKit.CliKitInteraction),
      CliKit.layer(),
    ),
    PlatformServices,
  ),
  // Debug run log under ~/.alchemy/logs — the console noise floor stays at
  // Info, but full causes and auth-flow breadcrumbs land in the file so
  // support can ask users for it.
  //
  // Telemetry sits on top of the console/file loggers so its OTLP logger
  // merges with them. Listed as `mergeAll` siblings, whichever came last
  // would win the `CurrentLoggers` slot and silently drop the other.
  Layer.provideMerge(
    TelemetryLive,
    Layer.provide(GlobalLogLive, PlatformServices),
  ),
);

const program = Effect.gen(function* () {
  yield* logRunHeader;
  // Best-effort check for a newer published version. Runs to completion
  // before the command so the warning prints before any interactive
  // prompts; the registry response is cached for a day and the fetch is
  // bounded by a short timeout, so this stays fast.
  yield* checkLatestVersion;
  return yield* cli;
}).pipe(
  // The terminal shows the friendly message; the run log keeps the full
  // cause chain. Must sit inside the service provision so the file logger
  // is still installed.
  Effect.tapCause((cause) =>
    Effect.logDebug(`command failed:\n${Cause.pretty(cause)}`),
  ),
);

const mainEffect = program.pipe(
  // $USER and $ALCHEMY_STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCliErrors,
);

/** Fully wired CLI program. */
export const main = mainEffect as Effect.Effect<
  void,
  Effect.Error<typeof mainEffect>
>;
