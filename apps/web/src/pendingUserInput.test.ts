import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  setPendingUserInputSelectedOption,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("resolves a custom answer when the explicit source is custom", () => {
    expect(
      resolvePendingUserInputAnswer({
        answerSource: "custom",
        selectedOptionLabel: "Keep current envelope",
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("resolves a selected option when the explicit source is option", () => {
    expect(
      resolvePendingUserInputAnswer({
        answerSource: "option",
        selectedOptionLabel: "Scaffold only",
        customAnswer: "Old custom answer",
      }),
    ).toBe("Scaffold only");
  });

  it("prefers a custom answer over a selected option for legacy drafts", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Keep current envelope",
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Scaffold only",
      }),
    ).toBe("Scaffold only");
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          answerSource: "option",
          selectedOptionLabel: "Preserve existing tags",
        },
        "doesn't matter",
      ),
    ).toEqual({
      answerSource: "custom",
      customAnswer: "doesn't matter",
    });
  });

  it("keeps the selected option active when custom text is cleared", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          answerSource: "option",
          selectedOptionLabel: "Preserve existing tags",
        },
        "",
      ),
    ).toEqual({
      answerSource: "option",
      selectedOptionLabel: "Preserve existing tags",
      customAnswer: "",
    });
  });

  it("sets the selected option as the explicit answer source", () => {
    expect(
      setPendingUserInputSelectedOption(
        {
          answerSource: "custom",
          customAnswer: "Keep the old custom answer",
        },
        "Preserve existing tags",
      ),
    ).toEqual({
      answerSource: "option",
      selectedOptionLabel: "Preserve existing tags",
      customAnswer: "",
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            answerSource: "option",
            selectedOptionLabel: "Orchestration-first",
          },
          compat: {
            answerSource: "custom",
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabel: "Orchestration-first",
        },
        compat: {
          answerSource: "custom",
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            answerSource: "option",
            selectedOptionLabel: "Orchestration-first",
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabel: "Orchestration-first",
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      usingCustomAnswer: false,
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("marks preset selections as active even if a stale custom value exists", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            answerSource: "option",
            selectedOptionLabel: "Orchestration-first",
            customAnswer: "stale custom answer",
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabel: "Orchestration-first",
      customAnswer: "stale custom answer",
      resolvedAnswer: "Orchestration-first",
      usingCustomAnswer: false,
    });
  });
});
