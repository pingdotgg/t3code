import { describe, expect, it } from "vite-plus/test";

import {
  makeDevinAskQuestionPrompt,
  methodLooksLikeDevinAskQuestion,
  parseDevinAskQuestionPayload,
} from "./DevinAcpExtension.ts";

describe("DevinAcpExtension", () => {
  it("recognizes Devin ask-question extension methods", () => {
    expect(methodLooksLikeDevinAskQuestion("devin/ask_question")).toBe(true);
    expect(methodLooksLikeDevinAskQuestion("_devin/ask_user_question")).toBe(true);
    expect(methodLooksLikeDevinAskQuestion("session/elicitation")).toBe(false);
  });

  it("parses question-array payloads and maps labels back to option ids", () => {
    const prompt = makeDevinAskQuestionPrompt({
      toolCallId: "ask-1",
      title: "Need input",
      questions: [
        {
          id: "scope",
          prompt: "Which scope should Devin use?",
          options: [
            { id: "workspace", label: "Workspace", description: "Use the workspace" },
            { id: "session", label: "Session" },
          ],
        },
      ],
    });

    expect(prompt?.questions).toEqual([
      {
        id: "scope",
        header: "Question",
        question: "Which scope should Devin use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Use the workspace" },
          { label: "Session", description: "Session" },
        ],
      },
    ]);
    expect(prompt?.makeResponse({ scope: "Workspace" })).toEqual({
      outcome: "accepted",
      answers: { scope: "workspace" },
    });
  });

  it("accepts wrapped payloads and simpler single-question payloads", () => {
    expect(
      parseDevinAskQuestionPayload({
        method: "devin/ask_question",
        params: {
          question: "Continue?",
          options: ["Yes", "No"],
        },
      }).map((question) => ({ id: question.id, question: question.question })),
    ).toEqual([{ id: "Continue?", question: "Continue?" }]);
  });
});
