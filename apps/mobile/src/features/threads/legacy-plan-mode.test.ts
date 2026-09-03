import { describe, expect, it } from "@effect/vitest";

import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "./legacy-plan-mode";

describe("resolveProviderInteractionMode", () => {
  it("clears saved plan mode when the provider cannot use T3 interaction modes", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: false }, "plan")).toBe(
      "default",
    );
  });

  it("keeps supported choices and remains compatible with older server status", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: true }, "plan")).toBe(
      "plan",
    );
    expect(resolveProviderInteractionMode({}, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(null, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(undefined, undefined)).toBe("default");
  });
});

describe("resolvePendingTaskInteractionMode", () => {
  it.each([false, true])(
    "clears a queued unsupported plan mode with preferenceLoaded=%s",
    (preferenceLoaded) => {
      expect(
        resolvePendingTaskInteractionMode({
          preferenceLoaded,
          planModeEnabled: true,
          draftInteractionMode: "plan",
          queuedInteractionMode: "plan",
          provider: { showInteractionModeToggle: false },
        }),
      ).toBe("default");
    },
  );

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
