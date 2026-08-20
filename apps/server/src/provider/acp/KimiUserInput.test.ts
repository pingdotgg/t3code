import { describe, expect, it } from "vite-plus/test";

import {
  extractKimiPermissionQuestions,
  extractKimiUserQuestions,
  resolveKimiQuestionPermissionOption,
} from "./KimiUserInput.ts";

describe("extractKimiUserQuestions", () => {
  it("parses Kimi AskUserQuestion input", () => {
    expect(
      extractKimiUserQuestions({
        questions: [
          {
            id: "framework",
            header: "Framework",
            question: "Which framework should I use?",
            options: [
              { label: "React", description: "Use React." },
              { label: "Vue", description: "Use Vue." },
            ],
            multi_select: false,
          },
        ],
      }),
    ).toEqual([
      {
        id: "framework",
        header: "Framework",
        question: "Which framework should I use?",
        options: [
          { label: "React", description: "Use React." },
          { label: "Vue", description: "Use Vue." },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("derives stable ids and trims fields", () => {
    expect(
      extractKimiUserQuestions({
        questions: [
          {
            header: "  Database  ",
            question: "  Which database? ",
            options: [" Postgres ", " SQLite "],
          },
        ],
      }),
    ).toEqual([
      {
        id: "kimi-question-1-database",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Postgres" },
          { label: "SQLite", description: "SQLite" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it.each([
    undefined,
    {},
    { questions: [] },
    { questions: [{ header: "X", question: "Choose", options: [{ label: "Only" }] }] },
    {
      questions: [
        { header: "X", question: "Choose", options: [{ label: "" }, { label: "Valid" }] },
      ],
    },
    { tool: "shell", input: { command: "pwd" } },
  ])("rejects malformed or non-question input %#", (input) => {
    expect(extractKimiUserQuestions(input)).toBeUndefined();
  });
});

describe("Kimi ACP question permissions", () => {
  const request = {
    sessionId: "kimi-session",
    toolCall: {
      toolCallId: "ask-1",
      title: "AskUserQuestion",
      content: [
        {
          type: "content" as const,
          content: { type: "text" as const, text: "Which framework should I use?" },
        },
      ],
    },
    options: [
      { optionId: "q0_opt_0", name: "React", kind: "allow_once" as const },
      { optionId: "q0_opt_1", name: "Vue", kind: "allow_once" as const },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" as const },
    ],
  };

  it("recognizes Kimi Code's permission-based question bridge", () => {
    expect(extractKimiPermissionQuestions(request)).toEqual([
      {
        id: "ask-1",
        header: "Question",
        question: "Which framework should I use?",
        options: [
          { label: "React", description: "React" },
          { label: "Vue", description: "Vue" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("matches Kimi's single-choice ACP bridge for legacy raw question input", () => {
    expect(
      extractKimiPermissionQuestions({
        ...request,
        toolCall: {
          ...request.toolCall,
          rawInput: {
            questions: [
              {
                id: "framework",
                header: "Framework",
                question: "Which framework?",
                options: ["React", "Vue"],
                multiSelect: true,
              },
              {
                id: "database",
                header: "Database",
                question: "Which database?",
                options: ["Postgres", "SQLite"],
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        id: "framework",
        header: "Framework",
        question: "Which framework?",
        options: [
          { label: "React", description: "React" },
          { label: "Vue", description: "Vue" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("round-trips the selected label to Kimi's opaque ACP option id", () => {
    const questions = extractKimiPermissionQuestions(request) ?? [];
    expect(
      resolveKimiQuestionPermissionOption({
        request,
        questions,
        answers: { "ask-1": "Vue" },
      }),
    ).toBe("q0_opt_1");
  });

  it.each([{ "ask-1": ["Vue"] }, { "ask-1": { answers: ["Vue"] } }, { "ask-1": " Vue " }])(
    "accepts supported answer payload shapes %#",
    (answers) => {
      const questions = extractKimiPermissionQuestions(request) ?? [];
      expect(resolveKimiQuestionPermissionOption({ request, questions, answers })).toBe("q0_opt_1");
    },
  );

  it("trims permission option names before matching", () => {
    const spacedRequest = {
      ...request,
      options: request.options.map((entry) =>
        entry.optionId === "q0_opt_1" ? { ...entry, name: "  Vue  " } : entry,
      ),
    };
    const questions = extractKimiPermissionQuestions(spacedRequest) ?? [];
    expect(
      resolveKimiQuestionPermissionOption({
        request: spacedRequest,
        questions,
        answers: { "ask-1": "Vue" },
      }),
    ).toBe("q0_opt_1");
  });
});
