import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildKimiDiscoveredModelsFromConfigOptions,
  kimiContextWindowForModel,
  kimiTokenUsageSnapshotFromAcpUsage,
} from "./KimiProvider.ts";

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

  it("falls back to K3 effort levels when the session's current model only advertises on/off thinking", () => {
    // Mirrors the real kimi CLI (0.29.0): ACP sessions start on
    // kimi-code/kimi-for-coding, whose thinking option only advertises "on".
    // K3 must still expose low/high/max.
    const configOptions = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "kimi-code/kimi-for-coding",
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
        currentValue: "on",
        options: [{ value: "on", name: "On" }],
      },
    ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    const models = buildKimiDiscoveredModelsFromConfigOptions(configOptions);

    const k3 = models.find((model) => model.slug === "kimi-code/k3");
    const reasoning = k3?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort",
    );
    expect(reasoning?.type).toBe("select");
    if (reasoning?.type === "select") {
      expect(reasoning.options.map((option) => option.id)).toEqual(["low", "high", "max"]);
    }
  });
});

describe("kimiContextWindowForModel", () => {
  it("returns the documented window for built-in models and undefined for unknown slugs", () => {
    expect(kimiContextWindowForModel("kimi-code/k3")).toBe(1_048_576);
    expect(kimiContextWindowForModel("kimi-code/kimi-for-coding")).toBe(262_144);
    expect(kimiContextWindowForModel("kimi-code/kimi-for-coding-highspeed")).toBe(262_144);
    expect(kimiContextWindowForModel("custom-model")).toBeUndefined();
    expect(kimiContextWindowForModel(undefined)).toBeUndefined();
  });
});

describe("kimiTokenUsageSnapshotFromAcpUsage", () => {
  const usage: EffectAcpSchema.Usage = {
    inputTokens: 40_000,
    outputTokens: 8_000,
    totalTokens: 48_000,
    cachedReadTokens: 12_000,
    cachedWriteTokens: 4_000,
    thoughtTokens: 1_500,
  };

  it("maps ACP turn usage into the shared snapshot with the model window limit", () => {
    expect(kimiTokenUsageSnapshotFromAcpUsage(usage, "kimi-code/k3")).toEqual({
      usedTokens: 48_000,
      maxTokens: 1_048_576,
      inputTokens: 40_000,
      cachedInputTokens: 12_000,
      cacheReadInputTokens: 12_000,
      cacheCreationInputTokens: 4_000,
      outputTokens: 8_000,
      reasoningOutputTokens: 1_500,
      accountingStatus: "provider-reported",
    });
  });

  it("omits maxTokens for unknown models so clients fall back to a raw token count", () => {
    const snapshot = kimiTokenUsageSnapshotFromAcpUsage(usage, "custom-model");
    expect(snapshot?.usedTokens).toBe(48_000);
    expect(snapshot?.maxTokens).toBeUndefined();
  });

  it("returns undefined for missing or empty usage", () => {
    expect(kimiTokenUsageSnapshotFromAcpUsage(undefined, "kimi-code/k3")).toBeUndefined();
    expect(kimiTokenUsageSnapshotFromAcpUsage(null, "kimi-code/k3")).toBeUndefined();
    expect(
      kimiTokenUsageSnapshotFromAcpUsage(
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        "kimi-code/k3",
      ),
    ).toBeUndefined();
  });
});
