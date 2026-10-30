import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

function providerCommand(name: string, driver = "claudeAgent") {
  return {
    id: `${driver}:${name}`,
    type: "provider-slash-command",
    provider: ProviderDriverKind.make(driver),
    command: { name },
    label: `/${name}`,
    description: "",
  } satisfies ComposerCommandItem;
}

describe("slashCommandItemsForPromptPosition", () => {
  it.each(["code-review", "simplify", "run"])(
    "offers Claude's /%s skill after other text",
    (name) => {
      const item = providerCommand(name);
      const items = slashCommandItemsForPromptPosition([item], false);
      expect(searchSlashCommandItems(items, name.slice(0, 3))).toEqual([item]);
    },
  );

  it("keeps user-only and unknown provider commands at the prompt start", () => {
    const items = ["compact", "verify", "team-onboarding", "unknown-command"].map((name) =>
      providerCommand(name),
    );
    expect(slashCommandItemsForPromptPosition(items, false)).toEqual([]);
    expect(slashCommandItemsForPromptPosition(items, true)).toEqual(items);
  });

  it.each(["codex", "opencode", "cursor", "antigravity", "grok"])(
    "does not treat %s commands as Claude skills",
    (driver) => {
      expect(slashCommandItemsForPromptPosition([providerCommand("run", driver)], false)).toEqual(
        [],
      );
    },
  );

  it("preserves local T3 commands and discovered skills after other text", () => {
    const items = [
      {
        id: "model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      {
        id: "personal-skill",
        type: "skill",
        provider: ProviderDriverKind.make("claudeAgent"),
        skill: { name: "personal-skill", path: "/skills/personal/SKILL.md", enabled: true },
        label: "/skill:personal-skill",
        description: "",
      },
    ] satisfies ComposerCommandItem[];
    expect(slashCommandItemsForPromptPosition(items, false)).toEqual(items);
  });
});
