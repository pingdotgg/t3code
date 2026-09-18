import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import * as Drift from "../../Alchemist/routes/drift.ts";
import { Cli } from "../../Report.ts";
import * as CliKit from "../CliKit/index.ts";
import { planDecisionScreen } from "../components/view/PlanDecision.tsx";

import { config, envFile, profile, resolveStage, stage } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";
import { renderApply, renderPlanning } from "./render.ts";

const repairFlag = Flag.Boolean("repair").pipe(
  Flag.withDescription("Repair detected drift without prompting"),
  Flag.withDefault(false),
);

interface SyncArgs {
  main: string;
  stage: string;
  envFile: Option.Option<string>;
  profile?: string;
  repair?: boolean;
}

const routeDrift = Effect.fn(function* ({
  main,
  stage,
  envFile,
  profile,
  repair = false,
}: SyncArgs) {
  const cli = yield* Cli;
  const snapshot = yield* Drift.inspect({
    entrypoint: main,
    stage,
    profile,
    envFile: Option.getOrUndefined(envFile),
  }).pipe(
    renderPlanning({
      operation: "Drift",
      stage,
      computingLabel: "Checking drift",
      readyLabel: "Drift check complete",
    }),
  );
  if (!Drift.hasDrift(snapshot)) {
    return yield* cli.displayPlan(snapshot.repairPlan.native);
  }

  if (!repair) {
    const terminal = yield* CliKit.CliKit;
    if (!terminal.terminal.input) {
      return yield* cli.displayPlan(snapshot.repairPlan.native);
    }
    const decision = yield* terminal.prompt
      .custom(
        planDecisionScreen({
          plan: snapshot.repairPlan.native,
          message: "Drift detected",
          choices: [
            {
              value: "repair" as const,
              label: "Repair",
            },
            {
              value: "cancel" as const,
              label: "Cancel",
            },
          ],
          initialValue: "cancel" as const,
        }),
      )
      .pipe(
        Effect.catchTag("TerminalCancelled", () =>
          Effect.succeed("cancel" as const),
        ),
      );
    if (decision === "cancel") return;
  }

  yield* Drift.repair(snapshot).pipe(renderApply(snapshot.repairPlan.native));
});

export const driftCommand = Command.make(
  "drift",
  {
    repair: repairFlag,
    main: config,
    envFile,
    stage,
    profile,
  },
  (args) =>
    resolveStage("live", args.stage, args.envFile).pipe(
      Effect.flatMap((stage) =>
        instrumentCommand("drift", (a: SyncArgs & { repair: boolean }) => ({
          "alchemy.stage": a.stage,
          "alchemy.profile": a.profile,
          "alchemy.main": a.main,
          "alchemy.repair": a.repair,
        }))((resolved) => routeDrift(resolved))({ ...args, stage }),
      ),
    ),
).pipe(Command.withDescription("Detect infrastructure drift"));
