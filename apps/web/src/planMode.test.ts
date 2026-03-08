import { describe, expect, it } from "vitest";

import {
  defaultPlanModeContextForInteractionMode,
  nextPlanModeContextAfterSuccessfulPlanTurn,
  resolveEffectivePlanModeContext,
} from "./planMode";

describe("resolveEffectivePlanModeContext", () => {
  it("defaults to the latest plan follow-up when plan mode has an active proposed plan", () => {
    expect(
      resolveEffectivePlanModeContext({
        interactionMode: "plan",
        storedPlanModeContext: null,
        hasActiveProposedPlan: true,
      }),
    ).toBe("follow-up");
  });

  it("returns null when there is no active proposed plan", () => {
    expect(
      resolveEffectivePlanModeContext({
        interactionMode: "plan",
        storedPlanModeContext: null,
        hasActiveProposedPlan: false,
      }),
    ).toBeNull();
  });

  it("preserves an explicit follow-up selection", () => {
    expect(
      resolveEffectivePlanModeContext({
        interactionMode: "plan",
        storedPlanModeContext: "follow-up",
        hasActiveProposedPlan: true,
      }),
    ).toBe("follow-up");
  });
});

describe("defaultPlanModeContextForInteractionMode", () => {
  it("defaults to the latest plan follow-up only when entering plan mode with an existing plan", () => {
    expect(
      defaultPlanModeContextForInteractionMode({
        interactionMode: "plan",
        hasActiveProposedPlan: true,
      }),
    ).toBe("follow-up");
    expect(
      defaultPlanModeContextForInteractionMode({
        interactionMode: "plan",
        hasActiveProposedPlan: false,
      }),
    ).toBeNull();
    expect(
      defaultPlanModeContextForInteractionMode({
        interactionMode: "default",
        hasActiveProposedPlan: true,
      }),
    ).toBeNull();
  });
});

describe("nextPlanModeContextAfterSuccessfulPlanTurn", () => {
  it("switches fresh plan turns into follow-up mode after success", () => {
    expect(nextPlanModeContextAfterSuccessfulPlanTurn("new")).toBe("follow-up");
  });

  it("leaves other states unchanged", () => {
    expect(nextPlanModeContextAfterSuccessfulPlanTurn("follow-up")).toBe("follow-up");
    expect(nextPlanModeContextAfterSuccessfulPlanTurn(null)).toBeNull();
  });
});
