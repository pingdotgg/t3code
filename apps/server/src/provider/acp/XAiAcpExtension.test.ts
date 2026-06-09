import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  XAiAskUserQuestionRequest,
} from "./XAiAcpExtension.ts";

const decodeXAiAskUserQuestionRequest = Schema.decodeUnknownSync(XAiAskUserQuestionRequest);

describe("XAiAcpExtension", () => {
  it("extracts questions from the real xAI ask_user_question payload shape", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          id: "scope",
          question: "Which scope should Grok use?",
          options: [
            { label: "Workspace", description: "Use the current workspace" },
            { label: "Session", description: "Only use this session" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "scope",
        header: "Question",
        question: "Which scope should Grok use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Use the current workspace" },
          { label: "Session", description: "Only use this session" },
        ],
      },
    ]);
  });

  it("extracts questions from wrapped _x.ai extension payloads", () => {
    const payload = {
      method: "_x.ai/ask_user_question",
      params: {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "plan",
        questions: [
          {
            question: "Which changes should be included?",
            multiSelect: true,
            options: [{ label: "Tests" }, { label: "Docs" }],
          },
        ],
      },
    };
    const decoded = decodeXAiAskUserQuestionRequest(payload);
    const questions = extractXAiAskUserQuestions(decoded);

    expect(questions).toEqual([
      {
        id: "Which changes should be included?",
        header: "Question",
        question: "Which changes should be included?",
        multiSelect: true,
        options: [
          { label: "Tests", description: "Tests" },
          { label: "Docs", description: "Docs" },
        ],
      },
    ]);
  });

  it("treats nullable multiSelect from Grok as single-select", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          question: "Which label should Grok use?",
          multiSelect: null,
          options: [
            { label: "Alpha", description: "Use the Alpha label" },
            { label: "Beta", description: "Use the Beta label" },
            { label: "Other", description: "Use the Other label" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "Which label should Grok use?",
        header: "Question",
        question: "Which label should Grok use?",
        multiSelect: false,
        options: [
          { label: "Alpha", description: "Use the Alpha label" },
          { label: "Beta", description: "Use the Beta label" },
          { label: "Other", description: "Use the Other label" },
        ],
      },
    ]);
  });

  it("maps UI question ids back to xAI question text in accepted responses", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "scope",
            question: "Which scope should Grok use?",
            options: [
              { label: "workspace", description: "Use the current workspace" },
              { label: "session", description: "Only use this session" },
            ],
          },
        ],
      },
      { scope: "workspace" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which scope should Grok use?": ["workspace"],
      },
    });
  });

  it("orders accepted answers by the original xAI question order", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "first",
            question: "First question?",
            options: [{ label: "A", description: "A" }],
          },
          {
            id: "second",
            question: "Second question?",
            options: [{ label: "B", description: "B" }],
          },
        ],
      },
      {
        second: "B",
        first: "A",
      },
    );

    expect(Object.keys(response.answers)).toEqual(["First question?", "Second question?"]);
    expect(response).toMatchObject({
      outcome: "accepted",
      answers: {
        "First question?": ["A"],
        "Second question?": ["B"],
      },
    });
  });

  it("encodes typed custom answers as xAI Other annotations", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        method: "x.ai/ask_user_question",
        params: {
          sessionId: "session-1",
          toolCallId: "tool-call-1",
          mode: "default",
          questions: [
            {
              question: "Which ice cream flavor?",
              options: [
                { label: "vanilla", description: "Vanilla flavor" },
                { label: "chocolate", description: "Chocolate flavor" },
              ],
            },
          ],
        },
      },
      { "Which ice cream flavor?": "pistachio" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which ice cream flavor?": ["Other"],
      },
      annotations: {
        "Which ice cream flavor?": {
          notes: "pistachio",
        },
      },
    });
  });

  it("encodes interrupted dialogs as xAI cancelled responses", () => {
    expect(makeXAiAskUserQuestionCancelledResponse()).toEqual({
      outcome: "cancelled",
    });
  });

  it("does not echo preview annotations for multi-select answers", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            question: "Which files should Grok touch?",
            multiSelect: true,
            options: [
              {
                label: "Tests",
                description: "Update tests",
                preview: "test preview",
              },
              {
                label: "Docs",
                description: "Update docs",
                preview: "docs preview",
              },
            ],
          },
        ],
      },
      { "Which files should Grok touch?": ["Tests", "Docs"] },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which files should Grok touch?": ["Tests", "Docs"],
      },
    });
  });
});
