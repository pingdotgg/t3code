import type { LinearWorkflowState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTargetStateId } from "./linearStateMapping.ts";

const states: ReadonlyArray<LinearWorkflowState> = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
  { id: "s-canceled", name: "Canceled", type: "canceled", position: 5 },
];

describe("resolveTargetStateId", () => {
  it("maps started to the In Progress state", () => {
    expect(resolveTargetStateId(states, undefined, "started")).toBe("s-progress");
  });

  it("maps done to the completed state", () => {
    expect(resolveTargetStateId(states, undefined, "done")).toBe("s-done");
  });

  it("maps review to a state named In Review", () => {
    expect(resolveTargetStateId(states, undefined, "review")).toBe("s-review");
  });

  it("prefers a valid per-team override", () => {
    expect(resolveTargetStateId(states, { started: "s-todo" }, "started")).toBe("s-todo");
  });

  it("ignores an override that no longer exists", () => {
    expect(resolveTargetStateId(states, { started: "s-missing" }, "started")).toBe("s-progress");
  });

  it("falls back to the first started state when none is named In Progress", () => {
    const renamed: ReadonlyArray<LinearWorkflowState> = [
      { id: "s-doing", name: "Doing", type: "started", position: 1 },
      { id: "s-done", name: "Complete", type: "completed", position: 2 },
    ];
    expect(resolveTargetStateId(renamed, undefined, "started")).toBe("s-doing");
    expect(resolveTargetStateId(renamed, undefined, "done")).toBe("s-done");
  });

  it("returns undefined for review when no review-like state exists", () => {
    const noReview: ReadonlyArray<LinearWorkflowState> = [
      { id: "s-progress", name: "In Progress", type: "started", position: 1 },
      { id: "s-done", name: "Done", type: "completed", position: 2 },
    ];
    expect(resolveTargetStateId(noReview, undefined, "review")).toBeUndefined();
  });
});
