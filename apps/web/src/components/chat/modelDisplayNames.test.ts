import { describe, expect, it } from "vite-plus/test";

import { getDisplayModelName, getTriggerDisplayModelName } from "./modelDisplayNames";

describe("getDisplayModelName", () => {
  it("removes a redundant sub-provider qualifier", () => {
    expect(
      getDisplayModelName({
        slug: "openai/gpt-5.6-sol",
        name: "OpenAI: GPT-5.6-Sol",
        subProvider: "OpenAI",
      }),
    ).toBe("GPT-5.6-Sol");
  });

  it("uses provider-authored short names for the picker trigger", () => {
    expect(
      getTriggerDisplayModelName({
        slug: "gpt-5.5",
        name: "GPT-5.5",
        shortName: "5.5",
      }),
    ).toBe("5.5");
  });

  it("does not rewrite provider or user-authored model names", () => {
    expect(
      getTriggerDisplayModelName({
        slug: "GPT-5.6-My_Model",
        name: "GPT-5.6-My_Model",
      }),
    ).toBe("GPT-5.6-My_Model");
    expect(
      getTriggerDisplayModelName({
        slug: "cursor-claude-sonnet-5",
        name: "Claude Sonnet 5",
      }),
    ).toBe("Claude Sonnet 5");
  });
});
