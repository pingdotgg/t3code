import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import * as Nuke from "../../Alchemist/routes/nuke.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { formatElapsed } from "../Format.ts";
import {
  renderNukeScan,
  renderNukeDelete,
  reviewNuke,
} from "../components/view/Nuke.tsx";
import { exitDeclined, UserInputError } from "./errors.ts";
import {
  configPath,
  envFile,
  optionalConfig,
  profile,
  resolveConfig,
  yes,
} from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const includeFlag = Flag.String("include").pipe(
  Flag.withDescription("Glob of provider IDs to include (repeatable)"),
  Flag.atLeast(0),
);
const excludeFlag = Flag.String("exclude").pipe(
  Flag.withDescription("Glob of provider IDs to exclude (repeatable)"),
  Flag.atLeast(0),
);
const filterFlag = Flag.String("filter").pipe(
  Flag.withDescription(
    "JavaScript expression evaluated with resource in scope; matching resources are excluded from deletion (repeatable)",
  ),
  Flag.atLeast(0),
);
const concurrencyFlag = Flag.Int("concurrency").pipe(
  Flag.withDescription(
    "Maximum providers processed in parallel; 0 is unbounded",
  ),
  Flag.withDefault(16),
  Flag.map((value): number | "unbounded" => (value <= 0 ? "unbounded" : value)),
);
const timeoutFlag = Flag.Int("timeout").pipe(
  Flag.withDescription("Per-provider timeout in seconds"),
  Flag.withDefault(120),
  Flag.map(Duration.seconds),
);
const independentFlag = Flag.Boolean("independent").pipe(
  Flag.withDescription("Retry each resource independently"),
  Flag.withDefault(false),
);
const retriesFlag = Flag.Int("retries").pipe(
  Flag.withDescription("Independent retries per resource"),
  Flag.withDefault(10),
);
const localFlag = Flag.Boolean("local").pipe(
  Flag.withDescription("Target only locally emulated providers"),
  Flag.withDefault(false),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Scan and show targets without deleting"),
  Flag.withDefault(false),
);

// A broken filter must abort the nuke, not silently widen the kill list:
// compile and evaluation errors both fail the command before any deletion.
const compileFilter = (expression: string) =>
  Effect.try({
    try: () =>
      new Function(
        "scope",
        `with (scope) { return (${expression}); }`,
      ) as (scope: { resource: Record<string, unknown> }) => unknown,
    catch: (cause) =>
      new UserInputError({
        message: `--filter expression ${JSON.stringify(expression)} failed to compile: ${cause}`,
      }),
  }).pipe(
    Effect.map(
      (predicate) => (resource: Record<string, unknown>) =>
        Effect.try({
          try: () => Boolean(predicate({ resource })),
          catch: (cause) =>
            new UserInputError({
              message: `--filter expression ${JSON.stringify(expression)} threw while evaluating a resource: ${cause}`,
            }),
        }),
    ),
  );

const nukeCommand = Command.make(
  "nuke",
  {
    config: optionalConfig,
    configPath,
    envFile,
    profile,
    yes,
    dryRun: dryRunFlag,
    concurrency: concurrencyFlag,
    timeout: timeoutFlag,
    independent: independentFlag,
    retries: retriesFlag,
    include: includeFlag,
    exclude: excludeFlag,
    filter: filterFlag,
    local: localFlag,
  },
  (args) =>
    resolveConfig(args).pipe(
      Effect.flatMap(
        instrumentCommand(
          "unsafe.nuke",
          (args: { profile: string | undefined; main: string }) => ({
            "alchemy.profile": args.profile ?? "",
            "alchemy.main": args.main,
          }),
        )(
          Effect.fn(function* (args) {
            const scan = yield* Nuke.scan({
              entrypoint: args.main,
              profile: args.profile,
              envFile: Option.getOrUndefined(args.envFile),
              mode: args.local ? "local" : "live",
              include: args.include,
              exclude: args.exclude,
              concurrency: args.concurrency,
              providerTimeoutSeconds: Duration.toSeconds(args.timeout),
            }).pipe(renderNukeScan());
            const predicates = yield* Effect.forEach(
              args.filter,
              compileFilter,
            );
            const targets: Array<(typeof scan.resources)[number]> = [];
            for (const resource of scan.resources) {
              const matches = yield* Effect.forEach(predicates, (predicate) =>
                predicate({
                  ...resource.attributes,
                  Type: resource.providerId,
                  LogicalId: resource.displayName,
                }),
              );
              if (!matches.some(Boolean)) targets.push(resource);
            }
            if (targets.length === 0) {
              yield* CliKit.accessors.output.info("Nothing to delete.");
              return;
            }
            const approved = yield* reviewNuke(targets, {
              mode: scan.mode,
              yes: args.yes,
              dryRun: args.dryRun,
            });
            if (!approved) {
              yield* CliKit.accessors.output.info("Aborted.");
              return yield* exitDeclined;
            }
            if (args.dryRun) {
              yield* Console.log("Dry run complete: nothing was deleted.");
              return;
            }
            const deleteStartedAt = yield* Clock.currentTimeMillis;
            const result = yield* Nuke.execute({
              scan,
              resources: targets,
              strategy: args.independent
                ? { _tag: "independent", retries: args.retries }
                : { _tag: "coordinated" },
              concurrency: args.concurrency,
              providerTimeoutSeconds: Duration.toSeconds(args.timeout),
            }).pipe(renderNukeDelete(targets, scan.mode));
            const deleteElapsed =
              (yield* Clock.currentTimeMillis) - deleteStartedAt;
            yield* CliKit.accessors.output.success(
              `Deleted ${result.deleted.length} resource(s) over ${result.passes} pass(es) (${formatElapsed(deleteElapsed)}).`,
            );
            if (result.held.length > 0) {
              yield* CliKit.accessors.output.warning(
                `${result.held.length} resource(s) were held back.`,
              );
            }
            if (result.failed.length > 0) {
              yield* CliKit.accessors.output.error(
                `${result.failed.length} resource(s) could not be deleted.`,
              );
            }
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Enumerate resources across the stack providers and delete them",
  ),
  Command.unlisted,
);

export const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Dangerous, irreversible operations"),
  Command.withSubcommands([nukeCommand]),
  Command.unlisted,
);
