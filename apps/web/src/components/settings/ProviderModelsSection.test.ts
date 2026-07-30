import { describe, expect, it } from "vite-plus/test";

import { modelRowPrimaryText, nextCustomModelLabels } from "./ProviderModelsSection";

describe("nextCustomModelLabels", () => {
  it("sets, updates, and clears labels without mutating the source map", () => {
    const base = { "model-a": "Label A" };
    const withB = nextCustomModelLabels(base, "model-b", "Label B");
    expect(withB).toEqual({ "model-a": "Label A", "model-b": "Label B" });
    expect(base).toEqual({ "model-a": "Label A" });

    const cleared = nextCustomModelLabels(withB, "model-a", "   ");
    expect(cleared).toEqual({ "model-b": "Label B" });
  });

  it("composes sequential edits from the previous result (blur race)", () => {
    let labels: Readonly<Record<string, string>> = {};
    labels = nextCustomModelLabels(labels, "model-a", "Label A");
    labels = nextCustomModelLabels(labels, "model-b", "Label B");
    expect(labels).toEqual({
      "model-a": "Label A",
      "model-b": "Label B",
    });
  });
});

describe("modelRowPrimaryText", () => {
  it("keeps the API slug visible for custom models", () => {
    expect(
      modelRowPrimaryText({
        slug: "gpt-custom-ultra",
        name: "Ultra Preview",
        isCustom: true,
      }),
    ).toBe("gpt-custom-ultra");
  });

  it("uses the display name for built-in models", () => {
    expect(
      modelRowPrimaryText({
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
      }),
    ).toBe("GPT-5.4");
  });
});
