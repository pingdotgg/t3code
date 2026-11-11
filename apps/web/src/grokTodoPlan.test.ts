import { describe, expect, it } from "vite-plus/test";

import { grokTodoStepsFromTool, isGrokTodoWriteTool } from "./grokTodoPlan";

describe("Grok todo_write", () => {
  it("recognizes the Updating plan tool but not Claude's TodoWrite", () => {
    expect(
      isGrokTodoWriteTool({
        title: "Updating plan",
        toolName: "todo_write",
        input: { variant: "TodoWrite", merge: true, todos: [] },
      }),
    ).toBe(true);
    expect(
      isGrokTodoWriteTool({
        title: "Read file",
        toolName: "read_file",
        input: { variant: "ReadFile", path: "package.json" },
      }),
    ).toBe(false);
    expect(
      isGrokTodoWriteTool({
        title: "TodoWrite",
        toolName: "TodoWrite",
        input: { todos: [{ content: "Claude task", status: "pending", activeForm: "Doing" }] },
      }),
    ).toBe(false);
  });

  it("reads step titles from TodosUpdated and skips merge arguments whose content is null", () => {
    expect(
      grokTodoStepsFromTool({
        input: {
          variant: "TodoWrite",
          merge: true,
          todos: [
            { id: "1", content: null, status: "completed" },
            { id: "2", content: null, status: "in_progress" },
          ],
        },
        output: {
          type: "Todo",
          TodosUpdated: {
            summary_for_prompt: "summary",
            todos: [
              { content: "Inventory leftovers", priority: "medium", status: "completed" },
              { content: "Reinstall the CLI", priority: "medium", status: "in_progress" },
            ],
          },
        },
      }),
    ).toEqual([
      { id: "todo-1", text: "Inventory leftovers", status: "completed" },
      { id: "todo-2", text: "Reinstall the CLI", status: "running" },
    ]);
  });

  it("parses a JSON string result", () => {
    expect(
      grokTodoStepsFromTool({
        output: JSON.stringify({
          type: "Todo",
          TodosUpdated: {
            todos: [{ id: "keep", content: "Keep the plan", status: "pending" }],
          },
        }),
      }),
    ).toEqual([{ id: "keep", text: "Keep the plan", status: "pending" }]);
  });
});
