import { plainCliFormatter } from "@/Cli/PlainCliFormatter.ts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { expect, it } from "alchemy-test";

it("compacts enum flag types and bounds every line", () => {
  const output = plainCliFormatter({ columns: 80 }).formatHelpDoc({
    description:
      "Define, deploy, and operate cloud infrastructure with type-safe Effect programs. " +
      "This description is deliberately long enough that the default formatter would " +
      "emit a line wider than eighty columns without wrapping.",
    usage: "alchemy <subcommand> [flags]",
    annotations: Context.empty(),
    flags: [],
    globalFlags: [
      {
        name: "log-level",
        aliases: [],
        type: "all|trace|debug|info|warn|warning|error|fatal|none",
        description: Option.some(
          "Sets the minimum log level for every command and provider.",
        ),
        required: false,
      },
    ],
    subcommands: [
      {
        group: undefined,
        commands: [
          {
            name: "deploy",
            alias: undefined,
            shortDescription: "Deploy a stack",
            description: "Deploy a stack",
          },
        ],
      },
    ],
    examples: [{ command: "alchemy deploy" }],
  });

  // The nine-choice enum must not widen the flag column.
  expect(output).toContain("--log-level all|trace|…");
  for (const line of output.split("\n")) {
    expect(line.length <= 80).toBe(true);
  }
});
