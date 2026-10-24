import { describe, expect, it } from "vite-plus/test";

import { resolvePendingTaskInteractionMode } from "./legacy-plan-mode";

describe("resolvePendingTaskInteractionMode", () => {
  const untouchedNewTask = {
    preferenceLoaded: true,
    planModeEnabled: true,
    draftInteractionMode: undefined,
    queuedInteractionMode: undefined,
    inheritedInteractionMode: "plan",
  } as const;

  it("sends an untouched new task in the mode it inherited", () => {
    expect(resolvePendingTaskInteractionMode(untouchedNewTask)).toBe("plan");
  });

  it("lets the draft's own pick win over the inherited mode", () => {
    expect(
      resolvePendingTaskInteractionMode({ ...untouchedNewTask, draftInteractionMode: "default" }),
    ).toBe("default");
  });

  it("drops an inherited plan mode the provider or preference cannot use", () => {
    expect(
      resolvePendingTaskInteractionMode({
        ...untouchedNewTask,
        provider: { showInteractionModeToggle: false },
      }),
    ).toBe("default");
    expect(resolvePendingTaskInteractionMode({ ...untouchedNewTask, planModeEnabled: false })).toBe(
      "default",
    );
  });

  it("keeps a queued task's mode while the preference loads", () => {
    expect(
      resolvePendingTaskInteractionMode({
        ...untouchedNewTask,
        preferenceLoaded: false,
        planModeEnabled: false,
        inheritedInteractionMode: null,
        queuedInteractionMode: "plan",
      }),
    ).toBe("plan");
  });
});
