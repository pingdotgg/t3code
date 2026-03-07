import { describe, expect, it } from "vitest";

import {
  isCopilotModelAvailable,
  readAvailableCopilotModelIds,
  readCopilotReasoningEffortSelector,
} from "./copilotAcpManager";

describe("copilotAcpManager model availability", () => {
  it("reads ACP-advertised model ids", () => {
    expect(
      readAvailableCopilotModelIds({
        currentModelId: "claude-sonnet-4.5",
        availableModels: [
          { modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          { modelId: "gpt-5.4", name: "GPT-5.4" },
        ],
      }),
    ).toEqual(["claude-sonnet-4.5", "gpt-5.4"]);
  });

  it("treats requested models as unavailable when ACP advertises a different model set", () => {
    expect(
      isCopilotModelAvailable(
        {
          currentModelId: "claude-sonnet-4.5",
          availableModels: [{ modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
        },
        "grok-code-fast-1",
      ),
    ).toBe(false);
  });

  it("allows requested models when ACP has not advertised any model set yet", () => {
    expect(isCopilotModelAvailable(null, "claude-sonnet-4.5")).toBe(true);
  });

  it("reads ACP-advertised Copilot reasoning selectors", () => {
    expect(
      readCopilotReasoningEffortSelector([
        {
          type: "select",
          id: "reasoning_effort",
          name: "Reasoning Effort",
          category: "thought_level",
          currentValue: "xhigh",
          options: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
            { value: "xhigh", name: "xhigh" },
            { value: "unsupported", name: "unsupported" },
          ],
        },
      ]),
    ).toEqual({
      id: "reasoning_effort",
      currentValue: "xhigh",
      options: ["low", "medium", "high", "xhigh"],
    });
  });

  it("supports grouped ACP reasoning selectors", () => {
    expect(
      readCopilotReasoningEffortSelector([
        {
          type: "select",
          id: "reasoning_effort",
          name: "Reasoning Effort",
          category: "thought_level",
          currentValue: "high",
          options: [
            {
              group: "standard",
              name: "Standard",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        },
      ]),
    ).toEqual({
      id: "reasoning_effort",
      currentValue: "high",
      options: ["low", "medium", "high"],
    });
  });
});
