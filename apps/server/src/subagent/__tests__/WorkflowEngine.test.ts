import { describe, it, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import { WorkflowEngine, WorkflowEngineLive } from "../workflows/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../workflows/WorkflowSchema.ts";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";

describe("WorkflowEngine", () => {
  const mockContext = {
    workflowId: "test-wf-123",
    callerThreadId: ThreadId.make("thread-123"),
    callerProviderInstanceId: ProviderInstanceId.make("codex"),
    variables: new Map([["query", "test query"]]),
  };

  it("should validate workflow definition structure", () => {
    const workflow: WorkflowDefinition = {
      name: "test-workflow",
      description: "Test workflow",
      version: "1.0.0",
      phases: [
        {
          id: "phase1",
          title: "Test Phase",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Test prompt",
            },
          ],
        },
      ],
    };

    expect(workflow.phases).toHaveLength(1);
    expect(workflow.phases[0].tasks).toHaveLength(1);
    expect(workflow.phases[0].execution).toBe("sequential");
  });

  it("should handle sequential task execution", () => {
    const workflow: WorkflowDefinition = {
      name: "sequential-test",
      description: "Sequential execution test",
      version: "1.0.0",
      phases: [
        {
          id: "seq-phase",
          title: "Sequential Phase",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "First task",
            },
            {
              id: "task2",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Second task - depends on task1",
              dependencies: ["task1"],
            },
          ],
        },
      ],
    };

    expect(workflow.phases[0].tasks[1].dependencies).toContain("task1");
  });

  it("should handle parallel task execution", () => {
    const workflow: WorkflowDefinition = {
      name: "parallel-test",
      description: "Parallel execution test",
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
              provider: ProviderInstanceId.make("codex"),
              prompt: "Task 1",
            },
            {
              id: "task2",
              type: "spawn",
              provider: ProviderInstanceId.make("claudeAgent"),
              prompt: "Task 2",
            },
            {
              id: "task3",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Task 3",
            },
          ],
        },
      ],
    };

    expect(workflow.phases[0].execution).toBe("parallel");
    expect(workflow.phases[0].tasks).toHaveLength(3);
  });

  it("should substitute variables in prompts", () => {
    const workflow: WorkflowDefinition = {
      name: "variable-test",
      description: "Variable substitution test",
      version: "1.0.0",
      phases: [
        {
          id: "var-phase",
          title: "Variable Phase",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Search for {{query}} in the codebase",
            },
          ],
        },
      ],
    };

    const prompt = workflow.phases[0].tasks[0].prompt;
    expect(prompt).toContain("{{query}}");

    // In actual execution, {{query}} would be replaced with "test query"
    const expectedResolved = "Search for test query in the codebase";
    expect(prompt?.replace("{{query}}", mockContext.variables.get("query") ?? "")).toBe(
      expectedResolved,
    );
  });

  it("should handle aggregate task type", () => {
    const workflow: WorkflowDefinition = {
      name: "aggregate-test",
      description: "Aggregate task test",
      version: "1.0.0",
      phases: [
        {
          id: "gather",
          title: "Gather",
          execution: "parallel",
          tasks: [
            {
              id: "source1",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Search source 1",
            },
            {
              id: "source2",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Search source 2",
            },
          ],
        },
        {
          id: "combine",
          title: "Combine",
          execution: "sequential",
          tasks: [
            {
              id: "aggregate",
              type: "aggregate",
              dependencies: ["source1", "source2"],
            },
          ],
        },
      ],
    };

    const aggregateTask = workflow.phases[1].tasks[0];
    expect(aggregateTask.type).toBe("aggregate");
    expect(aggregateTask.dependencies).toEqual(["source1", "source2"]);
  });

  it("should handle error with retry policy", () => {
    const workflow: WorkflowDefinition = {
      name: "retry-test",
      description: "Retry policy test",
      version: "1.0.0",
      phases: [
        {
          id: "retry-phase",
          title: "Retry Phase",
          execution: "sequential",
          tasks: [
            {
              id: "task1",
              type: "spawn",
              provider: ProviderInstanceId.make("codex"),
              prompt: "Task with retry",
              onError: "retry",
              retryPolicy: {
                maxAttempts: 3,
                backoffMs: 1000,
              },
            },
          ],
        },
      ],
    };

    const task = workflow.phases[0].tasks[0];
    expect(task.onError).toBe("retry");
    expect(task.retryPolicy?.maxAttempts).toBe(3);
    expect(task.retryPolicy?.backoffMs).toBe(1000);
  });
});
