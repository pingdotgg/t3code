import { describe, it, expect } from "vitest";
import type { UserInputQuestion } from "@t3tools/contracts";

import {
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  findFirstUnansweredPendingUserInputQuestionIndex,
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function singleSelectQuestion(overrides?: Partial<UserInputQuestion>): UserInputQuestion {
  return {
    id: "q1",
    header: "Color",
    question: "Pick a color",
    options: [
      { label: "Red", description: "A warm color" },
      { label: "Blue", description: "A cool color" },
      { label: "Green", description: "A natural color" },
    ],
    multiSelect: false,
    ...overrides,
  } as UserInputQuestion;
}

function multiSelectQuestion(overrides?: Partial<UserInputQuestion>): UserInputQuestion {
  return {
    id: "q2",
    header: "Toppings",
    question: "Choose toppings",
    options: [
      { label: "Cheese", description: "Melted cheese" },
      { label: "Pepperoni", description: "Spicy pepperoni" },
      { label: "Mushrooms", description: "Fresh mushrooms" },
    ],
    multiSelect: true,
    ...overrides,
  } as UserInputQuestion;
}

// ---------------------------------------------------------------------------
// togglePendingUserInputOptionSelection
// ---------------------------------------------------------------------------

describe("togglePendingUserInputOptionSelection", () => {
  it("single-select replaces previous selection", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Red"] };

    const result = togglePendingUserInputOptionSelection(question, draft, "Blue");
    expect(result.selectedOptionLabels).toEqual(["Blue"]);
    expect(result.customAnswer).toBe("");
  });

  it("single-select sets initial selection", () => {
    const question = singleSelectQuestion();
    const result = togglePendingUserInputOptionSelection(question, undefined, "Red");
    expect(result.selectedOptionLabels).toEqual(["Red"]);
  });

  it("multi-select toggles on", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Cheese"] };

    const result = togglePendingUserInputOptionSelection(question, draft, "Pepperoni");
    expect(result.selectedOptionLabels).toEqual(["Cheese", "Pepperoni"]);
  });

  it("multi-select toggles off", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Cheese", "Pepperoni"],
    };

    const result = togglePendingUserInputOptionSelection(question, draft, "Cheese");
    expect(result.selectedOptionLabels).toEqual(["Pepperoni"]);
  });

  it("multi-select removes selectedOptionLabels when last option toggled off", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Cheese"] };

    const result = togglePendingUserInputOptionSelection(question, draft, "Cheese");
    expect(result.selectedOptionLabels).toBeUndefined();
    expect(result.customAnswer).toBe("");
  });

  it("clears custom answer on option select", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { customAnswer: "Purple" };

    const result = togglePendingUserInputOptionSelection(question, draft, "Red");
    expect(result.customAnswer).toBe("");
    expect(result.selectedOptionLabels).toEqual(["Red"]);
  });

  it("handles undefined draft gracefully", () => {
    const question = multiSelectQuestion();
    const result = togglePendingUserInputOptionSelection(question, undefined, "Cheese");
    expect(result.selectedOptionLabels).toEqual(["Cheese"]);
    expect(result.customAnswer).toBe("");
  });

  it("deduplicates labels in multi-select", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Cheese", "Cheese"],
    };

    // Since normalization deduplicates, toggling "Cheese" off should result in empty
    const result = togglePendingUserInputOptionSelection(question, draft, "Cheese");
    expect(result.selectedOptionLabels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePendingUserInputAnswer
// ---------------------------------------------------------------------------

describe("resolvePendingUserInputAnswer", () => {
  it("returns string for single-select", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Red"] };
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("Red");
  });

  it("returns string[] for multi-select", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Cheese", "Pepperoni"],
    };
    expect(resolvePendingUserInputAnswer(question, draft)).toEqual(["Cheese", "Pepperoni"]);
  });

  it("custom answer takes priority over selections", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Red"],
      customAnswer: "Purple",
    };
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("Purple");
  });

  it("custom answer takes priority for multi-select too", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Cheese"],
      customAnswer: "Everything bagel",
    };
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("Everything bagel");
  });

  it("returns null when nothing selected", () => {
    const question = singleSelectQuestion();
    expect(resolvePendingUserInputAnswer(question, undefined)).toBeNull();
  });

  it("returns null for empty draft", () => {
    const question = singleSelectQuestion();
    expect(resolvePendingUserInputAnswer(question, {})).toBeNull();
  });

  it("returns null for multi-select with empty array", () => {
    const question = multiSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: [] };
    expect(resolvePendingUserInputAnswer(question, draft)).toBeNull();
  });

  it("returns null for whitespace-only custom answer", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { customAnswer: "   " };
    expect(resolvePendingUserInputAnswer(question, draft)).toBeNull();
  });

  it("trims custom answer", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { customAnswer: "  Purple  " };
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("Purple");
  });

  it("filters out empty strings from selectedOptionLabels", () => {
    const question = singleSelectQuestion();
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["", "  ", "Red"] };
    expect(resolvePendingUserInputAnswer(question, draft)).toBe("Red");
  });
});

