import { describe, expect, it } from "vite-plus/test";

import { groupModelsBySubProvider } from "./modelPickerGroups";

const model = (slug: string, subProvider?: string) => ({
  slug,
  ...(subProvider ? { subProvider } : {}),
});

describe("groupModelsBySubProvider", () => {
  it("keeps a flat list when the models span fewer than two sub-providers", () => {
    expect(groupModelsBySubProvider([model("a"), model("b")], () => false)).toBeNull();
    expect(
      groupModelsBySubProvider(
        [model("default"), model("a", "openai"), model("b", "openai")],
        () => false,
      ),
    ).toBeNull();
  });

  it("groups by sub-provider name and keeps ungrouped and pinned models on top", () => {
    const grouped = groupModelsBySubProvider(
      [
        model("default"),
        model("gpt", "openai"),
        model("opus", "anthropic"),
        model("codex", "openai"),
        model("sonnet", "anthropic"),
      ],
      (candidate) => candidate.slug === "codex",
    );

    expect(grouped?.pinned.map((entry) => entry.slug)).toEqual(["default", "codex"]);
    expect(
      grouped?.groups.map((group) => [group.subProvider, group.models.map((entry) => entry.slug)]),
    ).toEqual([
      ["anthropic", ["opus", "sonnet"]],
      ["openai", ["gpt"]],
    ]);
  });
});
