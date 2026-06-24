import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  setPendingUserInputSelectedOption,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("resolves a custom answer when the explicit source is custom", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        answerSource: "custom",
        selectedOptionLabels: ["Keep current envelope"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("resolves a selected option when the explicit source is option", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        answerSource: "option",
        selectedOptionLabels: ["Scaffold only"],
        customAnswer: "Old custom answer",
      }),
    ).toBe("Scaffold only");
  });

  it("prefers a custom answer over a selected option for legacy drafts", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          answerSource: "option",
          selectedOptionLabels: ["Preserve existing tags"],
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
          selectedOptionLabels: ["Preserve existing tags"],
        },
        "",
      ),
    ).toEqual({
      answerSource: "option",
      selectedOptionLabels: ["Preserve existing tags"],
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
      selectedOptionLabels: ["Preserve existing tags"],
      customAnswer: "",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        answerSource: "option",
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      answerSource: "option",
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
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
            multiSelect: false,
          },
        ],
        {
          scope: {
            answerSource: "option",
            selectedOptionLabels: ["Orchestration-first"],
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

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
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
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          answerSource: "option",
          selectedOptionLabels: ["Orchestration-first"],
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
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      usingCustomAnswer: false,
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });

  it("marks preset selections as active even if a stale custom value exists", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            answerSource: "option",
            selectedOptionLabels: ["Orchestration-first"],
            customAnswer: "stale custom answer",
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "stale custom answer",
      resolvedAnswer: "Orchestration-first",
      usingCustomAnswer: false,
    });
  });
});
