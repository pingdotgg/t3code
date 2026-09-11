import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getDevinModelProviderBrand, getModelProviderBrand } from "./providerIconUtils";

describe("Devin model provider brands", () => {
  it.each([
    ["claude-opus-5", "Claude Opus 5", "Anthropic"],
    ["gpt-5-6-luna", "GPT-5.6 Luna", "OpenAI"],
    ["gemini-3-7-flash", "Gemini 3.7 Flash", "Google"],
    ["glm-5-2", "GLM-5.2", "Z.ai"],
    ["kimi-k3", "Kimi K3", "Moonshot AI"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek"],
    ["grok-4-6", "Grok 4.6", "xAI"],
    ["nemotron-3-ultra", "Nemotron 3 Ultra", "NVIDIA"],
    ["swe-1-7", "SWE-1.7", "Cognition"],
  ])("maps %s to %s", (slug, name, expected) => {
    expect(getDevinModelProviderBrand({ slug, name }).label).toBe(expected);
  });

  it("falls back to Devin for an unknown Devin model", () => {
    expect(getDevinModelProviderBrand({ slug: "future-model", name: "Future Model" }).label).toBe(
      "Devin",
    );
  });

  it("keeps normal provider branding outside Devin", () => {
    expect(
      getModelProviderBrand(ProviderDriverKind.make("codex"), {
        slug: "gpt-5.6",
        name: "GPT-5.6",
      }).label,
    ).toBe("Codex");
  });
});
