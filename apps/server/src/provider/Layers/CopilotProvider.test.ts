import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CopilotSettings } from "@t3tools/contracts";
import {
  buildCopilotDiscoveredModels,
  buildCopilotModelCapabilities,
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  isCopilotAuthFailure,
} from "./CopilotProvider.ts";

const decodeSettings = Schema.decodeSync(CopilotSettings);

describe("CopilotProvider helpers", () => {
  it.effect("presents an enabled Early Access provider with in-session model changes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCopilotProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("GitHub Copilot");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );

  it("discovers ACP models and exposes reasoning effort", () => {
    const configOptions = [
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ] as const;
    const capabilities = buildCopilotModelCapabilities(configOptions);
    expect(capabilities.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
    expect(
      buildCopilotDiscoveredModels(
        {
          currentModelId: "gpt-5.4",
          availableModels: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
        },
        configOptions,
      ),
    ).toMatchObject([{ slug: "gpt-5.4", name: "GPT-5.4" }]);
  });

  it("recognizes auth failures without treating generic startup errors as logged out", () => {
    expect(isCopilotAuthFailure(new Error("Not authenticated. Run copilot login."))).toBe(true);
    expect(isCopilotAuthFailure({ cause: { message: "GH_TOKEN is invalid" } })).toBe(true);
    expect(isCopilotAuthFailure(new Error("ACP transport closed unexpectedly"))).toBe(false);
  });
});

it.layer(NodeServices.layer)("checkCopilotProviderStatus", (it) => {
  it.effect("clearly reports a missing Copilot CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCopilotProviderStatus(
        decodeSettings({
          binaryPath: "/definitely/not/installed/copilot",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toMatch(/not installed|not on PATH/);
    }),
  );
});
