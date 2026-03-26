import { describe, expect, it } from "vitest";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerProvider } from "@t3tools/contracts";
import { getCopilotBuiltInModelCapabilities } from "@t3tools/shared/copilot";

import { getAppModelOptions, resolveAppModelSelectionState } from "./modelSelection";

const providers: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: "2026-03-26T00:00:00.000Z",
    models: [{ slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", isCustom: false, capabilities: null }],
  },
  {
    provider: "copilot",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    authStatus: "authenticated",
    checkedAt: "2026-03-26T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: getCopilotBuiltInModelCapabilities("gpt-5.4"),
      },
    ],
  },
];

describe("modelSelection", () => {
  it("keeps Copilot text generation selections provider-specific", () => {
    const selection = resolveAppModelSelectionState(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: {
          provider: "copilot",
          model: "gpt-5.4",
          options: {
            reasoningEffort: "medium",
          },
        },
      },
      providers,
    );

    expect(selection).toEqual({
      provider: "copilot",
      model: "gpt-5.4",
      options: {
        reasoningEffort: "medium",
      },
    });
  });

  it("includes the current Copilot selection even when it is only custom", () => {
    const options = getAppModelOptions(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        providers: {
          ...DEFAULT_UNIFIED_SETTINGS.providers,
          copilot: {
            ...DEFAULT_UNIFIED_SETTINGS.providers.copilot,
            customModels: ["gpt-5.4-preview"],
          },
        },
      },
      providers,
      "copilot",
      "custom-preview",
    );

    expect(options).toEqual(
      expect.arrayContaining([
        { slug: "gpt-5.4-preview", name: "gpt-5.4-preview", isCustom: true },
        { slug: "custom-preview", name: "custom-preview", isCustom: true },
      ]),
    );
  });
});
