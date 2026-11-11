import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { setExitCode } from "./errors.ts";

export const compatibilityCommands = {
  login: "alchemy profile",
  tail: "alchemy logs --tail",
  sync: "alchemy drift --repair",
  aws: "alchemy provider aws",
  cloudflare: "alchemy provider cloudflare",
  prisma: "alchemy provider prisma",
} as const;

export type CompatibilityCommand = keyof typeof compatibilityCommands;

/**
 * An unlisted command that only points at its replacement and exits 1, so a
 * script still invoking the old command fails loudly instead of silently
 * doing nothing.
 */
export const movedCommand = (name: string, path: string, replacement: string) =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      yield* Console.error(`The \`${path}\` command has been moved.`);
      yield* Console.error(`Run \`${replacement}\` instead.`);
      yield* setExitCode(1);
    }),
  ).pipe(Command.unlisted);

export const compatibilityCommand = (name: CompatibilityCommand) =>
  movedCommand(name, `alchemy ${name}`, compatibilityCommands[name]);
