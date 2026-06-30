import { describe, expect, it } from "vite-plus/test";

import { agentSelectionWithInstanceModel, agentSelectionWithOptions } from "./agentStepSelection";

const baseAgent = {
  instance: "codex_main",
  model: "gpt-5.5",
  options: [{ id: "reasoningEffort", value: "high" as const }],
};

describe("agentSelectionWithInstanceModel", () => {
  it("updates instance and model while preserving existing options", () => {
    const next = agentSelectionWithInstanceModel(baseAgent, "claude_main", "claude-opus-4-6");
    expect(next).toEqual({
      instance: "claude_main",
      model: "claude-opus-4-6",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});

describe("agentSelectionWithOptions", () => {
  it("stores the provided option selections", () => {
    const next = agentSelectionWithOptions({ instance: "codex_main", model: "gpt-5.5" }, [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    expect(next).toEqual({
      instance: "codex_main",
      model: "gpt-5.5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("drops the options key when cleared to undefined", () => {
    const next = agentSelectionWithOptions(baseAgent, undefined);
    expect(next).toEqual({ instance: "codex_main", model: "gpt-5.5" });
    expect("options" in next).toBe(false);
  });

  it("drops the options key when given an empty selection", () => {
    const next = agentSelectionWithOptions(baseAgent, []);
    expect(next).toEqual({ instance: "codex_main", model: "gpt-5.5" });
    expect("options" in next).toBe(false);
  });
});
