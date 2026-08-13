import { describe, expect, it } from "@effect/vitest";

import { resolvePendingTaskInteractionMode } from "./legacy-plan-mode";

describe("resolvePendingTaskInteractionMode", () => {
  it("preserves a queued plan task while the preference is still loading", () => {
    expect(
      resolvePendingTaskInteractionMode({
        preferenceLoaded: false,
        planModeEnabled: false,
        draftInteractionMode: "plan",
        queuedInteractionMode: "plan",
      }),
    ).toBe("plan");
  });

  it("forces build mode once the disabled preference has loaded", () => {
    expect(
      resolvePendingTaskInteractionMode({
        preferenceLoaded: true,
        planModeEnabled: false,
        draftInteractionMode: "plan",
        queuedInteractionMode: "plan",
      }),
    ).toBe("default");
  });

  it("keeps a fresh draft in build mode while the preference is loading", () => {
    expect(
      resolvePendingTaskInteractionMode({
        preferenceLoaded: false,
        planModeEnabled: false,
        draftInteractionMode: "plan",
        queuedInteractionMode: undefined,
      }),
    ).toBe("default");
  });

  it("honors the draft's mode when the plan preference is enabled", () => {
    expect(
      resolvePendingTaskInteractionMode({
        preferenceLoaded: true,
        planModeEnabled: true,
        draftInteractionMode: "plan",
        queuedInteractionMode: undefined,
      }),
    ).toBe("plan");
    expect(
      resolvePendingTaskInteractionMode({
        preferenceLoaded: true,
        planModeEnabled: true,
        draftInteractionMode: undefined,
        queuedInteractionMode: "plan",
      }),
    ).toBe("default");
  });
});
