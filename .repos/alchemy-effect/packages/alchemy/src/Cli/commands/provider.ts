import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Alchemist from "../../Alchemist/index.ts";
import * as Contributions from "../../Contributions.ts";
import { Interaction } from "../../Interaction.ts";
import { setExitCode } from "./errors.ts";
import { config, envFile, profile } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

/** Optional repeatable filter for checking a subset of registered providers. */
const checkedProviders = Flag.String("provider").pipe(
  Flag.withDescription(
    "Check only this provider (repeatable; defaults to every provider the stack registers)",
  ),
  Flag.atLeast(0),
);

const checkEnvCommand = Command.make(
  "check-env",
  { provider: checkedProviders, main: config, envFile, profile },
  instrumentCommand("provider.check-env")(
    Effect.fn(function* ({ provider: requested, main, envFile, profile }) {
      const cli = yield* Interaction;
      const result = yield* Alchemist.Provider.checkEnvironment({
        entrypoint: main,
        envFile: Option.getOrUndefined(envFile),
        profile,
        providers: requested,
      });
      for (const check of result.checks) {
        if (check.status === "no-contract") {
          yield* cli.output.info({
            message: check.provider,
            detail: "No CI environment contract",
          });
        } else if (check.status === "satisfied") {
          yield* cli.output.success(check.provider);
        } else {
          yield* cli.output.error({
            message: check.provider,
            detail: `Missing: ${check.missing
              .map(({ alternatives }) => alternatives.join(" | "))
              .join(", ")}`,
          });
        }
      }
      if (!result.satisfied) yield* setExitCode(1);
    }),
  ),
).pipe(
  Command.withDescription(
    "Verify the required environment variables for the stack's providers are set (CI preflight; exits 1 when any are missing)",
  ),
);

/**
 * `alchemy provider`: `check-env` plus each provider's provider subcommand. A
 * provider whose CLI fails to load never blocks another's: it runs as a
 * command failing with its error.
 */
export const providerCommand = async (providers: ReadonlyArray<Contributions.Contributions>) => {
  const subcommands = await Effect.runPromise(
    Effect.forEach(providers, (provider) => {
      const cli = provider.cli?.provider;
      if (cli === undefined) return Effect.succeed([]);
      return Contributions.resolve(provider, "cli.provider", cli.load).pipe(
        Effect.catch((error) =>
          Effect.succeed<Contributions.AnyCommand>(
            Command.make(provider.name, {}, () => Effect.fail(error)).pipe(
              Command.withDescription(cli.description),
            ),
          ),
        ),
        Effect.map((command) => [command]),
      );
    }).pipe(Effect.map((commands) => commands.flat())),
  );
  return Command.make("provider", {}).pipe(
    Command.withDescription("Manage cloud provider prerequisites and utilities"),
    Command.withSubcommands([checkEnvCommand, ...subcommands]),
  );
};
