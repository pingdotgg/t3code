import { describe, expect, it } from "vite-plus/test";
import { getModelSourceLabel, getTriggerDisplayModelLabel } from "./providerIconUtils";

describe("model provider display labels", () => {
  it("qualifies a multi-provider model in the picker trigger", () => {
    expect(
      getTriggerDisplayModelLabel({
        slug: "openai/gpt-5.4",
        name: "OpenAI: GPT-5.4",
        shortName: "GPT-5.4",
        subProvider: "OpenAI",
      }),
    ).toBe("GPT-5.4 · OpenAI");
  });

  it("describes the model source in terms of its runtime", () => {
    expect(
      getModelSourceLabel(
        {
          slug: "openai/gpt-5.4",
          name: "GPT-5.4",
          subProvider: "OpenAI",
        },
        "OpenCode",
      ),
    ).toBe("OpenCode · OpenAI");
  });

  it("leaves models without a sub-provider unchanged", () => {
    const model = { slug: "gpt-5.4", name: "GPT-5.4" };

    expect(getTriggerDisplayModelLabel(model)).toBe("GPT-5.4");
    expect(getModelSourceLabel(model, "Codex")).toBe("Codex");
  });
});
