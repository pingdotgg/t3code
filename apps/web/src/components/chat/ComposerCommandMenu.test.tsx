import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";
import {
  slashCommandItemsForPromptPosition,
  searchSlashCommandItems,
} from "./composerSlashCommandSearch";

import { composerSuggestionOptionId } from "./ComposerCommandMenu";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

it("offers advertised skills inline while restricting ordinary provider commands", () => {
  const items = ["skill:logo-archive", "compact"].map((name) => ({
    id: name,
    type: "provider-slash-command" as const,
    provider: ProviderDriverKind.make("acpRegistry"),
    command: { name },
    label: `/${name}`,
    description: "",
  }));
  expect(slashCommandItemsForPromptPosition(items, true)).toEqual(items);
  const inline = slashCommandItemsForPromptPosition(items, false);
  expect(inline.map((item) => item.id)).toEqual(["skill:logo-archive"]);
  expect(searchSlashCommandItems(inline, "skill:logo").map((item) => item.id)).toEqual([
    "skill:logo-archive",
  ]);
});
