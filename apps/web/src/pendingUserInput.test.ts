import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import { threadContextReference } from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import {
  answerContextRecords,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  threadContextsReferencedByAnswer,
  withdrawDisplacedCustomAnswerFromPrompt,
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

  // regression: #28022, #36293 review comment and preview annotation chips in an answer reached the agent as bare links
  it("sends thread draft chips with their full content", () => {
    const reviewComment = {
      id: "file-comment-1",
      sectionId: "branch",
      sectionTitle: "Changes",
      filePath: "notes.md",
      startIndex: 2,
      endIndex: 2,
      rangeLabel: "+2",
      text: "Rename this to line two updated",
      diff: "@@ -0,0 +2,1 @@\n+line two changed",
      fenceLanguage: "diff",
    };
    const annotation = {
      id: "annotation-1",
      pageUrl: "http://localhost:3000/",
      pageTitle: "Home",
      comment: "FIRST NOTE: this features section looks too bare; add three feature cards",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const records = answerContextRecords(undefined, {
      reviewComments: [reviewComment],
      previewAnnotations: [annotation],
    });
    const answer = `See my notes: ${records
      .map((record) =>
        formatInlineContextReference({
          kind: record.kind,
          contextId: record.contextId,
          label: record.label,
        }),
      )
      .join(" ")}`;
    const projected = projectPendingUserInputAnswer(answer, records);
    expect(projected).toContain("Rename this to line two updated");
    expect(projected).toContain("+line two changed");
    expect(projected).toContain(`comment: ${annotation.comment}`);
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

describe("withdrawDisplacedCustomAnswerFromPrompt", () => {
  // regression: #35205 an answer restored with undo stayed in the thread draft and was sent twice
  it("takes set-aside text back out of the thread draft and leaves the rest", () => {
    const setAside = carryDisplacedCustomAnswerIntoPrompt("", "first answer ");
    expect(withdrawDisplacedCustomAnswerFromPrompt(setAside, "first answer ")).toBe("");

    const afterDraft = carryDisplacedCustomAnswerIntoPrompt("draft", "first answer");
    expect(withdrawDisplacedCustomAnswerFromPrompt(afterDraft, "first answer")).toBe("draft");

    const beforeSecond = carryDisplacedCustomAnswerIntoPrompt(setAside, "second answer");
    expect(
      withdrawDisplacedCustomAnswerFromPrompt(beforeSecond, "first answer", ["second answer"]),
    ).toBe("second answer");

    const between = carryDisplacedCustomAnswerIntoPrompt(afterDraft, "second answer");
    expect(
      withdrawDisplacedCustomAnswerFromPrompt(between, "first answer", ["second answer"]),
    ).toBe("draft\n\nsecond answer");
  });

  it("removes its own copy, not equal text inside a later set-aside answer", () => {
    const first = carryDisplacedCustomAnswerIntoPrompt("", "foo");
    const both = carryDisplacedCustomAnswerIntoPrompt(first, "bar\n\nfoo");
    expect(withdrawDisplacedCustomAnswerFromPrompt(both, "foo", ["bar\n\nfoo"])).toBe("bar\n\nfoo");
  });

  it("leaves a thread draft that no longer holds the set-aside text where it was put", () => {
    expect(withdrawDisplacedCustomAnswerFromPrompt("first answer, edited", "first answer")).toBe(
      "first answer, edited",
    );
    expect(withdrawDisplacedCustomAnswerFromPrompt("my first answer", "first answer")).toBe(
      "my first answer",
    );
    expect(withdrawDisplacedCustomAnswerFromPrompt("draft", "  ")).toBe("draft");
  });
});
