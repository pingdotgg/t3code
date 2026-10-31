import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const describePolicy = (policy: ManagedPolicy.ManagedPolicy["Service"]) => {
  const { document } = policy;
  if (document === undefined) {
    return "No managed policy on this machine. Every setting belongs to the user.\n";
  }
  const settings = Object.entries(document.settings ?? {});
  const lines = [
    `Managed by ${document.organization} (${policy.path}).`,
    ...(document.supportUrl === undefined ? [] : [`Support: ${document.supportUrl}`]),
    "",
    settings.length === 0 ? "No managed settings." : "Settings:",
    ...settings.map(
      ([path, setting]) =>
        `  ${path} = ${JSON.stringify(setting.value)} (${setting.locked ? "locked" : "default"})`,
    ),
  ];
  if (document.limits !== undefined) {
    lines.push("", "Limits:", JSON.stringify(document.limits, null, 2));
  }
  return `${lines.join("\n")}\n`;
};

const showCommand = Command.make("show").pipe(
  Command.withDescription("Show the policy that applies to T3 Code on this machine."),
  Command.withHandler(() =>
    ManagedPolicy.ManagedPolicy.pipe(
      Effect.flatMap((policy) => Console.log(describePolicy(policy))),
      Effect.provide(ManagedPolicy.layer),
    ),
  ),
);

const checkCommand = Command.make("check", {
  file: Argument.String("file").pipe(Argument.withDescription("Policy file to validate.")),
}).pipe(
  Command.withDescription("Validate a policy file before deploying it."),
  Command.withHandler(
    Effect.fn("cli.policy.check")(function* ({ file }) {
      // Startup treats a missing file as no policy; a draft that is not there checks nothing.
      if (!(yield* (yield* FileSystem.FileSystem).exists(file))) {
        return yield* new CliError.UserError({
          cause: file,
          userMessage: `No policy file at ${file}.`,
        });
      }
      yield* Console.log(describePolicy(yield* ManagedPolicy.load(file)));
    }),
  ),
);

export const policyCommand = Command.make("policy").pipe(
  Command.withDescription("Inspect the administrator's managed policy."),
  Command.withSubcommands([showCommand, checkCommand]),
);
