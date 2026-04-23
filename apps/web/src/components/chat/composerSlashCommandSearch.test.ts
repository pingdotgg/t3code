import { describe, expect, it } from "vitest";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "local-slash-command:.agents/commands/ui.md",
        type: "local-slash-command",
        command: {
          name: "ui",
          path: ".agents/commands/ui.md",
          scope: "project",
          source: "local-agents",
        },
        label: "/ui",
        description: "Project UI workflow",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "local-slash-command" | "provider-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "local-slash-command:.agents/commands/ui.md",
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "local-slash-command:.agents/commands/github.md",
        type: "local-slash-command",
        command: {
          name: "github",
          path: ".agents/commands/github.md",
          scope: "project",
          source: "local-agents",
        },
        label: "/github",
        description: "Project GitHub workflow",
      },
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "local-slash-command" | "provider-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });
});
