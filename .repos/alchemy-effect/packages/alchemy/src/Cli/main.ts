import { AlchemyContext, AlchemyContextLive } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Contributions from "alchemy/Contributions";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { moduleExtension } from "alchemy/Util/Node";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import packageJson from "../../package.json" with { type: "json" };
import * as Interaction from "../Interaction.ts";
import { logShutdown } from "../Util/Shutdown.ts";
import { checkLatestVersion } from "./checkVersion.ts";
import {
  compatibilityCommand,
  compatibilityCommands,
  type CompatibilityCommand,
} from "./commands/compat.ts";
import { handleCliErrors } from "./commands/errors.ts";
import { VersionCheck } from "./commands/instrument.ts";
import { GlobalLogLive, LogFormatFlag, LogLevelFlag } from "./GlobalLog.ts";
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

// A broken provider shouldn't take the whole CLI down: warn and run without
// providers. Commands that need them (auth, `state --backend`) fail with the
// provider error when they load them again.
const loadContributions = () =>
  Effect.runPromise(
    Contributions.load().pipe(
      Effect.catch((error) => Effect.as(Effect.logWarning(error.message), [])),
      Effect.provide(PlatformServices),
    ),
  );

const loadCommand = async (name: CommandName) => {
  switch (name) {
    case "provider":
      return (await import("./commands/provider.ts")).providerCommand(await loadContributions());
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

const commandNames = new Set<CommandName>(commandMetadata.map(([name]) => name));
const requestedCommand = argv.find((value): value is CommandName =>
  commandNames.has(value as CommandName),
);
const loadEveryCommand = argv.includes("--completions");
const commands = await Promise.all(
  commandMetadata.map(([name, description]) =>
    loadEveryCommand || name === requestedCommand
      ? loadCommand(name)
      : Promise.resolve(placeholderCommand(name, description)),
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

/**
 * `--fast-distilled` loads distilled SDKs through their lazy service stubs
 * under Node. The launcher (`bin/cli.js`) reads it from argv before any
 * module loads and passes it on as `ALCHEMY_FAST_DISTILLED=1`; this
 * registration exists so the parser accepts the flag.
 */
const FastDistilled = GlobalFlag.Setting("fast-distilled")({
  flag: Flag.Boolean("fast-distilled").pipe(
    Flag.withDescription(
      "Load distilled SDK operations on first use (Node only; lowers startup memory)",
    ),
    Flag.withDefault(false),
  ),
});

const root = Command.make("alchemy", {}, () =>
  Effect.fail(CliError.ShowHelp.make({ commandPath: ["alchemy"], errors: [] })),
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
  Command.withGlobalFlags([NoInput, FastDistilled, LogLevelFlag, LogFormatFlag]),
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
    }, ${moduleExtension(import.meta.url) === ".ts" ? "src" : "lib"}`;

const cli = Command.run(root, {
  version:
    devRunMode === undefined ? packageJson.version : `${packageJson.version} (${devRunMode})`,
});

const services = Layer.mergeAll(
  CliConfig.layer({
    builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions],
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
  Layer.provide(Layer.provideMerge(selectCliServices(), Interaction.layer()), PlatformServices),
  // Debug run log in the project's .alchemy/log — the console noise floor stays at
  // Info, but full causes and auth-flow breadcrumbs land in the file so
  // support can ask users for it.
  Layer.provide(GlobalLogLive, PlatformServices),
  TelemetryLive,
);

const program = Effect.gen(function* () {
  // Best-effort check for a newer published version, run by each command
  // before its handler: the console flags are parsed by then, and the
  // warning prints before any interactive prompt. Cached for a day and
  // bounded by a short timeout, so it stays fast. Its fetch may finish in
  // the background, in this scope.
  // Only the check's own services, so the command's flags and loggers win.
  const services = Context.pick(
    AlchemyContext,
    FileSystem.FileSystem,
    HttpClient.HttpClient,
    Path.Path,
    Scope.Scope,
  )(
    yield* Effect.context<
      AlchemyContext | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | Scope.Scope
    >(),
  );
  const check = yield* Effect.cached(Effect.provideContext(checkLatestVersion, services));
  return yield* cli.pipe(Effect.provideService(VersionCheck, check));
}).pipe(logShutdown("cli"));

const mainEffect = program.pipe(
  // $USER and $ALCHEMY_STAGE are set by the environment
  Effect.provide(services),
  Effect.scoped,
  handleCliErrors,
);

/** Fully wired CLI program. */
export const main = mainEffect as Effect.Effect<void, Effect.Error<typeof mainEffect>>;
