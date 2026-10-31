import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import {
  reviewCommentContextRecord,
  reviewCommentContextReference,
  threadContextReference,
} from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import {
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  threadContextsReferencedByAnswer,
} from "./pendingUserInput";

describe("projectPendingUserInputAnswer", () => {
  const record = threadContextRecord(
    {
      environmentId: EnvironmentId.make("env-answer"),
      threadId: ThreadId.make("reference-thread"),
    },
    "Reference work",
  );

  it("sends thread chips as readable links with the actual thread ID", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(record))}`;
    expect(projectPendingUserInputAnswer(answer, [record])).toBe(
      "Compare [Reference work](t3-thread://v2/env-answer/reference-thread)",
    );
  });

  // regression: #28022 review comment chips in question answers reached the agent as bare links
  it("sends review comment chips with the comment text and diff", () => {
    const comment = {
      id: "review-comment-answer",
      sectionId: "working-tree",
      sectionTitle: "Working tree",
      filePath: "docs/plan.md",
      startIndex: 15,
      endIndex: 15,
      rangeLabel: "L16",
      text: "Rename this step to match the migration",
      diff: "+- Step 3: backfill legacy rows",
    };
    const reviewRecord = reviewCommentContextRecord(comment);
    const answer = `See ${formatInlineContextReference(reviewCommentContextReference(comment))}`;
    const projected = projectPendingUserInputAnswer(answer, [reviewRecord]);
    expect(projected).toContain(comment.text);
    expect(projected).toContain(comment.diff);
    expect(projected).not.toContain("t3-context://");
  });

  // regression: #18789 answers to pending questions lost exact text and option values
  it("preserves option values and exact answer text", () => {
    const options = [" first\t", "second"];
    expect(projectPendingUserInputAnswer(options, [record])).toBe(options);
    expect(projectPendingUserInputAnswer("  Edited answer\n", [record])).toBe("  Edited answer\n");
  });
});

describe("threadContextsReferencedByAnswer", () => {
  const kept = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("kept-thread") },
    "Kept work",
  );
  const deleted = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("deleted-thread") },
    "Deleted work",
  );

  it("preserves remaining chips without restoring deleted thread records", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(kept))}`;
    expect(threadContextsReferencedByAnswer(answer, [deleted, kept])).toEqual([kept]);
  });
});

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

  it("counts a deliberately cleared answer as answered", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    const drafts = { scope: { customAnswer: "" } };
    expect(derivePendingUserInputProgress([question], drafts, 0)).toMatchObject({
      customAnswer: "",
      resolvedAnswer: "",
      canAdvance: true,
      isComplete: true,
    });
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionValues: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  // regression: #12577 clicking a question option discarded typed text
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  // regression: #12577 clicking a question option discarded typed text
  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});
