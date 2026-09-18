import * as Effect from "effect/Effect";
import { routeCacheLayer } from "../../Alchemist/Session.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";

/**
 * Wraps a command handler as one traced, metered unit that is also one
 * route-cache scope: the stack sessions and auth registries its routes open
 * are memoized for the command's duration (`routeCacheLayer`). Commands that
 * never open a session (`dev`, which only supervises the exec child) stay
 * off this wrapper and therefore never load `Alchemist/Session`.
 */
export const instrumentCommand =
  <AttrsArgs = unknown>(
    command: string,
    attrs?: (args: AttrsArgs) => Record<string, unknown>,
  ) =>
  <Args extends AttrsArgs, A, E, R>(
    handler: (args: Args) => Effect.Effect<A, E, R>,
  ): ((args: Args) => Effect.Effect<A, E, R>) =>
  (args) =>
    handler(args).pipe(
      Effect.withSpan(`cli.${command}`, {
        attributes: attrs ? attrs(args) : {},
      }),
      recordCli(command),
      Effect.provide(routeCacheLayer),
    );
