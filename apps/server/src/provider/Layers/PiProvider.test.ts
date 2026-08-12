import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  extractPiModels,
  piModelCapabilities,
  piModelInfoToServerModel,
  splitPiModelSlug,
} from "./PiProvider.ts";

describe("Pi provider contracts", () => {
  it("decodes disabled-by-default settings with overridable launch configuration", () => {
    const decode = Schema.decodeUnknownSync(PiSettings);
    expect(decode({})).toEqual({
      enabled: false,
      binaryPath: "pi",
      launchArgs: "",
      customModels: [],
    });
    expect(decode({ binaryPath: "C:/tools/pi.cmd", launchArgs: "--no-extensions" })).toMatchObject({
      binaryPath: "C:/tools/pi.cmd",
      launchArgs: "--no-extensions",
    });
  });

  it("round-trips provider/model slugs without truncating nested model ids", () => {
    expect(splitPiModelSlug("openrouter/anthropic/claude-opus-4.6")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude-opus-4.6",
    });
    expect(splitPiModelSlug("missing-provider")).toBeUndefined();
  });

  it("validates discovered models and exposes Pi 0.83 thinking levels", () => {
    const models = extractPiModels({
      type: "response",
      success: true,
      data: {
        models: [
          { provider: "openai-codex", id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
          { provider: "broken" },
        ],
      },
    });
    expect(models).toHaveLength(1);
    expect(piModelInfoToServerModel(models[0]!)).toMatchObject({
      slug: "openai-codex/gpt-5.4",
      name: "GPT 5.4",
      subProvider: "openai-codex",
    });

    const descriptors = piModelCapabilities(true).optionDescriptors ?? [];
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ id: "thinking", type: "select" });
    if (descriptors[0]?.type !== "select") throw new Error("expected thinking select");
    expect(descriptors[0].options.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
