import { describe, expect, it } from "vite-plus/test";

import {
  CursorListAvailableModelsResponse,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
  extractTodosAsPlanFromToolCallInput,
} from "./CursorAcpExtension.ts";

describe("CursorAcpExtension", () => {
  it("extracts ask-question prompts from the real Cursor ACP payload shape", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-1",
      title: "Need input",
      questions: [
        {
          id: "language",
          prompt: "Which language should I use?",
          options: [
            { id: "ts", label: "TypeScript" },
            { id: "rs", label: "Rust" },
          ],
          allowMultiple: false,
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "language",
        header: "Question",
        question: "Which language should I use?",
        multiSelect: false,
        options: [
          { label: "TypeScript", description: "TypeScript" },
          { label: "Rust", description: "Rust" },
        ],
      },
    ]);
  });

  it("defaults ask-question multi-select to false when Cursor omits allowMultiple", () => {
    const questions = extractAskQuestions({
      toolCallId: "ask-2",
      questions: [
        {
          id: "mode",
          prompt: "Which mode should I use?",
          options: [
            { id: "agent", label: "Agent" },
            { id: "plan", label: "Plan" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "mode",
        header: "Question",
        question: "Which mode should I use?",
        multiSelect: false,
        options: [
          { label: "Agent", description: "Agent" },
          { label: "Plan", description: "Plan" },
        ],
      },
    ]);
  });

  it("extracts plan markdown from the real Cursor create-plan payload shape", () => {
    const planMarkdown = extractPlanMarkdown({
      toolCallId: "plan-1",
      name: "Refactor parser",
      overview: "Tighten ACP parsing",
      plan: "# Plan\n\n1. Add schemas\n2. Remove casts",
      todos: [
        { id: "t1", content: "Add schemas", status: "in_progress" },
        { id: "t2", content: "Remove casts", status: "pending" },
      ],
      isProject: false,
    });

    expect(planMarkdown).toBe("# Plan\n\n1. Add schemas\n2. Remove casts");
  });

  it("projects todo updates into a plan shape and drops invalid entries", () => {
    expect(
      extractTodosAsPlan({
        toolCallId: "todos-1",
        todos: [
          { id: "1", content: "Inspect state", status: "completed" },
          { id: "2", content: "  Apply fix  ", status: "in_progress" },
          { id: "3", title: "Fallback title", status: "pending" },
          { id: "4", content: "Unknown status", status: "weird_status" },
          { id: "5", content: "   " },
        ],
        merge: true,
      }),
    ).toEqual({
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Apply fix", status: "inProgress" },
        { step: "Fallback title", status: "pending" },
        { step: "Unknown status", status: "pending" },
      ],
    });
  });

  it("maps Cursor CLI TODO_STATUS_* values onto plan statuses", () => {
    expect(
      extractTodosAsPlan({
        toolCallId: "todos-cli-1",
        todos: [
          { id: "1", content: "Inspect state", status: "TODO_STATUS_COMPLETED" },
          { id: "2", content: "Apply fix", status: "TODO_STATUS_IN_PROGRESS" },
          { id: "3", content: "Write tests", status: "TODO_STATUS_PENDING" },
        ],
        merge: false,
      }),
    ).toEqual({
      plan: [
        { step: "Inspect state", status: "completed" },
        { step: "Apply fix", status: "inProgress" },
        { step: "Write tests", status: "pending" },
      ],
    });
  });

  it("projects Cursor CLI updateTodos tool-call input into a plan", () => {
    const expected = {
      plan: [
        { step: "Inspect mock ACP state", status: "completed" },
        { step: "Implement the requested change", status: "inProgress" },
      ],
    };
    expect(
      extractTodosAsPlanFromToolCallInput({
        _toolName: "updateTodos",
        todos: [
          {
            id: "1",
            content: "Inspect mock ACP state",
            status: "TODO_STATUS_COMPLETED",
            createdAt: "2026-09-11T01:00:00.000Z",
            updatedAt: "2026-09-11T01:00:00.000Z",
            dependencies: [],
          },
          {
            id: "2",
            content: "Implement the requested change",
            status: "TODO_STATUS_IN_PROGRESS",
          },
        ],
      }),
    ).toEqual(expected);
    expect(
      extractTodosAsPlanFromToolCallInput({
        _toolName: "TodoWrite",
        todos: [
          { content: "Inspect mock ACP state", status: "TODO_STATUS_COMPLETED" },
          { content: "Implement the requested change", status: "TODO_STATUS_IN_PROGRESS" },
        ],
      }),
    ).toEqual(expected);
  });

  it("ignores tool-call input that is not Cursor updateTodos", () => {
    expect(
      extractTodosAsPlanFromToolCallInput({
        _toolName: "editFile",
        todos: [{ content: "Should not become a plan", status: "TODO_STATUS_IN_PROGRESS" }],
      }),
    ).toBeUndefined();
    expect(
      extractTodosAsPlanFromToolCallInput({
        todos: [{ content: "Missing tool name", status: "TODO_STATUS_PENDING" }],
      }),
    ).toBeUndefined();
    expect(
      extractTodosAsPlanFromToolCallInput({
        _toolName: "TodoWrite",
        todos: [],
      }),
    ).toBeUndefined();
  });

  it("falls back to the title when content is present but blank", () => {
    expect(
      extractTodosAsPlan({
        toolCallId: "todos-2",
        todos: [
          { id: "1", content: "", title: "Titled step", status: "pending" },
          { id: "2", content: "   ", title: "Whitespace content", status: "in_progress" },
          { id: "3", content: "", title: "", status: "pending" },
        ],
        merge: true,
      }),
    ).toEqual({
      plan: [
        { step: "Titled step", status: "pending" },
        { step: "Whitespace content", status: "inProgress" },
      ],
    });
  });

  it("decodes Cursor list_available_models responses with per-model config options", () => {
    const decoded = CursorListAvailableModelsResponse.make({
      models: [
        {
          value: "gpt-5.4",
          name: "GPT-5.4",
          configOptions: [
            {
              id: "reasoning",
              name: "Reasoning",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
              ],
            },
          ],
        },
      ],
    });

    expect(decoded.models[0]?.configOptions?.[0]?.id).toBe("reasoning");
  });
});
