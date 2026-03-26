import { describe, expect, it } from "vitest";

import { buildLegacyServerSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyServerSettingsMigrationPatch", () => {
  it("migrates Copilot settings and model selections from legacy local storage", () => {
    const patch = buildLegacyServerSettingsMigrationPatch({
      copilotCliPath: " /opt/homebrew/bin/copilot ",
      copilotConfigDir: " /Users/julius/.config/copilot ",
      customCopilotModels: ["5.4", " custom-copilot "],
      textGenerationModelSelection: {
        provider: "copilot",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "medium",
        },
      },
    });

    expect(patch).toEqual({
      textGenerationModelSelection: {
        provider: "copilot",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "medium",
        },
      },
      providers: {
        copilot: {
          binaryPath: " /opt/homebrew/bin/copilot ",
          configDir: " /Users/julius/.config/copilot ",
          customModels: ["gpt-5.4", "custom-copilot"],
        },
      },
    });
  });
});
