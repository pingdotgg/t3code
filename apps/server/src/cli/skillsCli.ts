import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/**
 * `t3 skills-cli <args…>` runs the bundled `skills` CLI (vercel-labs/skills),
 * the installer `npx skills` runs. The server spawns it through this hidden
 * subcommand so installs need no Node or npm of their own: the CLI is part of
 * this build, and runs as a child so its `process.exit` and prompts stay out
 * of the server.
 */
export async function runSkillsCli(args: ReadonlyArray<string>): Promise<void> {
  // The CLI reads its command from argv[2] onward.
  process.argv = [process.argv[0] ?? "node", "skills", ...args];
  await import("skills/dist/cli.mjs");
}

/** Real invocations dispatch through the bin.ts fast path before the CLI graph loads. */
export const skillsCliCommand = Command.make("skills-cli", {
  args: Argument.String("args").pipe(Argument.variadic()),
}).pipe(
  Command.withDescription("Run the bundled skills installer."),
  Command.unlisted,
  Command.withHandler(({ args }) => Effect.promise(() => runSkillsCli(args))),
);
