import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { apply } from "../../Apply.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CLI from "../../Cli/Cli.ts";
import * as Plan from "../../Plan.ts";
import { Stage } from "../../Stage.ts";
import { isTelemetryDisabled } from "../../Telemetry/Attributes.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  dryRun as dryRunFlag,
  envFile,
  force,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
  yes,
} from "./_shared.ts";

export const ExecStackOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
  destroy: Schema.optional(Schema.Boolean),
  dev: Schema.optional(Schema.Boolean),
  adopt: Schema.optional(Schema.Boolean),
});
export type ExecStackOptions = typeof ExecStackOptions.Type;
export type ExecStackOptionsEncoded = typeof ExecStackOptions.Encoded;

const stackSpanAttrs = (args: ExecStackOptions) => ({
  "alchemy.stage": args.stage,
  "alchemy.profile": args.profile,
  "alchemy.main": args.main,
  "alchemy.dry_run": !!args.dryRun,
  "alchemy.force": !!args.force,
  "alchemy.destroy": !!args.destroy,
  "alchemy.dev": !!args.dev,
  "alchemy.adopt": !!args.adopt,
});

const adopt = Flag.boolean("adopt").pipe(
  Flag.withDescription(
    "Adopt pre-existing cloud resources that conflict with this stack instead of failing. " +
      "Useful for re-importing infrastructure into a fresh state store.",
  ),
  Flag.withDefault(false),
);

const runStack = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  dryRun = false,
  force = false,
  yes = false,
  destroy = false,
  dev = false,
  adopt = false,
}: ExecStackOptions) {
  const stackEffect = yield* importStack(main);

  // `--log-level <x>` has to actually put log records on the user's
  // terminal. With telemetry on (the default) `TelemetryLive` deliberately
  // drops the console logger, so every record lands in `.alchemy/log/out`
  // and nothing reaches stderr — which is how a stalled deploy produced ten
  // minutes of `--log-level debug` and zero bytes of output (#1231). Re-add
  // a console sink for that run only. With telemetry off the default
  // console logger is still in the set, and adding a second would
  // double-print every line.
  const askedForLogs = Option.isSome(
    Option.flatten(yield* Effect.serviceOption(GlobalFlag.LogLevel)),
  );
  const consoleSink =
    askedForLogs && !(yield* isTelemetryDisabled)
      ? [Logger.consolePretty()]
      : [];

  const services = Layer.mergeAll(
    Layer.effect(
      AlchemyContext,
      AlchemyContext.pipe(
        Effect.map((ctx) => ({
          ...ctx,
          dev,
          adopt,
          // `--yes` also auto-accepts (and performs) an out-of-date state
          // store upgrade, instead of prompting.
          updateStateStore: yes,
        })),
      ),
    ),
    // `--adopt` opts the entire deploy in to adoption-on-conflict.
    // Resource providers that wire `AdoptPolicy` (Worker domains,
    // Cloudflare.SecretsStore, etc.) will reconcile against
    // pre-existing cloud resources instead of failing on duplicates.
    // Default is `false` so an unintentional collision still surfaces
    // loudly.
    Layer.succeed(AdoptPolicy, adopt),
    Layer.succeed(ArtifactStore, createArtifactStore()),
    Layer.succeed(
      AuthProviders,
      yield* Effect.serviceOption(AuthProviders).pipe(
        Effect.map(Option.getOrElse(() => ({}))),
      ),
    ),
    ConfigProvider.layer(
      withProfileOverride(yield* loadConfigProvider(envFile), profile),
    ),
    Logger.layer([fileLogger("out"), ...consoleSink], {
      mergeWithExisting: true,
    }),
    Layer.succeed(Stage, stage),
  );

  yield* Effect.gen(function* () {
    const cli = yield* CLI.Cli;
    const stack = yield* stackEffect;

    yield* Effect.gen(function* () {
      const updatePlan = destroy
        ? yield* Plan.destroy(stack)
        : yield* Plan.make(stack, { force });
      if (dryRun) {
        yield* cli.displayPlan(updatePlan);
      } else {
        const hasChanges =
          Object.keys(updatePlan.deletions).length > 0 ||
          Object.values(updatePlan.resources).some(
            (node) =>
              node.action !== "noop" ||
              node.bindings.some((b) => b.action !== "noop"),
          );
        if (!yes && hasChanges) {
          const approved = yield* cli.approvePlan(updatePlan);
          if (!approved) {
            return;
          }
        }
        // Smoke-test kill switch: `ALCHEMY_DEV_ONCE=1 alchemy dev` exits after
        // the first apply instead of keeping the dev session alive — apply
        // failures propagate (non-zero exit) instead of being swallowed, so
        // scripts and CI can assert "dev deploys cleanly" without a timeout.
        const devOnce =
          dev &&
          (process.env.ALCHEMY_DEV_ONCE === "1" ||
            process.env.ALCHEMY_DEV_ONCE === "true");
        // In dev, a failed apply must not drain the keep-alive below:
        // `alchemy dev` runs under `bun --watch`, which cancels watch mode
        // entirely on a clean exit (oven-sh/bun#10983), so completing here
        // would tear down every healthy local resource along with the failed
        // one. Swallow apply failures (logging the full cause, since the TUI
        // renderer only shows the failure status) so the keep-alive engages
        // and the rest of the stack keeps serving, but re-propagate a pure
        // interruption (Ctrl-C / fiber kill) so dev still shuts down cleanly.
        const applyPlan =
          dev && !devOnce
            ? apply(updatePlan).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Console.error(
                        `alchemy dev: apply failed; keeping dev alive so healthy resources keep serving.\n${Cause.pretty(cause)}`,
                      ).pipe(Effect.as(undefined)),
                ),
              )
            : apply(updatePlan);
        const outputs = yield* applyPlan;

        if (outputs !== undefined) {
          yield* Console.log(outputs);
        }

        if (dev) {
          if (devOnce) {
            return;
          }
          return yield* Effect.never;
        }
      }
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

// In dev, failures OUTSIDE the apply guard above must not exit the process
// either: the user saves mid-edit states where importing the stack module
// itself throws (missing export, module-evaluation crash), or planning fails
// against the half-edited program. Those failures escape `runStack` before
// the apply-level guard exists, and exiting here kills the `--watch` session
// (oven-sh/bun#10983), so dev would stop reloading on subsequent saves. Log
// the cause and park forever; the watcher restarts the run on the next file
// change. Pure interruption (Ctrl-C / fiber kill) still propagates so dev
// shuts down cleanly.
export const devKeepAlive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Console.error(
            `alchemy dev: run failed; waiting for the next file change to retry.\n${Cause.pretty(cause)}`,
          ).pipe(Effect.andThen(Effect.never)),
    ),
  );

export const execStack = (options: ExecStackOptions) =>
  options.dev ? devKeepAlive(runStack(options)) : runStack(options);

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    main: script,
    envFile,
    stage,
    yes,
    profile,
    adopt,
  },
  instrumentCommand("deploy", stackSpanAttrs)(execStack),
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
    main: script,
    envFile,
    stage,
    yes,
    profile,
  },
  instrumentCommand(
    "destroy",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      destroy: true,
    }),
  ),
);

export const planCommand = Command.make(
  "plan",
  {
    main: script,
    envFile,
    stage,
    profile,
  },
  instrumentCommand(
    "plan",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
  ),
);
