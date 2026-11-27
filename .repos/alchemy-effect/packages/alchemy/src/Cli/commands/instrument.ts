import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import { authRegistryLayer } from "../../Alchemist/AuthRegistry.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { globalLogs } from "../../Util/LogRecord.ts";

/**
 * Commands about the account, not a project: their logs go to the global run
 * log (`~/.alchemy/logs`), so running one outside a project creates nothing
 * there.
 */
const isGlobalCommand = (command: string) =>
  /^(profile|provider)(\.|$)/.test(command) ||
  command === "state.bootstrap" ||
  command === "state.teardown";

/**
 * The terminal shows a failed command's friendly message; this keeps its
 * full cause chain in the command's run log.
 */
export const logCommandFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapCause(effect, (cause) => Effect.logDebug(`command failed:\n${Cause.pretty(cause)}`));

/**
 * The pre-command version check. The CLI entrypoint sets it with its
 * services already provided; elsewhere (tests, the API) it does nothing.
 */
export const VersionCheck = Context.Reference<Effect.Effect<void>>("alchemy/Cli/VersionCheck", {
  defaultValue: () => Effect.void,
});

/**
 * Wraps a command handler as one traced, metered unit. A best-effort check
 * for a newer published version runs first, so its warning prints before
 * any interactive prompt; it is cached for a day and bounded by a short
 * timeout, so this stays fast.
 */
export const instrumentCommand =
  <AttrsArgs = unknown>(command: string, attrs?: (args: AttrsArgs) => Record<string, unknown>) =>
  <Args extends AttrsArgs, A, E, R>(
    handler: (args: Args) => Effect.Effect<A, E, R>,
  ): ((args: Args) => Effect.Effect<A, E, R>) =>
  (args) =>
    Effect.andThen(Effect.flatten(VersionCheck), handler(args)).pipe(
      Effect.withSpan(`cli.${command}`, {
        attributes: attrs ? attrs(args) : {},
      }),
      recordCli(command),
      logCommandFailure,
      isGlobalCommand(command) ? globalLogs : identity,
      // Auth registries are memoized for the command's duration.
      Effect.provide(authRegistryLayer),
    );
