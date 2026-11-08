import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { expandGoalSubcommands, searchSlashCommandItems } from "./composerSlashCommandSearch";

const goal: Extract<ComposerCommandItem, { type: "provider-slash-command" }> = {
  id: "provider-slash-command:codex:goal",
  type: "provider-slash-command",
  provider: ProviderDriverKind.make("codex"),
  command: { name: "goal" },
  label: "/goal",
  description: "Set a goal",
};

describe("goal subcommand completion", () => {
  it("only offers native Claude goal commands", () => {
    const items = expandGoalSubcommands(
      [{ ...goal, provider: ProviderDriverKind.make("claudeAgent") }],
      "goal",
      "Fix it",
    );
    expect(items.map((item) => item.label)).toEqual(["/goal", "/goal edit", "/goal clear"]);
  });

  it("does not assume another provider implements Codex goal commands", () => {
    const other = { ...goal, provider: ProviderDriverKind.make("opencode") };
    expect(expandGoalSubcommands([other], "goal", "Fix it")).toEqual([other]);
  });

  it("waits for the full goal command and omits edit when no goal is set", () => {
    expect(expandGoalSubcommands([goal], "go", "Fix it")).toEqual([goal]);
    expect(expandGoalSubcommands([goal], "goal", null).map((item) => item.label)).not.toContain(
      "/goal edit",
    );
  });

  it.each(["goal r", "goal  r", "goal\tr", "GOAL R"])("completes %j", (query) => {
    const items = expandGoalSubcommands([goal], query, "Fix the tests");
    expect(searchSlashCommandItems(items, query).map((item) => item.label)).toEqual([
      "/goal resume",
    ]);
  });

  it("fills the current objective when editing", () => {
    const items = expandGoalSubcommands([goal], "goal", "Fix the tests");
    expect(items.find((item) => item.label === "/goal edit")).toMatchObject({
      replacementText: "/goal Fix the tests",
    });
  });
});
