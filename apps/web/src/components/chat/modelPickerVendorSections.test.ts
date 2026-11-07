import { describe, expect, it } from "vite-plus/test";
import { groupModelPickerVendors } from "./modelPickerVendorSections";

const model = (slug: string, subProvider?: string) => ({
  slug,
  ...(subProvider ? { subProvider } : {}),
});

describe("groupModelPickerVendors", () => {
  it("folds a multi-vendor catalog into sorted vendor sections and keeps pinned models above them", () => {
    const grouped = groupModelPickerVendors(
      [
        model("zen/big-pickle", "OpenCode Zen"),
        model("anthropic/claude-sonnet", "Anthropic"),
        model("custom"),
        model("openai/gpt", "openai"),
        model("anthropic/claude-opus", "Anthropic"),
      ],
      (candidate) => candidate.slug === "anthropic/claude-opus",
      undefined,
    );

    expect(grouped).toEqual({
      pinned: [model("custom"), model("anthropic/claude-opus", "Anthropic")],
      sections: [
        { vendor: "Anthropic", models: [model("anthropic/claude-sonnet", "Anthropic")] },
        { vendor: "openai", models: [model("openai/gpt", "openai")] },
        { vendor: "OpenCode Zen", models: [model("zen/big-pickle", "OpenCode Zen")] },
      ],
      defaultVendor: "Anthropic",
    });
  });

  it("keeps the preferred vendor open after its model is pinned", () => {
    const models = [
      model("a/sonnet", "Anthropic"),
      model("o/pro", "OpenAI"),
      model("o/mini", "OpenAI"),
    ];

    expect(
      groupModelPickerVendors(models, (candidate) => candidate.slug === "o/pro", "OpenAI")
        ?.defaultVendor,
    ).toBe("OpenAI");
  });

  it("leaves a single-vendor catalog as a plain list", () => {
    expect(
      groupModelPickerVendors(
        [model("a", "Anthropic"), model("b", "Anthropic"), model("c")],
        () => false,
        "Anthropic",
      ),
    ).toBeNull();
  });
});
