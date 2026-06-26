import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  extractXAiAskUserQuestions,
  extractXAiAcpSubagentUpdate,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiPromptCompletionRuntime,
  XAiAskUserQuestionRequest,
} from "./XAiAcpExtension.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const decodeXAiAskUserQuestionRequest = Schema.decodeUnknownSync(XAiAskUserQuestionRequest);

describe("XAiAcpExtension", () => {
  it("recognizes Grok Task starts as native subagents", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "inProgress",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
            model: "composer-2.5-fast",
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: "composer-2.5-fast",
      status: "running",
      childSessionId: null,
      result: null,
    });
  });

  it("extracts Grok child session lineage from completed Task output", () => {
    expect(
      extractXAiAcpSubagentUpdate({
        toolCallId: "task-1",
        title: "Task",
        status: "completed",
        data: {
          rawInput: {
            description: "Explore server architecture",
            prompt: "Audit apps/server.",
            subagent_type: "generalPurpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Server audit complete.",
              "",
              "Agent ID: 019f0220-e192-7c41-9e9d-b406bc3459c8 (resume supported)",
            ].join("\n"),
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "task-1",
      prompt: "Audit apps/server.",
      title: "Explore server architecture",
      model: null,
      status: "completed",
      childSessionId: "019f0220-e192-7c41-9e9d-b406bc3459c8",
      result: "Server audit complete.",
    });
  });

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

  it.effect("settles a hung prompt from a root-session prompt_complete notification", () =>
    Effect.gen(function* () {
      let promptCompleteHandler:
        | ((notification: {
            readonly sessionId: string;
            readonly promptId?: string;
            readonly stopReason?: string;
          }) => Effect.Effect<void>)
        | null = null;
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: () => Deferred.await(hungPrompt),
        cancel: Effect.void,
        handleExtNotification: (
          _method: string,
          _schema: unknown,
          handler: (notification: {
            readonly sessionId: string;
            readonly promptId?: string;
            readonly stopReason?: string;
          }) => Effect.Effect<void>,
        ) => {
          promptCompleteHandler = handler;
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(promptCompleteHandler).not.toBeNull();
      yield* promptCompleteHandler!({
        sessionId: "root-session",
        stopReason: "end_turn",
      });
      const response = yield* Fiber.join(promptFiber);
      expect(response.stopReason).toBe("end_turn");
    }),
  );

  it.effect("ignores prompt_complete notifications for foreign session ids", () =>
    Effect.gen(function* () {
      let promptCompleteHandler:
        | ((notification: { readonly sessionId: string }) => Effect.Effect<void>)
        | null = null;
      const hungPrompt = yield* Deferred.make<never>();
      const baseRuntime = {
        start: () =>
          Effect.succeed({
            sessionId: "root-session",
            initializeResult: {},
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        prompt: () => Deferred.await(hungPrompt),
        cancel: Effect.void,
        handleExtNotification: (
          _method: string,
          _schema: unknown,
          handler: (notification: { readonly sessionId: string }) => Effect.Effect<void>,
        ) => {
          promptCompleteHandler = handler;
          return Effect.void;
        },
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "hi" }] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* promptCompleteHandler!({
        sessionId: "child-session",
      });
      yield* Effect.yieldNow;
      expect(promptFiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(promptFiber);
    }),
  );

  it.effect("injects promptId and requestId into prompt _meta", () =>
    Effect.gen(function* () {
      let capturedMeta: Record<string, unknown> | null | undefined;
      const baseRuntime = {
        start: () => Effect.succeed({ sessionId: "session-1" }),
        prompt: (payload: { readonly _meta?: Record<string, unknown> | null }) => {
          capturedMeta = payload._meta ?? null;
          return Effect.succeed({ stopReason: "end_turn" as const });
        },
        cancel: Effect.void,
        handleExtNotification: () => Effect.void,
        handleExtRequest: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];

      const runtime = yield* makeXAiPromptCompletionRuntime(baseRuntime);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] });

      expect(typeof capturedMeta?.promptId).toBe("string");
      expect(capturedMeta).toMatchObject({
        promptId: capturedMeta?.promptId,
        requestId: capturedMeta?.promptId,
      });
    }),
  );
});
