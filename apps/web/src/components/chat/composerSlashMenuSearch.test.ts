import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type SnippetId } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashMenuItems } from "./composerSlashMenuSearch";

describe("searchSlashMenuItems", () => {
  it("ranks matching snippets together with provider commands", () => {
    const items = [
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch to plan mode",
      },
      {
        id: "provider-slash-command:claudeAgent:plan",
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("claudeAgent"),
        command: { name: "plan" },
        label: "/plan",
        description: "Plan the work",
      },
      {
        id: "saved-snippet:plan",
        type: "saved-snippet",
        snippet: {
          id: "plan" as SnippetId,
          title: "Plan this",
          body: "Plan this work.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        label: "/plan",
        description: "Plan this",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "provider-slash-command" | "saved-snippet" }
      >
    >;

    expect(searchSlashMenuItems(items, "plan").map((item) => item.id)).toEqual([
      "saved-snippet:plan",
      "slash:plan",
      "provider-slash-command:claudeAgent:plan",
    ]);
  });
});
