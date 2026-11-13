import { expect, it } from "@effect/vitest";
import type { Command } from "effect/cli";

import { makeCli } from "../binCli.ts";
import { T3_CLI_COMMANDS } from "../feedback/FeedbackReport.ts";

const listedPaths = (command: Command.Command.Any, path: string): ReadonlyArray<string> => [
  path,
  ...command.subcommands.flatMap((group) =>
    group.commands
      .filter((child) => !child.unlisted)
      .flatMap((child) => listedPaths(child, `${path} ${child.name}`)),
  ),
];

it("feedback subjects name every listed t3 command", () => {
  expect([...T3_CLI_COMMANDS].sort()).toEqual(
    [...listedPaths(makeCli({ cloudEnabled: true }), "t3")].sort(),
  );
});
