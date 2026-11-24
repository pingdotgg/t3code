import { describe, expect, it } from "vite-plus/test";

import { outlineTodoSteps, type TodoStep } from "./ThreadDetailsTasks.logic";

function steps(...items: ReadonlyArray<[string, TodoStep["status"]]>): TodoStep[] {
  return items.map(([text, status], index) => ({ id: `s${index}`, text, status }) as TodoStep);
}

describe("outlineTodoSteps", () => {
  it("keeps a plain list flat", () => {
    const outline = outlineTodoSteps(steps(["A", "completed"], ["B", "running"], ["C", "pending"]));
    expect(outline.phases).toEqual([]);
    expect(outline.loose.map((step) => step.text)).toEqual(["A", "B", "C"]);
    expect([outline.done, outline.total]).toEqual([1, 3]);
  });

  it("groups steps under phase headings and derives each phase's status", () => {
    const outline = outlineTodoSteps(
      steps(
        ["Phase 1: Setup", "completed"],
        ["Init repo", "completed"],
        ["Add deps", "completed"],
        ["Phase 2 - API", "pending"],
        ["Write route", "running"],
        ["Test route", "pending"],
        ["phase 3. UI", "running"],
        ["Build page", "pending"],
      ),
    );
    expect(outline.loose).toEqual([]);
    expect(
      outline.phases.map((phase) => [phase.title, phase.status, phase.done, phase.steps.length]),
    ).toEqual([
      ["Phase 1: Setup", "completed", 2, 2],
      ["Phase 2 - API", "running", 0, 2],
      ["phase 3. UI", "pending", 0, 1],
    ]);
    expect([outline.done, outline.total]).toEqual([2, 5]);
  });

  it("keeps steps before the first phase loose and counts an empty phase as one step", () => {
    const outline = outlineTodoSteps(
      steps(
        ["Read the code", "completed"],
        ["Phase 1: Ship", "completed"],
        ["Phase 2: Docs", "pending"],
      ),
    );
    expect(outline.loose.map((step) => step.text)).toEqual(["Read the code"]);
    expect(outline.phases.map((phase) => [phase.status, phase.done])).toEqual([
      ["completed", 1],
      ["pending", 0],
    ]);
    expect([outline.done, outline.total]).toEqual([2, 3]);
  });

  it("does not treat text that merely mentions a phase as a heading", () => {
    const outline = outlineTodoSteps(
      steps(["Plan phase 2 work", "pending"], ["Phase two: words", "pending"]),
    );
    expect(outline.phases).toEqual([]);
    expect(outline.total).toBe(2);
  });
});
