import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { QuizToolkit } from "./tools.ts";
import * as QuizHandlers from "./handlers.ts";
import { shownTutorText } from "./handlers.ts";

const at = (second: number, role: string, text: string, id = `${role}-${second}`) => ({
  id,
  role,
  text,
  createdAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 16, 52, second)),
});

describe("quiz card reply visibility", () => {
  // Projection order from a real lesson: the queued send sits after the tutor's text,
  // and earlier card replies are appended last.
  it("counts real tutor text since the learner's last message, in time order", () => {
    const messages = [
      at(26, "user", "answer to card 1"),
      at(36, "assistant", "v".repeat(321)),
      at(31, "user", "queued send"),
      at(6, "assistant", "r".repeat(265), "toolu_1:reply"),
    ];
    expect(shownTutorText(messages)).toBe(321);
  });

  it("does not count promoted thinking summaries or course outlines", () => {
    const thinking = at(
      36,
      "assistant",
      "t".repeat(300),
      "message:provider:claudeAgent:native-item:msg_011CgpYTQZCUAf5iyjZ9S6jP%3Athinking%3A1",
    );
    const outline = at(40, "assistant", "o".repeat(400), "toolu_2:outline");
    expect(shownTutorText([at(26, "user", "answer"), thinking, outline])).toBe(0);
  });

  it("does not count a verdict paragraph after a card answer", () => {
    const verdict = "v".repeat(198);
    const answer = "The water beads on wax.\n\n(card card-1)";
    expect(shownTutorText([at(26, "user", answer), at(36, "assistant", verdict)])).toBe(0);
  });

  it("counts teaching after the verdict paragraph", () => {
    const verdict = "v".repeat(198);
    const teaching = "t".repeat(100);
    const answer = 'Quiz answer: "A", right.\n\n(card card-1)';
    expect(
      shownTutorText([at(26, "user", answer), at(36, "assistant", `${verdict}\n\n${teaching}`)]),
    ).toBe(teaching.length + 2);
  });

  it("subtracts a leading blank line with the verdict paragraph", () => {
    const verdict = "v".repeat(198);
    const teaching = "t".repeat(100);
    const answer = "The water beads on wax.\n\n(card card-1)";
    expect(
      shownTutorText([
        at(26, "user", answer),
        at(36, "assistant", `\n\n${verdict}\n\n${teaching}`),
      ]),
    ).toBe(teaching.length + 2);
  });

  it("keeps counting text after a non-answer user message", () => {
    const text = "v".repeat(198);
    expect(shownTutorText([at(26, "user", "not a card answer"), at(36, "assistant", text)])).toBe(
      text.length,
    );
  });

  it("counts a card reply but does not use it as the verdict", () => {
    const answer = "The water beads on wax.\n\n(card card-1)";
    const cardReply = "r".repeat(250);
    const verdict = "v".repeat(40);
    expect(
      shownTutorText([
        at(26, "user", answer),
        at(30, "assistant", cardReply, "card-1:reply"),
        at(36, "assistant", verdict),
      ]),
    ).toBe(cardReply.length);
  });
});

it.effect("folds source into both returned card replies", () =>
  Effect.gen(function* () {
    const toolkit = yield* QuizToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(QuizHandlers.layer)),
    );
    const quizResult = yield* toolkit
      .handle("quiz_card", {
        reply: "x".repeat(1990),
        source: "grader/bank/compose.py; docs/grading.md is out of date",
        purpose: "opening-check",
        answer: "A",
        explanation: "Because",
        level: "apply",
        question: "Which?",
        wrongOptions: [
          { option: "B", wrongIdea: "Mistake" },
          { option: "C", wrongIdea: "Another" },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(quizResult.at(-1)?.result).toMatchObject({
      quizCard: {
        reply: `${"x".repeat(1990)}\n\nSource: grader/bank/compose.py; docs/grading.md is out of date`,
      },
    });
    const questionResult = yield* toolkit
      .handle("question_card", {
        reply: "x".repeat(250),
        source: "",
        purpose: "opening-check",
        question: "Why?",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(questionResult.at(-1)?.result).toMatchObject({
      questionCard: { reply: "x".repeat(250) },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("quiz-handler-environment"),
          requestNamespace: "quiz-handler-provider-session",
          thread: {
            threadId: ThreadId.make("quiz-handler-test"),
            providerSessionId: "quiz-handler-provider-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => {
            const shell = McpToolAccessTestkit.liveThreadShell(ThreadId.make("quiz-handler-test"));
            return Effect.succeed(shell);
          },
          getProjectThreadRecords: () => {
            const shell = McpToolAccessTestkit.liveThreadShell(ThreadId.make("quiz-handler-test"));
            return Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell));
          },
        }),
      ),
    ),
  ),
);
