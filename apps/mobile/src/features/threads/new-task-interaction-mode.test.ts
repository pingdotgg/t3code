import { describe, expect, it } from "vite-plus/test";

import {
  interactionModeFromPlanToggle,
  resolveNewTaskInteractionMode,
} from "./new-task-interaction-mode";

describe("new task interaction mode", () => {
  it("defaults new chats to Build mode", () => {
    expect(resolveNewTaskInteractionMode(undefined)).toBe("default");
    expect(interactionModeFromPlanToggle(false)).toBe("default");
  });

  it("keeps an explicit Plan mode selection", () => {
    expect(resolveNewTaskInteractionMode("plan")).toBe("plan");
    expect(interactionModeFromPlanToggle(true)).toBe("plan");
  });
});
