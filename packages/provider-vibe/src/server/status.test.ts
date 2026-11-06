import { describe, expect, it } from "@effect/vitest";

import type { ConfigView } from "@t3tools/vibe-app-server/client";

import { buildVibeCapabilities, vibeModelsFromConfig } from "./status.ts";
import { vibeTurnFailure } from "./adapter.ts";

describe("vibeModelsFromConfig", () => {
  it("maps config models to provider models with the default flagged", () => {
    const config = {
      defaultModelAlias: "mistral-large-4-0-3",
      models: [
        {
          name: "mistral-large-4-0",
          alias: "mistral-large-4-0-3",
          displayName: "Mistral Large 4",
          thinkingLevels: ["low", "medium", "high"],
          thinking: "high",
        },
        { name: "devstral-small", alias: "devstral-small-2", displayName: "Devstral Small" },
      ],
    } as unknown as ConfigView;
    const models = vibeModelsFromConfig(config);
    expect(models.map((m) => m.slug)).toEqual(["mistral-large-4-0-3", "devstral-small-2"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.name).toBe("Mistral Large 4");
    expect(models[1]?.isDefault).toBeUndefined();
  });

  it("falls back when the server lists no models", () => {
    const models = vibeModelsFromConfig({ models: [] } as unknown as ConfigView);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.isDefault === true)).toBe(true);
  });
});

describe("buildVibeCapabilities", () => {
  it("exposes thinking levels as a select option", () => {
    const capabilities = buildVibeCapabilities({
      thinkingLevels: ["low", "high"],
      thinking: "high",
    });
    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    expect(
      descriptor && "options" in descriptor ? descriptor.options.map((o) => o.id) : [],
    ).toEqual(["low", "high"]);
  });

  it("returns empty capabilities without thinking levels", () => {
    expect(buildVibeCapabilities({}).optionDescriptors).toEqual([]);
  });
});

describe("vibeTurnFailure", () => {
  it("classifies Vibe's -31001 rate-limit code as usage_limit", () => {
    const failure = vibeTurnFailure({
      status: "failed",
      error: { code: -31001, message: "rate limited" },
    });
    expect(failure?.class).toBe("usage_limit");
    expect(failure?.code).toBe("-31001");
  });

  it("classifies other errors as provider_error", () => {
    const failure = vibeTurnFailure({ status: "failed", error: { code: -32603, message: "boom" } });
    expect(failure?.class).toBe("provider_error");
  });
});
