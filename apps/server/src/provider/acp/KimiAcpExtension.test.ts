import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  extractKimiAskUserQuestions,
  isKimiAskUserQuestionRequest,
  kimiAskUserQuestionSkipOptionId,
  selectKimiAskUserQuestionOptionId,
} from "./KimiAcpExtension.ts";

const makeRequest = (overrides?: {
  title?: string;
  content?: EffectAcpSchema.RequestPermissionRequest["toolCall"]["content"];
  rawInput?: unknown;
  options?: ReadonlyArray<{ optionId: string; name: string; kind: "allow_once" | "reject_once" }>;
}): EffectAcpSchema.RequestPermissionRequest => ({
  sessionId: "session-1",
  toolCall: {
    toolCallId: "tool-call-1",
    ...(overrides?.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides?.content !== undefined ? { content: overrides.content } : {}),
    ...(overrides?.rawInput !== undefined ? { rawInput: overrides.rawInput } : {}),
  },
  options: [...(overrides?.options ?? [])],
});

const questionRequest = makeRequest({
  title: "AskUserQuestion",
  content: [
    {
      type: "content",
      content: { type: "text", text: "Which scope should Kimi use?" },
    },
  ],
  options: [
    { optionId: "q0_opt_0", name: "Workspace", kind: "allow_once" },
    { optionId: "q0_opt_1", name: "Session", kind: "allow_once" },
    { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
  ],
});

describe("isKimiAskUserQuestionRequest", () => {
  it("detects requests by the AskUserQuestion tool call title", () => {
    expect(
      isKimiAskUserQuestionRequest(
        makeRequest({
          title: "AskUserQuestion",
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
        }),
      ),
    ).toBe(true);
  });

  it("detects requests by q-style option ids", () => {
    expect(
      isKimiAskUserQuestionRequest(
        makeRequest({
          title: "Something else",
          options: [{ optionId: "q1_opt_0", name: "Yes", kind: "allow_once" }],
        }),
      ),
    ).toBe(true);
  });

  it("ignores ordinary permission requests", () => {
    expect(
      isKimiAskUserQuestionRequest(
        makeRequest({
          title: "`cat package.json`",
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("extractKimiAskUserQuestions", () => {
  it("builds a structured question from the CLI permission bridge shape", () => {
    expect(extractKimiAskUserQuestions(questionRequest)).toEqual([
      {
        id: "q0",
        header: "Question",
        question: "Which scope should Kimi use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Workspace" },
          { label: "Session", description: "Session" },
        ],
      },
    ]);
  });

  it("falls back to the raw input question text when content has no text", () => {
    const request = makeRequest({
      title: "AskUserQuestion",
      rawInput: { question: "Pick a color" },
      options: [{ optionId: "q0_opt_0", name: "Red", kind: "allow_once" }],
    });

    expect(extractKimiAskUserQuestions(request)[0]?.question).toBe("Pick a color");
  });

  it("uses the tool call title when it is not the AskUserQuestion marker", () => {
    const request = makeRequest({
      title: "Which scope?",
      options: [{ optionId: "q0_opt_0", name: "Workspace", kind: "allow_once" }],
    });

    expect(extractKimiAskUserQuestions(request)[0]?.question).toBe("Which scope?");
  });
});

describe("selectKimiAskUserQuestionOptionId", () => {
  it("maps an answer keyed by question id to the matching option", () => {
    expect(selectKimiAskUserQuestionOptionId(questionRequest, { q0: "Session" })).toBe("q0_opt_1");
  });

  it("maps an answer keyed by question text to the matching option", () => {
    expect(
      selectKimiAskUserQuestionOptionId(questionRequest, {
        "Which scope should Kimi use?": "Workspace",
      }),
    ).toBe("q0_opt_0");
  });

  it("returns undefined when no answer matches an option label", () => {
    expect(selectKimiAskUserQuestionOptionId(questionRequest, { q0: "Something custom" })).toBe(
      undefined,
    );
    expect(selectKimiAskUserQuestionOptionId(questionRequest, {})).toBe(undefined);
  });
});

describe("kimiAskUserQuestionSkipOptionId", () => {
  it("returns the skip option id", () => {
    expect(kimiAskUserQuestionSkipOptionId(questionRequest)).toBe("q0_skip");
  });

  it("returns undefined when no skip option exists", () => {
    expect(
      kimiAskUserQuestionSkipOptionId(
        makeRequest({
          title: "AskUserQuestion",
          options: [{ optionId: "q0_opt_0", name: "Workspace", kind: "allow_once" }],
        }),
      ),
    ).toBe(undefined);
  });
});
