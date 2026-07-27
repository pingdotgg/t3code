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

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { apply } from "../../Apply.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CLI from "../../Cli/Cli.ts";
import * as Plan from "../../Plan.ts";
import { Stage } from "../../Stage.ts";
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

export const execStack = Effect.fn(function* ({
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
    Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
    Layer.succeed(Stage, stage),
  );

  yield* Effect.gen(function* () {
    const cli = yield* CLI.Cli;
    const stack = yield* stackEffect;

    yield* Effect.gen(function* () {
      const updatePlan = yield* Plan.make(
        destroy
          ? {
              ...stack,
              // zero these out (destroy will treat all as orphans)
              // TODO(sam): probably better to have Plan.destroy and Plan.update
              resources: {},
              bindings: {},
              actions: {},
              output: {},
            }
          : stack,
        { force },
      );
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
        // In dev, a failed apply must not drain the keep-alive below:
        // `alchemy dev` runs under `bun --watch`, which cancels watch mode
        // entirely on a clean exit (oven-sh/bun#10983), so completing here
        // would tear down every healthy local resource along with the failed
        // one. Swallow apply failures (logging the full cause, since the TUI
        // renderer only shows the failure status) so the keep-alive engages
        // and the rest of the stack keeps serving, but re-propagate a pure
        // interruption (Ctrl-C / fiber kill) so dev still shuts down cleanly.
        const applyPlan = dev
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
          return yield* Effect.never;
        }
      }
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

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
