import { describe, expect, it } from "vitest";

import { parseCodexModelListResult } from "./codexModels";

describe("parseCodexModelListResult", () => {
  it("keeps built-in display names for known models", () => {
    expect(
      parseCodexModelListResult({
        data: [
          {
            id: "gpt-5.3-codex",
            displayName: "gpt-5.3-codex",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
            defaultReasoningEffort: "medium",
          },
          {
            id: "hidden-model",
            displayName: "Hidden",
            hidden: true,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            defaultReasoningEffort: "low",
          },
        ],
      }),
    ).toEqual([
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
            { value: "high", label: "High" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("uses app-server display names for unknown models", () => {
    expect(
      parseCodexModelListResult({
        data: [
          {
            id: "future-model",
            displayName: "Future Model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            defaultReasoningEffort: "medium",
          },
        ],
      }),
    ).toEqual([
      {
        slug: "future-model",
        name: "Future Model",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [{ value: "medium", label: "Medium", isDefault: true }],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});
