import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildKimiDiscoveredModelsFromConfigOptions } from "./KimiProvider.ts";

describe("buildKimiDiscoveredModelsFromConfigOptions", () => {
  it("maps model and thinking config options into provider models", () => {
    const configOptions = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "kimi-code/k3",
        options: [
          { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
          { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
          { value: "kimi-code/k3", name: "K3" },
        ],
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      },
    ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    const models = buildKimiDiscoveredModelsFromConfigOptions(configOptions);
    expect(models.map((model) => model.slug)).toEqual([
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
      "kimi-code/k3",
    ]);

    const k3 = models.find((model) => model.slug === "kimi-code/k3");
    expect(k3?.name).toBe("K3");
    const reasoning = k3?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort",
    );
    expect(reasoning?.type).toBe("select");
    if (reasoning?.type === "select") {
      expect(reasoning.options.map((option) => option.id)).toEqual(["low", "high", "max"]);
    }

    const coding = models.find((model) => model.slug === "kimi-code/kimi-for-coding");
    expect(coding?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });
});
