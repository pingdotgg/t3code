import { describe, expect, it } from "vite-plus/test";

import { extractAskQuestions, extractTodosAsPlan } from "./CursorAcpExtension.ts";

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
});
