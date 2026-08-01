import { describe, expect, it } from "@effect/vitest";

import {
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import {
  GROK_REASONING_EFFORT_OPTION_ID,
  resolveGrokSpawnOptionValue,
} from "../provider/acp/GrokAcpSupport.ts";
import { acpSelectionTransition } from "./ProviderSelectionTransition.ts";

const selection = (model: string, effort = "medium"): ModelSelection => ({
  instanceId: ProviderInstanceId.make("acp_test"),
  model,
  options: [{ id: "effort", value: effort }],
});

describe("acpSelectionTransition", () => {
  it("rejects model changes when the negotiated session cannot apply them", () => {
    expect(
      acpSelectionTransition({
        current: selection("old"),
        target: selection("new"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
      }).type,
    ).toBe("reject");
  });

  it("allows model changes when the negotiated session can apply them", () => {
    const sessionCapabilities: OrchestrationV2ProviderCapabilities = {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
      },
    };
    expect(
      acpSelectionTransition({
        current: selection("old"),
        target: selection("new"),
        sessionCapabilities,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("allows option-only changes to be applied through ACP config options", () => {
    expect(
      acpSelectionTransition({
        current: selection("same", "medium"),
        target: selection("same", "high"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("rejects a changed spawn-bound option on an active session", () => {
    expect(
      acpSelectionTransition({
        current: selection("same", "low"),
        target: selection("same", "high"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: ["effort"],
      }),
    ).toEqual({
      type: "reject",
      reason: 'The active ACP session cannot change spawn-bound option "effort" after start.',
    });
  });

  it("rejects presence/absence changes for spawn-bound options", () => {
    const withEffort: ModelSelection = selection("same", "low");
    const withoutEffort: ModelSelection = {
      instanceId: ProviderInstanceId.make("acp_test"),
      model: "same",
    };
    expect(
      acpSelectionTransition({
        current: withEffort,
        target: withoutEffort,
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: ["effort"],
      }).type,
    ).toBe("reject");
    expect(
      acpSelectionTransition({
        current: withoutEffort,
        target: withEffort,
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: ["effort"],
      }).type,
    ).toBe("reject");
  });

  it("allows semantically equal absent and explicit provider defaults", () => {
    const withoutEffort: ModelSelection = {
      instanceId: ProviderInstanceId.make("grok"),
      model: "grok-4.5",
    };
    const withEffort = (effort: string): ModelSelection => ({
      ...withoutEffort,
      options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: effort }],
    });

    expect(
      acpSelectionTransition({
        current: withoutEffort,
        target: withEffort("high"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
        resolveSpawnOptionValue: resolveGrokSpawnOptionValue,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
    expect(
      acpSelectionTransition({
        current: withoutEffort,
        target: withEffort("low"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
        resolveSpawnOptionValue: resolveGrokSpawnOptionValue,
      }).type,
    ).toBe("reject");
  });

  it("allows unchanged spawn-bound options with normal ACP planning", () => {
    expect(
      acpSelectionTransition({
        current: selection("same", "low"),
        target: selection("same", "low"),
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: ["effort"],
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("classifies model changes independently from model-specific spawn defaults", () => {
    const sessionCapabilities: OrchestrationV2ProviderCapabilities = {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
      },
    };
    expect(
      acpSelectionTransition({
        current: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
        },
        target: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        sessionCapabilities,
        spawnOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
        resolveSpawnOptionValue: resolveGrokSpawnOptionValue,
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });

  it("rejects model changes that explicitly change a spawn-bound option", () => {
    const sessionCapabilities: OrchestrationV2ProviderCapabilities = {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
      },
    };
    expect(
      acpSelectionTransition({
        current: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-4.5",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "high" }],
        },
        target: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }],
        },
        sessionCapabilities,
        spawnOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
        resolveSpawnOptionValue: resolveGrokSpawnOptionValue,
      }),
    ).toEqual({
      type: "reject",
      reason:
        'The active ACP session cannot change spawn-bound option "reasoningEffort" after start.',
    });
  });

  it("allows mutable apply_on_next_turn config when spawn-bound options are unchanged", () => {
    const current: ModelSelection = {
      instanceId: ProviderInstanceId.make("acp_test"),
      model: "same",
      options: [
        { id: "effort", value: "low" },
        { id: "model", value: "default" },
      ],
    };
    const target: ModelSelection = {
      instanceId: ProviderInstanceId.make("acp_test"),
      model: "same",
      options: [
        { id: "effort", value: "low" },
        { id: "model", value: "composer-2" },
      ],
    };
    expect(
      acpSelectionTransition({
        current,
        target,
        sessionCapabilities: AcpProviderCapabilitiesV2,
        spawnOptionIds: ["effort"],
      }),
    ).toEqual({ type: "apply_on_next_turn" });
  });
});