// ---------------------------------------------------------------------------
// setPendingUserInputCustomAnswer
// ---------------------------------------------------------------------------

describe("setPendingUserInputCustomAnswer", () => {
  it("clears selected options when typing", () => {
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Red"] };
    const result = setPendingUserInputCustomAnswer(draft, "Purple");
    expect(result.customAnswer).toBe("Purple");
    expect(result.selectedOptionLabels).toBeUndefined();
  });

  it("restores selected options when clearing text", () => {
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: ["Red"],
      customAnswer: "Purple",
    };
    const result = setPendingUserInputCustomAnswer(draft, "");
    expect(result.customAnswer).toBe("");
    expect(result.selectedOptionLabels).toEqual(["Red"]);
  });

  it("handles undefined draft", () => {
    const result = setPendingUserInputCustomAnswer(undefined, "Custom");
    expect(result.customAnswer).toBe("Custom");
    expect(result.selectedOptionLabels).toBeUndefined();
  });

  it("restores selected options when custom answer is whitespace-only", () => {
    const draft: PendingUserInputDraftAnswer = { selectedOptionLabels: ["Red"] };
    const result = setPendingUserInputCustomAnswer(draft, "   ");
    expect(result.customAnswer).toBe("   ");
    // Whitespace-only trims to empty → restores previous options
    expect(result.selectedOptionLabels).toEqual(["Red"]);
  });

  it("preserves empty options list when clearing", () => {
    const draft: PendingUserInputDraftAnswer = {
      selectedOptionLabels: [],
      customAnswer: "something",
    };
    const result = setPendingUserInputCustomAnswer(draft, "");
    expect(result.customAnswer).toBe("");
    // Empty array normalizes to no key
    expect(result.selectedOptionLabels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildPendingUserInputAnswers
// ---------------------------------------------------------------------------

describe("buildPendingUserInputAnswers", () => {
  it("returns null if any question unanswered", () => {
    const questions = [singleSelectQuestion(), multiSelectQuestion()];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      // q2 missing
    };
    expect(buildPendingUserInputAnswers(questions, drafts)).toBeNull();
  });

  it("returns full answers map when all answered", () => {
    const questions = [singleSelectQuestion(), multiSelectQuestion()];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Cheese", "Pepperoni"] },
    };
    const result = buildPendingUserInputAnswers(questions, drafts);
    expect(result).toEqual({
      q1: "Red",
      q2: ["Cheese", "Pepperoni"],
    });
  });

  it("returns answers with mixed types", () => {
    const questions = [singleSelectQuestion(), multiSelectQuestion()];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { customAnswer: "Purple" },
      q2: { selectedOptionLabels: ["Cheese"] },
    };
    const result = buildPendingUserInputAnswers(questions, drafts);
    expect(result).toEqual({
      q1: "Purple",
      q2: ["Cheese"],
    });
  });

  it("handles empty questions list", () => {
    expect(buildPendingUserInputAnswers([], {})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// countAnsweredPendingUserInputQuestions
// ---------------------------------------------------------------------------

describe("countAnsweredPendingUserInputQuestions", () => {
  it("counts answered questions correctly", () => {
    const questions = [singleSelectQuestion(), multiSelectQuestion()];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(countAnsweredPendingUserInputQuestions(questions, drafts)).toBe(1);
  });

  it("returns 0 when none answered", () => {
    const questions = [singleSelectQuestion()];
    expect(countAnsweredPendingUserInputQuestions(questions, {})).toBe(0);
  });

  it("returns total when all answered", () => {
    const questions = [singleSelectQuestion(), multiSelectQuestion()];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Cheese"] },
    };
    expect(countAnsweredPendingUserInputQuestions(questions, drafts)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findFirstUnansweredPendingUserInputQuestionIndex
// ---------------------------------------------------------------------------

describe("findFirstUnansweredPendingUserInputQuestionIndex", () => {
  it("skips answered questions", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      singleSelectQuestion({ id: "q2" }),
      singleSelectQuestion({ id: "q3" }),
    ];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(findFirstUnansweredPendingUserInputQuestionIndex(questions, drafts)).toBe(1);
  });

  it("returns last index when all answered", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      singleSelectQuestion({ id: "q2" }),
    ];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Blue"] },
    };
    expect(findFirstUnansweredPendingUserInputQuestionIndex(questions, drafts)).toBe(1);
  });

  it("returns 0 when none answered", () => {
    const questions = [singleSelectQuestion()];
    expect(findFirstUnansweredPendingUserInputQuestionIndex(questions, {})).toBe(0);
  });

  it("returns 0 for empty questions", () => {
    expect(findFirstUnansweredPendingUserInputQuestionIndex([], {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// derivePendingUserInputProgress
// ---------------------------------------------------------------------------

describe("derivePendingUserInputProgress", () => {
  it("correct progress for middle question", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      multiSelectQuestion({ id: "q2" }),
      singleSelectQuestion({ id: "q3" }),
    ];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Cheese"] },
    };

    const progress = derivePendingUserInputProgress(questions, drafts, 1);
    expect(progress.questionIndex).toBe(1);
    expect(progress.activeQuestion?.id).toBe("q2");
    expect(progress.selectedOptionLabels).toEqual(["Cheese"]);
    expect(progress.answeredQuestionCount).toBe(2);
    expect(progress.isLastQuestion).toBe(false);
  });

  it("isComplete true only when all answered", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      singleSelectQuestion({ id: "q2" }),
    ];

    const partialDrafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(derivePendingUserInputProgress(questions, partialDrafts, 0).isComplete).toBe(false);

    const fullDrafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Blue"] },
    };
    expect(derivePendingUserInputProgress(questions, fullDrafts, 0).isComplete).toBe(true);
  });

  it("canAdvance tracks current question answer state", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];

    // Not answered
    expect(derivePendingUserInputProgress(questions, {}, 0).canAdvance).toBe(false);

    // Answered
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).canAdvance).toBe(true);
  });

  it("canAdvance true with custom answer", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { customAnswer: "Purple" },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).canAdvance).toBe(true);
  });

  it("isLastQuestion for the last index", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      singleSelectQuestion({ id: "q2" }),
    ];
    expect(derivePendingUserInputProgress(questions, {}, 0).isLastQuestion).toBe(false);
    expect(derivePendingUserInputProgress(questions, {}, 1).isLastQuestion).toBe(true);
  });

  it("clamps out-of-bound question index to summary state", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const progress = derivePendingUserInputProgress(questions, {}, 999);
    expect(progress.questionIndex).toBe(1);
    expect(progress.activeQuestion).toBe(null);
  });

  it("allows questionIndex === questions.length for summary state", () => {
    const questions = [
      singleSelectQuestion({ id: "q1" }),
      singleSelectQuestion({ id: "q2" }),
    ];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
      q2: { selectedOptionLabels: ["Blue"] },
    };

    const progress = derivePendingUserInputProgress(questions, drafts, 2);
    expect(progress.questionIndex).toBe(2);
    expect(progress.activeQuestion).toBe(null);
    expect(progress.isComplete).toBe(true);
  });

  it("normalizes negative question index", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const progress = derivePendingUserInputProgress(questions, {}, -1);
    expect(progress.questionIndex).toBe(0);
  });

  it("handles empty questions list", () => {
    const progress = derivePendingUserInputProgress([], {}, 0);
    expect(progress.questionIndex).toBe(0);
    expect(progress.activeQuestion).toBeNull();
    expect(progress.isLastQuestion).toBe(true);
    expect(progress.isComplete).toBe(true);
    expect(progress.canAdvance).toBe(false);
  });

  it("usingCustomAnswer is true when custom answer has content", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { customAnswer: "Custom" },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).usingCustomAnswer).toBe(true);
  });

  it("usingCustomAnswer is false when custom answer is empty", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).usingCustomAnswer).toBe(false);
  });

  it("resolvedAnswer returns string for single-select", () => {
    const questions = [singleSelectQuestion({ id: "q1" })];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabels: ["Red"] },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).resolvedAnswer).toBe("Red");
  });

  it("resolvedAnswer returns string[] for multi-select", () => {
    const questions = [multiSelectQuestion({ id: "q2" })];
    const drafts: Record<string, PendingUserInputDraftAnswer> = {
      q2: { selectedOptionLabels: ["Cheese", "Pepperoni"] },
    };
    expect(derivePendingUserInputProgress(questions, drafts, 0).resolvedAnswer).toEqual([
      "Cheese",
      "Pepperoni",
    ]);
  });
});
