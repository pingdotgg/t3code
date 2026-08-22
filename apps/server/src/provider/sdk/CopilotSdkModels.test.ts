import { describe, expect, it } from "vite-plus/test";
import type { ModelInfo } from "@github/copilot-sdk";

import {
  buildCopilotSdkModelCapabilities,
  buildCopilotSdkModels,
  modelSupportsLongContext,
  resolveCopilotSdkTunables,
} from "./CopilotSdkModels.ts";

// Fixtures modeled on real `client.listModels()` output (Copilot CLI 1.0.80):
// a reasoning + long-context model, a reasoning-but-no-long-context model, a
// plain model with neither lever, and a disabled model.
const sonnet5 = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 1_000_000 },
  },
  billing: { tokenPrices: { longContext: { contextMax: 936_000 } } },
  policy: { state: "enabled", terms: "" },
} as unknown as ModelInfo;

const sonnet45 = {
  id: "claude-sonnet-4.5",
  name: "Claude Sonnet 4.5",
  capabilities: {
    supports: { vision: true, reasoningEffort: false },
    limits: { max_context_window_tokens: 144_000 },
  },
  billing: { tokenPrices: {} },
  policy: { state: "enabled", terms: "" },
} as unknown as ModelInfo;

const disabledModel = {
  id: "legacy-model",
  name: "Legacy",
  capabilities: {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 0 },
  },
  policy: { state: "disabled", terms: "" },
} as unknown as ModelInfo;

describe("modelSupportsLongContext", () => {
  it("is gated on a longContext billing tier", () => {
    expect(modelSupportsLongContext(sonnet5)).toBe(true);
    expect(modelSupportsLongContext(sonnet45)).toBe(false);
  });
});

describe("buildCopilotSdkModelCapabilities", () => {
  it("surfaces reasoning effort and context window for a model that supports both", () => {
    const caps = buildCopilotSdkModelCapabilities(sonnet5);
    const descriptors = caps.optionDescriptors ?? [];
    expect(descriptors.map((d) => d.id)).toEqual(["reasoning_effort", "context_tier"]);
    const effort = descriptors.find((d) => d.id === "reasoning_effort");
    expect(effort?.type).toBe("select");
    if (effort?.type === "select") {
      expect(effort.options.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
    const context = descriptors.find((d) => d.id === "context_tier");
    expect(context?.type).toBe("select");
    if (context?.type === "select") {
      expect(context.options.map((o) => o.id)).toEqual(["default", "long_context"]);
    }
  });

  it("surfaces nothing for a model with neither lever", () => {
    expect(buildCopilotSdkModelCapabilities(sonnet45).optionDescriptors ?? []).toEqual([]);
  });
});

describe("buildCopilotSdkModels", () => {
  it("maps models, applies per-model capabilities, and skips disabled models", () => {
    const models = buildCopilotSdkModels([sonnet5, sonnet45, disabledModel]);
    expect(models.map((m) => m.slug)).toEqual(["claude-sonnet-5", "claude-sonnet-4.5"]);
    expect((models[0]?.capabilities?.optionDescriptors ?? []).map((d) => d.id)).toEqual([
      "reasoning_effort",
      "context_tier",
    ]);
    expect(models[1]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("dedupes by id and tolerates empty input", () => {
    expect(buildCopilotSdkModels([])).toEqual([]);
    expect(buildCopilotSdkModels(undefined)).toEqual([]);
    expect(buildCopilotSdkModels([sonnet5, sonnet5]).map((m) => m.slug)).toEqual([
      "claude-sonnet-5",
    ]);
  });
});

describe("resolveCopilotSdkTunables", () => {
  it("extracts reasoning effort and context tier from selections", () => {
    expect(
      resolveCopilotSdkTunables([
        { id: "reasoning_effort", value: "high" },
        { id: "context_tier", value: "long_context" },
      ]),
    ).toEqual({ reasoningEffort: "high", contextTier: "long_context" });
  });

  it("ignores unknown ids, invalid tiers, and invalid/boolean reasoning efforts", () => {
    expect(
      resolveCopilotSdkTunables([
        { id: "made_up", value: "x" },
        { id: "context_tier", value: "gigantic" },
        { id: "reasoning_effort", value: "ludicrous" },
        { id: "reasoning_effort", value: true },
      ]),
    ).toEqual({});
  });

  it("accepts the 'none' reasoning effort some models advertise", () => {
    expect(resolveCopilotSdkTunables([{ id: "reasoning_effort", value: "none" }])).toEqual({
      reasoningEffort: "none",
    });
  });

  it("returns empty for empty input", () => {
    expect(resolveCopilotSdkTunables([])).toEqual({});
    expect(resolveCopilotSdkTunables(undefined)).toEqual({});
  });
});
