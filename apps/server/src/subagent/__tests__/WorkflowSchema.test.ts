import { describe, it, expect } from "vitest";
import type { WorkflowDefinition } from "../workflows/WorkflowSchema.ts";

describe("WorkflowSchema", () => {
  it("should validate a complete workflow definition", () => {
    const workflow: WorkflowDefinition = {
      name: "test-workflow",
      description: "Test workflow",
      version: "1.0.0",
      phases: [
        {
          id: "phase1",
          title: "Phase 1",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: "codex",
              model: "gpt-4o",
              prompt: "Test task",
            },
          ],
        },
      ],
    };

    expect(workflow.name).toBe("test-workflow");
    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0].tasks).toHaveLength(1);
  });

  it("should handle workflow with dependencies", () => {
    const workflow: WorkflowDefinition = {
      name: "dependent-workflow",
      description: "Workflow with dependencies",
      version: "1.0.0",
      phases: [
        {
          id: "phase1",
          title: "Phase 1",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: "codex",
              prompt: "First task",
            },
            {
              id: "task2",
              type: "wait",
              dependencies: ["task1"],
            },
          ],
        },
      ],
    };

    expect(workflow.phases[0].tasks[1].dependencies).toEqual(["task1"]);
  });

  it("should handle parallel execution", () => {
    const workflow: WorkflowDefinition = {
      name: "parallel-workflow",
      description: "Parallel execution",
      version: "1.0.0",
      phases: [
        {
          id: "parallel-phase",
          title: "Parallel Phase",
          execution: "parallel",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: "codex",
              prompt: "Task 1",
            },
            {
              id: "task2",
              type: "spawn",
              provider: "claudeAgent",
              prompt: "Task 2",
            },
          ],
        },
      ],
    };

    expect(workflow.phases[0].execution).toBe("parallel");
    expect(workflow.phases[0].tasks).toHaveLength(2);
  });
});
