import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import { AdoptPolicy } from "../../AdoptPolicy.ts";
import { ArtifactStore, createArtifactStore } from "../../Artifacts.ts";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CLI from "../../Cli/Cli.ts";
import { Stage } from "../../Stage.ts";
import * as Sync from "../../Sync.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  stage,
  yes,
} from "./_shared.ts";

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription(
    "Detect and report drift without repairing it (no reconcile, no state writes)",
  ),
  Flag.withDefault(false),
);

export interface SyncArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export const execSync = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  dryRun = false,
  yes = false,
}: SyncArgs) {
  const stackEffect = yield* importStack(main);

  const services = Layer.mergeAll(
    Layer.succeed(AdoptPolicy, false),
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
      // Detection pass: project the drift onto the engine's Plan shape so
      // the CLI renders a sync exactly like a deploy plan (ink TUI when
      // interactive, plain logging otherwise).
      const { result, plan } = yield* Sync.plan({
        name: stack.name,
        stage: stack.stage,
      });

      if (dryRun) {
        yield* cli.displayPlan(plan);
        return;
      }

      const hasChanges = Object.values(result.resources).some(
        (r) => r.action === "drifted" || r.action === "missing",
      );
      if (!yes && hasChanges) {
        const approved = yield* cli.approvePlan(plan);
        if (!approved) {
          return;
        }
      }

      // Repair pass: re-observes the cloud (rather than trusting the
      // detection snapshot) and reports progress through the session.
      const session = yield* cli.startApplySession(plan);
      yield* Sync.sync({ name: stack.name, stage: stack.stage }, { session });
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(services));
});

export const syncCommand = Command.make(
  "sync",
  {
    dryRun: dryRunFlag,
    main: script,
    envFile,
    stage,
    yes,
    profile,
  },
  instrumentCommand("sync", (args: SyncArgs) => ({
    "alchemy.stage": args.stage,
    "alchemy.profile": args.profile,
    "alchemy.main": args.main,
    "alchemy.dry_run": !!args.dryRun,
  }))(execSync),
);
