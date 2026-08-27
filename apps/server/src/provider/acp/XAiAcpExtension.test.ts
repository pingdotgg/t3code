// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAskUserQuestions,
  extractXAiExitPlanMarkdown,
  isGrokPlanMarkdownPath,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeCapturedResponse,
  makeXAiPromptCompletionRuntime,
  XAI_EMPTY_PLAN_MARKDOWN,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
} from "./XAiAcpExtension.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makePromptCompletionRuntime = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime.make({
      spawn: {
        command: process.execPath,
        args: [mockAgentPath],
        env,
      },
      cwd: process.cwd(),
      clientInfo: { name: "t3-test", version: "0.0.0" },
      authMethodId: "test",
    });
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

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

  it.effect("resolves a hung standard prompt from xAI prompt completion", () =>
    Effect.gen(function* () {
      const runtime = yield* makePromptCompletionRuntime({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
      });
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      const promptId = promptResult._meta?.promptId;

      expect(typeof promptId).toBe("string");
      expect(promptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: {
          sessionId: "mock-session-1",
          promptId,
          requestId: promptId,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails a hung standard prompt from an xAI rate-limit completion", () =>
    Effect.gen(function* () {
      const runtime = yield* makePromptCompletionRuntime({
        T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG: "1",
      });
      yield* runtime.start();

      const error = yield* Effect.flip(
        runtime.prompt({
          prompt: [{ type: "text", text: "hi" }],
        }),
      );

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32003,
        errorMessage: "Grok usage limit reached. Try again later.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores stale xAI completion from an already settled prompt", () =>
    Effect.gen(function* () {
      const runtime = yield* makePromptCompletionRuntime({
        T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG: "1",
      });
      yield* runtime.start();

      const firstPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "first" }],
      });
      expect(firstPromptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: { promptId: "mock-stale-xai-prompt-1" },
      });

      const secondPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      });
      const secondPromptId = secondPromptResult._meta?.promptId;
      expect(typeof secondPromptId).toBe("string");
      expect(secondPromptId).not.toBe("mock-stale-xai-prompt-1");
      expect(secondPromptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: {
          promptId: secondPromptId,
          requestId: secondPromptId,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("extracts plan markdown from exit_plan_mode payloads", () => {
    const decode = Schema.decodeUnknownSync(XAiExitPlanModeRequest);
    const direct = decode({
      sessionId: "session-1",
      toolCallId: "exit-1",
      planContent: "# Plan\n\n- do the thing\n",
    });
    expect(extractXAiExitPlanMarkdown(direct)).toBe("# Plan\n\n- do the thing");

    const wrapped = decode({
      method: "_x.ai/exit_plan_mode",
      params: {
        sessionId: "session-1",
        toolCallId: "exit-1",
        planContent: null,
      },
    });
    expect(extractXAiExitPlanMarkdown(wrapped, "  # fallback plan  ")).toBe("# fallback plan");
    expect(extractXAiExitPlanMarkdown(wrapped, "")).toBe(XAI_EMPTY_PLAN_MARKDOWN);
    expect(extractXAiExitPlanMarkdown(wrapped)).toBe(XAI_EMPTY_PLAN_MARKDOWN);
  });

  it("builds an abandoned exit_plan_mode response that captures the plan", () => {
    expect(makeXAiExitPlanModeCapturedResponse()).toEqual({
      outcome: "abandoned",
      feedback:
        "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
    });
  });

  it("identifies Grok plan.md paths and extracts markdown from tool call data", () => {
    const linuxHost = { platform: "linux" as const, environment: {} };
    const windowsHost = { platform: "win32" as const, environment: {} };
    const grokHomeHost = {
      platform: "linux" as const,
      environment: { GROK_HOME: "/opt/grok-data" },
    };
    const home = NodeOS.homedir().replace(/\\/g, "/");
    const sessionPlan = `${home}/.grok/sessions/abc/plan.md`;
    const nestedSessionPlan = `${home}/.grok/sessions/%2Fhome%2Fproj/019fd20e-c563-70a0-b801-a6bc51815a9b/plan.md`;
    expect(isGrokPlanMarkdownPath(sessionPlan, linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath(nestedSessionPlan, linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("~/.grok/sessions/abc/plan.md", linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("/tmp/mock-home/.grok/sessions/sess/plan.md", linuxHost)).toBe(
      true,
    );
    expect(isGrokPlanMarkdownPath("/home/other/.grok/sessions/sess/plan.md", linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("/HOME/other/.grok/sessions/sess/plan.md", linuxHost)).toBe(
      false,
    );
    expect(isGrokPlanMarkdownPath("C:/Users/other/.grok/sessions/id/plan.md", windowsHost)).toBe(
      true,
    );
    expect(isGrokPlanMarkdownPath("c:/users/OTHER/.GROK/SESSIONS/id/PLAN.MD", windowsHost)).toBe(
      true,
    );
    expect(
      isGrokPlanMarkdownPath("C:\\Users\\other\\.grok\\sessions\\id\\plan.md", windowsHost),
    ).toBe(true);
    expect(isGrokPlanMarkdownPath("/opt/grok-data/sessions/sess/plan.md", grokHomeHost)).toBe(true);
    expect(
      isGrokPlanMarkdownPath("/OPT/GROK-DATA/sessions/sess/plan.md", {
        platform: "win32",
        environment: { GROK_HOME: "/opt/grok-data" },
      }),
    ).toBe(true);
    expect(isGrokPlanMarkdownPath("/OPT/GROK-DATA/sessions/sess/plan.md", grokHomeHost)).toBe(
      false,
    );
    // Workspace plan.md must not be treated as the session plan file.
    expect(isGrokPlanMarkdownPath("plan.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/repo/docs/plan.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/tmp/other.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/repo/.grok/sessions/example/plan.md", linuxHost)).toBe(false);
    expect(
      isGrokPlanMarkdownPath(`${home}/project/.grok/sessions/example/plan.md`, linuxHost),
    ).toBe(false);
    expect(
      isGrokPlanMarkdownPath("/home/other/.grok/sessions/../../project/plan.md", linuxHost),
    ).toBe(false);
    expect(
      isGrokPlanMarkdownPath("/home/other/.grok/sessions/foo/../../../project/plan.md", linuxHost),
    ).toBe(false);

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: {
            file_path: sessionPlan,
            content: "# From rawInput\n\n- a\n",
          },
        },
        linuxHost,
      ),
    ).toBe("# From rawInput\n\n- a");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          content: [
            {
              type: "diff",
              path: sessionPlan,
              oldText: "",
              newText: "# From diff\n\n- b\n",
            },
          ],
        },
        linuxHost,
      ),
    ).toBe("# From diff\n\n- b");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: sessionPlan, content: "" },
          content: [
            {
              type: "diff",
              path: sessionPlan,
              oldText: "",
              newText: "# From diff after empty rawInput\n",
            },
          ],
        },
        linuxHost,
      ),
    ).toBe("# From diff after empty rawInput");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: sessionPlan, content: "" },
        },
        linuxHost,
      ),
    ).toBe("");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          content: [{ type: "diff", path: sessionPlan, oldText: "# old", newText: "" }],
        },
        linuxHost,
      ),
    ).toBe("");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: "/tmp/readme.md", content: "nope" },
        },
        linuxHost,
      ),
    ).toBeUndefined();

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: "/repo/docs/plan.md", content: "# Project plan\n" },
        },
        linuxHost,
      ),
    ).toBeUndefined();
  });
});
