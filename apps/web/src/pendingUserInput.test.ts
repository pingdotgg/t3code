import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import { reviewCommentContextRecord, threadContextReference } from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { resolvePendingUserInputAnswer } from "@t3tools/client-runtime/state/pending-user-input";

import {
  applyPendingUserInputOptionKeys,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  removePendingUserInputOptionKey,
  setPendingUserInputAnswerText,
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

  // regression: #28022 a review comment chip in an answer reached the agent as a bare link
  it("sends review comment chips with the comment text and diff", () => {
    const comment = reviewCommentContextRecord({
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
    });
    const answer = `See my note: ${formatInlineContextReference({
      kind: "review-comment",
      contextId: comment.contextId,
      label: comment.label,
    })}`;
    const projected = projectPendingUserInputAnswer(answer, [comment]);
    expect(projected).toContain("Rename this to line two updated");
    expect(projected).toContain("+line two changed");
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

describe("option keys typed into the answer field", () => {
  const steps = {
    id: "steps",
    header: "Release go",
    question: "Which steps may I take?",
    options: [
      { label: "Push", description: "Push the merge commit" },
      { label: "Merge", description: "Merge once green" },
      { label: "Open PR", description: "Docs only" },
    ],
    multiSelect: true,
  };
  const channel = {
    id: "channel",
    header: "Channel",
    question: "Which channel first?",
    options: [
      { label: "Beta", description: "Testers" },
      { label: "Stable", description: "Everyone" },
    ],
    multiSelect: false,
  };
  type Draft = Parameters<typeof setPendingUserInputAnswerText>[1];
  const shown = (question: typeof steps | typeof channel, draft: Draft) =>
    applyPendingUserInputOptionKeys(question, draft);
  // Each key lands at the end of the text the field shows.
  const type = (question: typeof steps | typeof channel, text: string, draft?: Draft) =>
    [...text].reduce<Draft>(
      (current, character) =>
        setPendingUserInputAnswerText(
          question,
          current,
          (shown(question, current)?.customAnswer ?? "") + character,
        ),
      draft,
    );

  it("picks options while only option numbers are typed, then turns them into text", () => {
    const picking = type(steps, "132");
    expect(shown(steps, picking)).toMatchObject({
      customAnswer: "",
      selectedOptionValues: ["Push", "Open PR", "Merge"],
    });
    expect(resolvePendingUserInputAnswer(steps, shown(steps, picking))).toEqual([
      "Push",
      "Open PR",
      "Merge",
    ]);

    const typed = type(steps, " is the project id", picking);
    expect(shown(steps, typed)).toEqual({ customAnswer: "132 is the project id" });
    expect(resolvePendingUserInputAnswer(steps, shown(steps, typed))).toBe("132 is the project id");
  });

  it("picks the last number on a single choice and keeps it as text once more follows", () => {
    expect(shown(channel, type(channel, "2"))).toMatchObject({ selectedOptionValues: ["Stable"] });
    expect(shown(channel, type(channel, "2, after the infra review"))).toEqual({
      customAnswer: "2, after the infra review",
    });
    expect(shown(channel, type(channel, "3"))).toEqual({ customAnswer: "3" });

    const choiceOnly = { ...channel, allowCustomAnswer: false };
    expect(shown(choiceOnly, type(choiceOnly, "2"))).toMatchObject({
      selectedOptionValues: ["Stable"],
    });
    // A choice-only question has no text to fall back to, so other keys change nothing.
    expect(shown(choiceOnly, type(choiceOnly, "2,"))).toMatchObject({
      selectedOptionValues: ["Stable"],
    });
  });

  it("toggles on top of earlier picks, and Backspace takes the last number back", () => {
    const clicked = { selectedOptionValues: ["Push"] };
    const typed = type(steps, "12", clicked);
    expect(shown(steps, typed)?.selectedOptionValues).toEqual(["Merge"]);

    const undone = removePendingUserInputOptionKey(steps, typed) ?? undefined;
    expect(shown(steps, undone)?.selectedOptionValues).toEqual([]);
    const cleared = removePendingUserInputOptionKey(steps, undone) ?? undefined;
    expect(shown(steps, cleared)?.selectedOptionValues).toEqual(["Push"]);
    expect(removePendingUserInputOptionKey(steps, type(steps, "1 more"))).toBeNull();
  });
});
