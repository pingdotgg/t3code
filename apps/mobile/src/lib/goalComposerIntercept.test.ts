import { describe, expect, it } from "vite-plus/test";

import { interceptGoalComposerCommand } from "./goalComposerIntercept";

describe("interceptGoalComposerCommand", () => {
  it("lets ordinary text through", () => {
    expect(
      interceptGoalComposerCommand({
        text: "the goal of this function is X",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("refuses spoken command forms", () => {
    expect(
      interceptGoalComposerCommand({
        text: "slash goal Reduce p95",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }).kind,
    ).toBe("alert");
  });

  it("parses /goal set and lifecycle commands", () => {
    expect(
      interceptGoalComposerCommand({
        text: "/goal Reduce p95 below 120ms",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }),
    ).toEqual({ kind: "set", objective: "Reduce p95 below 120ms" });
    expect(
      interceptGoalComposerCommand({
        text: "/goal pause",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }),
    ).toEqual({ kind: "pause" });
    expect(
      interceptGoalComposerCommand({
        text: "/goal resume",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }),
    ).toEqual({ kind: "resume" });
    expect(
      interceptGoalComposerCommand({
        text: "/goal clear",
        supportsGoal: true,
        allowLifecycleCommands: true,
        goal: null,
      }),
    ).toEqual({ kind: "clear" });
  });

  it("does not send command forms when the environment cannot set an Objective", () => {
    const intercepted = interceptGoalComposerCommand({
      text: "/goal Reduce p95 below 120ms",
      supportsGoal: false,
      allowLifecycleCommands: true,
      goal: null,
    });
    expect(intercepted.kind).toBe("alert");
  });

  it("alerts status instead of sending /goal with no arguments", () => {
    const intercepted = interceptGoalComposerCommand({
      text: "/goal",
      supportsGoal: true,
      allowLifecycleCommands: true,
      goal: null,
    });
    expect(intercepted).toMatchObject({ kind: "alert", title: "Objective" });
  });

  it("refuses lifecycle commands on a new-task draft", () => {
    expect(
      interceptGoalComposerCommand({
        text: "/goal pause",
        supportsGoal: true,
        allowLifecycleCommands: false,
        goal: null,
      }).kind,
    ).toBe("alert");
  });
});
