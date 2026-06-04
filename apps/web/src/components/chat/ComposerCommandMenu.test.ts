import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { groupCommandItems } from "./composerCommandMenuGroups";

describe("groupCommandItems", () => {
  it("groups provider skills in slash command suggestions", () => {
    const codexDriver = ProviderDriverKind.make("codex");
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model for this thread",
      },
      {
        id: "provider-slash-command:codex:status",
        type: "provider-slash-command",
        provider: codexDriver,
        command: { name: "status" },
        label: "/status",
        description: "Show provider status",
      },
      {
        id: "skill:codex:create-staging-pr",
        type: "skill",
        provider: codexDriver,
        skill: {
          name: "create-staging-pr",
          path: "/workspace/.agents/skills/create-staging-pr/SKILL.md",
          enabled: true,
          shortDescription: "Create PR to staging",
        },
        label: "Create Staging PR",
        description: "Create PR to staging",
      },
    ] satisfies ComposerCommandItem[];

    expect(groupCommandItems(items, "slash-command", true).map((group) => group.label)).toEqual([
      "Built-in",
      "Provider",
      "Skills",
    ]);
  });
});
