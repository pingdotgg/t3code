import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import { setExitCode } from "./errors.ts";

export const compatibilityCommands = {
  login: "alchemy profile",
  tail: "alchemy logs --tail",
  sync: "alchemy drift --repair",
  aws: "alchemy provider aws",
  cloudflare: "alchemy provider cloudflare",
} as const;

export type CompatibilityCommand = keyof typeof compatibilityCommands;

export const compatibilityCommand = (name: CompatibilityCommand) =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      yield* Console.error(`The \`alchemy ${name}\` command has been moved.`);
      yield* Console.error(`Run \`${compatibilityCommands[name]}\` instead.`);
      // Exit non-zero: a CI script still invoking the old command must fail
      // loudly, not "succeed" while doing nothing.
      yield* setExitCode(1);
    }),
  ).pipe(Command.unlisted);
