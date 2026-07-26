import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAdvisorMenuActions,
  buildInteractionModeMenuAction,
  buildRuntimeModeMenuAction,
  clampMaxSubAgents,
  executorModelLabel,
  parseComposerMenuEvent,
  subAgentChoices,
} from "./interactionModes";
import type { ModelOption } from "./modelOptions";

function makeModelOption(input: {
  readonly instanceId: string;
  readonly model: string;
  readonly label?: string;
}): ModelOption {
  return {
    key: `${input.instanceId}:${input.model}`,
    label: input.label ?? input.model,
    subtitle: input.instanceId,
    providerKey: input.instanceId,
    providerLabel: input.instanceId,
    providerDriver: input.instanceId,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make(input.instanceId),
      model: input.model,
    },
  };
}

const OPTIONS = [
  makeModelOption({ instanceId: "codex", model: "gpt-5.5", label: "GPT-5.5" }),
  makeModelOption({ instanceId: "claude", model: "opus-5", label: "Opus 5" }),
];

describe("runtime mode menu", () => {
  it("offers every runtime mode, including auto", () => {
    const action = buildRuntimeModeMenuAction("auto");
    expect(action.subactions?.map((entry) => entry.id)).toEqual([
      "options:runtime:approval-required",
      "options:runtime:auto-accept-edits",
      "options:runtime:auto",
      "options:runtime:full-access",
    ]);
    expect(action.subtitle).toBe("Auto");
    expect(action.subactions?.find((entry) => entry.id === "options:runtime:auto")?.state).toBe(
      "on",
    );
  });
});

describe("interaction mode menu", () => {
  it("offers default, plan and advisor", () => {
    const action = buildInteractionModeMenuAction("advisor");
    expect(action.subactions?.map((entry) => entry.title)).toEqual([
      "Default",
      "Plan",
      "Advisor/Planner",
    ]);
    expect(action.subtitle).toBe("Advisor/Planner");
  });
});

describe("advisor menu", () => {
  it("is empty outside advisor mode", () => {
    expect(
      buildAdvisorMenuActions({
        interactionMode: "plan",
        executorModelSelection: null,
        executorMaxSubAgents: 3,
        modelOptions: OPTIONS,
      }),
    ).toEqual([]);
  });

  it("offers advise-only plus every model, and hides the cap until one is bound", () => {
    const actions = buildAdvisorMenuActions({
      interactionMode: "advisor",
      executorModelSelection: null,
      executorMaxSubAgents: 3,
      modelOptions: OPTIONS,
    });

    expect(actions.map((action) => action.id)).toEqual(["options-executor"]);
    expect(actions[0]?.subtitle).toBe("None — advise only");
    expect(actions[0]?.subactions?.map((entry) => entry.id)).toEqual([
      "options:executor-clear",
      "options:executor:codex:gpt-5.5",
      "options:executor:claude:opus-5",
    ]);
    expect(actions[0]?.subactions?.[0]?.state).toBe("on");
  });

  it("reveals the sub-agent cap once an executor is bound", () => {
    const actions = buildAdvisorMenuActions({
      interactionMode: "advisor",
      executorModelSelection: OPTIONS[1]!.selection,
      executorMaxSubAgents: 7,
      modelOptions: OPTIONS,
    });

    expect(actions.map((action) => action.id)).toEqual(["options-executor", "options-sub-agents"]);
    expect(actions[0]?.subtitle).toBe("Opus 5");
    expect(
      actions[0]?.subactions?.find((entry) => entry.id === "options:executor:claude:opus-5")?.state,
    ).toBe("on");
    expect(actions[1]?.subtitle).toBe("7");
    expect(actions[1]?.subactions?.map((entry) => entry.title)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    expect(actions[1]?.subactions?.find((entry) => entry.title === "7")?.state).toBe("on");
  });
});

describe("executorModelLabel", () => {
  it("falls back to the raw slug for models missing from the catalog", () => {
    expect(
      executorModelLabel(
        { instanceId: ProviderInstanceId.make("retired"), model: "ghost-1" },
        OPTIONS,
      ),
    ).toBe("ghost-1");
  });
});

describe("clampMaxSubAgents", () => {
  it("keeps values inside the contract bounds and defaults non-numbers", () => {
    expect(clampMaxSubAgents(0)).toBe(1);
    expect(clampMaxSubAgents(11)).toBe(10);
    expect(clampMaxSubAgents(4.6)).toBe(5);
    expect(clampMaxSubAgents(null)).toBe(3);
    expect(clampMaxSubAgents(undefined)).toBe(3);
    expect(clampMaxSubAgents(Number.NaN)).toBe(3);
  });

  it("covers exactly the offered choices", () => {
    expect(subAgentChoices()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("parseComposerMenuEvent", () => {
  it("decodes each menu family", () => {
    expect(parseComposerMenuEvent("options:interaction:advisor")).toEqual({
      kind: "interaction-mode",
      interactionMode: "advisor",
    });
    expect(parseComposerMenuEvent("options:runtime:auto")).toEqual({
      kind: "runtime-mode",
      runtimeMode: "auto",
    });
    expect(parseComposerMenuEvent("options:executor-clear")).toEqual({
      kind: "executor-model",
      modelKey: null,
    });
    expect(parseComposerMenuEvent("options:executor:codex:gpt-5.5")).toEqual({
      kind: "executor-model",
      modelKey: "codex:gpt-5.5",
    });
    expect(parseComposerMenuEvent("options:sub-agents:4")).toEqual({
      kind: "max-sub-agents",
      maxSubAgents: 4,
    });
  });

  it("clamps an out-of-range cap rather than sending an invalid command", () => {
    expect(parseComposerMenuEvent("options:sub-agents:99")).toEqual({
      kind: "max-sub-agents",
      maxSubAgents: 10,
    });
  });

  it("ignores ids it does not own and unknown mode values", () => {
    expect(parseComposerMenuEvent("provider-option:effort:high")).toBeNull();
    expect(parseComposerMenuEvent("options:runtime:teleport")).toBeNull();
    expect(parseComposerMenuEvent("options:interaction:oracle")).toBeNull();
    expect(parseComposerMenuEvent("options:sub-agents:many")).toBeNull();
  });
});
