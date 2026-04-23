import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "./providerModels";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

describe("getProviderModelCapabilities", () => {
  it("infers Gemini 3 thinking controls when the provider snapshot lacks capabilities", () => {
    expect(
      getProviderModelCapabilities(
        [
          {
            slug: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            isCustom: false,
            capabilities: EMPTY_CAPABILITIES,
          },
        ],
        "gemini-3.1-pro-preview",
        "gemini",
      ),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "HIGH", label: "High", isDefault: true },
              { id: "LOW", label: "Low" },
            ],
            currentValue: "HIGH",
          },
        ],
      }),
    );
  });

  it("falls back to family inference for known Gemini models even when discovery is missing", () => {
    expect(getProviderModelCapabilities([], "gemini-2.5-flash", "gemini")).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "-1", label: "Dynamic", isDefault: true },
              { id: "512", label: "512 Tokens" },
            ],
            currentValue: "-1",
          },
        ],
      }),
    );
  });

  it("keeps empty capabilities for unknown custom Gemini models", () => {
    expect(getProviderModelCapabilities([], "custom-gemini-model", "gemini")).toEqual(
      EMPTY_CAPABILITIES,
    );
  });
});
