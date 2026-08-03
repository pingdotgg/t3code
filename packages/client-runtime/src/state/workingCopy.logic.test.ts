import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  COMMIT_SUBJECT_HARD_LIMIT,
  COMMIT_SUBJECT_SOFT_LIMIT,
  commitDraftKey,
  commitMessageGenerationApply,
  commitMessageGenerationLabel,
  commitMessageGenerationState,
  commitPrimaryAction,
  commitPrimaryActionLabel,
  commitSubjectLengthState,
  historyAuthorFacets,
  historyFilterKey,
  isAmendCommitEnabled,
  isCommitAndPushEnabled,
  isCommitPrimaryActionEnabled,
  shouldPrefillAmendMessage,
  isHashIshQuery,
  isHistoryFilterActive,
  joinCommitMessage,
  matchesHistoryFilter,
  mergeHistorySearchResults,
  nextStatusFailureStreak,
  shouldPollWorkingCopy,
  shouldShowStatusErrorBanner,
  splitCommitMessage,
} from "./workingCopy.logic.ts";

function entry(overrides: Partial<WorkingCopyLogEntry> & { hash: string }): WorkingCopyLogEntry {
  return {
    shortHash: overrides.hash.slice(0, 7),
    subject: "a subject",
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authoredAt: "2024-05-01T10:00:00+00:00",
    parents: [],
    ...overrides,
  };
}

describe("commit message parts", () => {
  it("splits on the first blank line", () => {
    expect(splitCommitMessage("subject\n\nbody line 1\nbody line 2")).toEqual({
      subject: "subject",
      body: "body line 1\nbody line 2",
    });
  });

  it("treats a single newline as a subject/body break too", () => {
    expect(splitCommitMessage("subject\nbody")).toEqual({ subject: "subject", body: "body" });
  });

  it("normalizes CRLF so a Windows paste does not leave a stray \\r in the subject", () => {
    expect(splitCommitMessage("subject\r\n\r\nbody")).toEqual({ subject: "subject", body: "body" });
  });

  it("has no body when there is no separator", () => {
    expect(splitCommitMessage("just a subject")).toEqual({ subject: "just a subject", body: "" });
  });

  it("round-trips through join", () => {
    const message = "subject\n\nbody one\n\nbody two";
    expect(joinCommitMessage(splitCommitMessage(message))).toBe(message);
  });

  it("omits the blank line when the body is only whitespace", () => {
    expect(joinCommitMessage({ subject: "subject", body: "   \n " })).toBe("subject");
  });
});

describe("commitSubjectLengthState", () => {
  it("is ok at the soft limit and soft one past it", () => {
    expect(commitSubjectLengthState("x".repeat(COMMIT_SUBJECT_SOFT_LIMIT))).toBe("ok");
    expect(commitSubjectLengthState("x".repeat(COMMIT_SUBJECT_SOFT_LIMIT + 1))).toBe("soft");
  });

  it("is hard only past the hard limit", () => {
    expect(commitSubjectLengthState("x".repeat(COMMIT_SUBJECT_HARD_LIMIT))).toBe("soft");
    expect(commitSubjectLengthState("x".repeat(COMMIT_SUBJECT_HARD_LIMIT + 1))).toBe("hard");
  });
});

describe("commitDraftKey", () => {
  it("is the cwd, so two worktrees of one repo keep separate drafts", () => {
    expect(commitDraftKey("/repo/main")).not.toBe(commitDraftKey("/repo/.worktrees/feature"));
  });
});

describe("commitPrimaryAction", () => {
  it("commits the staged subset when anything is staged", () => {
    expect(commitPrimaryAction({ amend: false, stagedCount: 2, dirtyCount: 5, ahead: 0 })).toBe(
      "commit",
    );
  });

  it("offers commit all only when nothing is staged", () => {
    expect(commitPrimaryAction({ amend: false, stagedCount: 0, dirtyCount: 3, ahead: 0 })).toBe(
      "commit-all",
    );
  });

  it("falls through to push on a clean tree that is ahead", () => {
    expect(commitPrimaryAction({ amend: false, stagedCount: 0, dirtyCount: 0, ahead: 4 })).toBe(
      "push",
    );
    expect(commitPrimaryActionLabel("push", 4)).toBe("Push 4");
  });

  it("never disappears — a clean tree with nothing to push still shows Commit", () => {
    expect(commitPrimaryAction({ amend: false, stagedCount: 0, dirtyCount: 0, ahead: 0 })).toBe(
      "commit",
    );
  });

  it("amend wins over everything, and is enabled on a clean tree", () => {
    const input = { amend: true, stagedCount: 0, dirtyCount: 0, ahead: 7 };
    expect(commitPrimaryAction(input)).toBe("amend");
    expect(isCommitPrimaryActionEnabled("amend", { ...input, hasMessage: false })).toBe(true);
  });

  it("commit needs both a message and staged files", () => {
    const base = { amend: false, stagedCount: 1, dirtyCount: 1, ahead: 0 };
    expect(isCommitPrimaryActionEnabled("commit", { ...base, hasMessage: false })).toBe(false);
    expect(isCommitPrimaryActionEnabled("commit", { ...base, hasMessage: true })).toBe(true);
    expect(
      isCommitPrimaryActionEnabled("commit", { ...base, stagedCount: 0, hasMessage: true }),
    ).toBe(false);
  });
});

describe("history filter", () => {
  it("keys off the trimmed, lowercased query and author together", () => {
    expect(historyFilterKey({ query: " Fix ", author: "Ada" })).toBe(
      historyFilterKey({ query: "fix", author: "ada" }),
    );
  });

  it("distinguishes a query from an author with the same text", () => {
    expect(historyFilterKey({ query: "ada", author: "" })).not.toBe(
      historyFilterKey({ query: "", author: "ada" }),
    );
  });

  it("is inactive only when both are blank", () => {
    expect(isHistoryFilterActive({ query: "   ", author: "" })).toBe(false);
    expect(isHistoryFilterActive({ query: "", author: "a" })).toBe(true);
  });

  it("recognizes a hash-ish query", () => {
    expect(isHashIshQuery("deadbeef")).toBe(true);
    expect(isHashIshQuery("dea")).toBe(false);
    expect(isHashIshQuery("fix: thing")).toBe(false);
  });

  it("matches subject, hash prefix and author name", () => {
    const commit = entry({ hash: "abc123def", subject: "Fix the parser", authorName: "Grace" });
    expect(matchesHistoryFilter(commit, { query: "parser", author: "" })).toBe(true);
    expect(matchesHistoryFilter(commit, { query: "abc1", author: "" })).toBe(true);
    expect(matchesHistoryFilter(commit, { query: "grace", author: "" })).toBe(true);
    expect(matchesHistoryFilter(commit, { query: "nope", author: "" })).toBe(false);
  });

  it("matches an author by email as well as name", () => {
    const commit = entry({ hash: "a1", authorName: "Grace", authorEmail: "gh@example.com" });
    expect(matchesHistoryFilter(commit, { query: "", author: "gh@example" })).toBe(true);
  });
});

describe("mergeHistorySearchResults", () => {
  const filter = { query: "fix", author: "" };

  it("keeps only matching loaded entries, and adds server-only ones", () => {
    const loaded = [
      entry({ hash: "aaa", subject: "fix a", authoredAt: "2024-05-03T00:00:00+00:00" }),
      entry({ hash: "bbb", subject: "feat b", authoredAt: "2024-05-02T00:00:00+00:00" }),
    ];
    const server = [
      entry({ hash: "ccc", subject: "fix c", authoredAt: "2024-05-01T00:00:00+00:00" }),
    ];
    expect(mergeHistorySearchResults(loaded, server, filter).map((item) => item.hash)).toEqual([
      "aaa",
      "ccc",
    ]);
  });

  it("dedupes by hash and prefers the locally loaded entry", () => {
    const local = entry({ hash: "aaa", subject: "fix a (local)" });
    const merged = mergeHistorySearchResults(
      [local],
      [entry({ hash: "aaa", subject: "fix a" })],
      filter,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.subject).toBe("fix a (local)");
  });

  it("sorts newest first regardless of which side supplied the entry", () => {
    const merged = mergeHistorySearchResults(
      [entry({ hash: "old", subject: "fix old", authoredAt: "2024-01-01T00:00:00+00:00" })],
      [entry({ hash: "new", subject: "fix new", authoredAt: "2024-09-01T00:00:00+00:00" })],
      filter,
    );
    expect(merged.map((item) => item.hash)).toEqual(["new", "old"]);
  });

  it("breaks ties by hash so the order is stable across renders", () => {
    const at = "2024-05-01T00:00:00+00:00";
    const merged = mergeHistorySearchResults(
      [
        entry({ hash: "bbb", subject: "fix", authoredAt: at }),
        entry({ hash: "aaa", subject: "fix", authoredAt: at }),
      ],
      [],
      filter,
    );
    expect(merged.map((item) => item.hash)).toEqual(["aaa", "bbb"]);
  });
});

describe("historyAuthorFacets", () => {
  it("counts authors in the loaded page, most frequent first", () => {
    const entries = [
      entry({ hash: "a", authorName: "Ada" }),
      entry({ hash: "b", authorName: "Grace" }),
      entry({ hash: "c", authorName: "Ada" }),
    ];
    expect(historyAuthorFacets(entries)).toEqual([
      { name: "Ada", count: 2 },
      { name: "Grace", count: 1 },
    ]);
  });
});

describe("liveness", () => {
  it("never polls while the panel is hidden", () => {
    expect(shouldPollWorkingCopy({ visible: false, hasCwd: true, busy: false })).toBe(false);
  });

  it("never polls without a cwd or during a mutation", () => {
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: false, busy: false })).toBe(false);
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: true, busy: true })).toBe(false);
  });

  it("polls when visible and idle", () => {
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: true, busy: false })).toBe(true);
  });

  // fork: f4 — a non-repository cwd cannot become one under the panel, so
  // re-asking every 15s is a request that can only ever fail.
  it("stops polling once the cwd answers isRepo: false", () => {
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: true, busy: false, isRepo: false })).toBe(
      false,
    );
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: true, busy: false, isRepo: true })).toBe(
      true,
    );
    expect(shouldPollWorkingCopy({ visible: true, hasCwd: true, busy: false, isRepo: null })).toBe(
      true,
    );
  });
});

describe("status failure banner", () => {
  it("stays quiet for a single failure", () => {
    expect(shouldShowStatusErrorBanner({ consecutiveFailures: 1, dismissed: false })).toBe(false);
  });

  it("shows at two consecutive failures", () => {
    expect(shouldShowStatusErrorBanner({ consecutiveFailures: 2, dismissed: false })).toBe(true);
  });

  it("stays dismissed once dismissed", () => {
    expect(shouldShowStatusErrorBanner({ consecutiveFailures: 9, dismissed: true })).toBe(false);
  });

  it("resets the streak on any success", () => {
    expect(nextStatusFailureStreak(3, false)).toBe(0);
    expect(nextStatusFailureStreak(3, true)).toBe(4);
  });
});

// ─── fork: f4 AI commit message ─────────────────────────────────────────────

describe("commitMessageGenerationState", () => {
  const base = {
    hasScope: true,
    stagedCount: 1,
    amend: false,
    generating: false,
    busy: false,
    modelConfigured: true as boolean | null,
  };

  it("enables with a staged file and a configured model", () => {
    expect(commitMessageGenerationState(base)).toEqual({ enabled: true, reason: null });
  });

  it("disables with nothing staged", () => {
    const state = commitMessageGenerationState({ ...base, stagedCount: 0 });
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("nothing-staged");
    expect(commitMessageGenerationLabel(state)).toBe("Stage some changes first");
  });

  it("amend needs nothing staged — the commit being rewritten is the context", () => {
    expect(commitMessageGenerationState({ ...base, stagedCount: 0, amend: true })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it("disables while a generation is in flight, ahead of every other reason", () => {
    const state = commitMessageGenerationState({
      ...base,
      generating: true,
      stagedCount: 0,
      modelConfigured: false,
    });
    expect(state.reason).toBe("generating");
    expect(commitMessageGenerationLabel(state)).toBe("Generating…");
  });

  it("disables while another panel action is running", () => {
    expect(commitMessageGenerationState({ ...base, busy: true }).reason).toBe("busy");
  });

  it("disables with no scope at all", () => {
    expect(commitMessageGenerationState({ ...base, hasScope: false }).reason).toBe("no-scope");
  });

  it("disables when no text generation model is configured", () => {
    const state = commitMessageGenerationState({ ...base, modelConfigured: false });
    expect(state.reason).toBe("no-model");
    expect(commitMessageGenerationLabel(state)).toBe("Set a text generation model in Settings");
  });

  it("an unknown model configuration does NOT disable — the server answers", () => {
    // Otherwise the button is dead for the first second of every session,
    // while the server config is still in flight.
    expect(commitMessageGenerationState({ ...base, modelConfigured: null }).enabled).toBe(true);
  });

  it("nothing-staged outranks no-model: it is the one the user can fix in a click", () => {
    expect(
      commitMessageGenerationState({ ...base, stagedCount: 0, modelConfigured: false }).reason,
    ).toBe("nothing-staged");
  });

  it("the enabled label is the tooltip for the action itself", () => {
    expect(commitMessageGenerationLabel({ enabled: true, reason: null })).toBe(
      "Generate a commit message",
    );
  });
});

describe("commitMessageGenerationApply", () => {
  it("fills an empty draft", () => {
    expect(commitMessageGenerationApply({ draftAtPress: "", draftNow: "" })).toBe("fill");
  });

  it("fills a whitespace-only draft", () => {
    expect(commitMessageGenerationApply({ draftAtPress: "  \n", draftNow: "  \n" })).toBe("fill");
  });

  it("confirms before replacing a message the user already wrote", () => {
    expect(commitMessageGenerationApply({ draftAtPress: "wip", draftNow: "wip" })).toBe("confirm");
  });

  it("discards the result when the draft changed mid-flight", () => {
    // The user typed over the field while the model was thinking; replacing
    // their words is the one genuinely destructive outcome.
    expect(commitMessageGenerationApply({ draftAtPress: "", draftNow: "typed by hand" })).toBe(
      "discard",
    );
  });

  it("discards even when the draft was cleared mid-flight", () => {
    expect(commitMessageGenerationApply({ draftAtPress: "wip", draftNow: "" })).toBe("discard");
  });
});

// ─── F-07: the entry points that used to bypass every gate ─────────────────
//
// `runPrimary` guarded on `enabled`, but the ⌘⇧↩ branch called
// `onCommitAndPush` before reaching it and neither overflow menu item had a
// `disabled` prop. With an empty message and nothing staged, "Commit & push"
// staged the ENTIRE working tree and then let the server reject the empty
// message — a side effect from a control that should not have fired.

describe("isCommitAndPushEnabled (F-07)", () => {
  const base = { amend: false, stagedCount: 0, dirtyCount: 0, ahead: 0, busy: false };

  it("refuses an empty message even when there is something to stage", () => {
    expect(isCommitAndPushEnabled({ ...base, dirtyCount: 3, hasMessage: false })).toBe(false);
  });

  it("refuses a clean tree even with a message", () => {
    expect(isCommitAndPushEnabled({ ...base, hasMessage: true })).toBe(false);
  });

  it("allows a message plus staged files, and a message plus a dirty tree", () => {
    expect(isCommitAndPushEnabled({ ...base, stagedCount: 1, hasMessage: true })).toBe(true);
    expect(isCommitAndPushEnabled({ ...base, dirtyCount: 1, hasMessage: true })).toBe(true);
  });

  it("refuses while a commit is already in flight", () => {
    expect(isCommitAndPushEnabled({ ...base, stagedCount: 1, hasMessage: true, busy: true })).toBe(
      false,
    );
  });
});

describe("isAmendCommitEnabled (F-07)", () => {
  it("needs a commit to amend", () => {
    expect(isAmendCommitEnabled({ busy: false, hasLastCommit: false })).toBe(false);
    expect(isAmendCommitEnabled({ busy: false, hasLastCommit: true })).toBe(true);
  });

  it("refuses while the commit busy key is taken", () => {
    expect(isAmendCommitEnabled({ busy: true, hasLastCommit: true })).toBe(false);
  });

  it("does NOT require a message — amend keeps the existing one", () => {
    // Stated as a test because the obvious "reuse the commit predicate" fix
    // would silently break `git commit --amend --no-edit`.
    expect(isAmendCommitEnabled({ busy: false, hasLastCommit: true })).toBe(true);
  });
});

// ─── F-03: the amend prefill is a transition, not an invariant ──────────────
//
// The composer's effect had `message` in its dependency list and no edge guard,
// so "amend on + empty draft" was re-asserted on every render: select-all +
// Delete instantly repopulated the box, and backspacing to the last character
// refilled it. The textarea was uneditable-to-empty while Amend was ticked.

describe("shouldPrefillAmendMessage (F-03)", () => {
  const last = "fix: the previous subject";

  it("fills once when amend is switched on with an empty draft", () => {
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "",
        lastCommitMessage: last,
        prefilledFor: null,
      }),
    ).toBe(true);
  });

  it("does NOT refill after the session already prefilled — this is the bug", () => {
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "",
        lastCommitMessage: last,
        prefilledFor: last,
      }),
    ).toBe(false);
  });

  it("never overwrites text the user has already typed", () => {
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "my own subject",
        lastCommitMessage: last,
        prefilledFor: null,
      }),
    ).toBe(false);
    // Whitespace-only counts as empty.
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "   ",
        lastCommitMessage: last,
        prefilledFor: null,
      }),
    ).toBe(true);
  });

  it("does nothing while amend is off, or with no commit to amend", () => {
    expect(
      shouldPrefillAmendMessage({
        amend: false,
        message: "",
        lastCommitMessage: last,
        prefilledFor: null,
      }),
    ).toBe(false);
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "",
        lastCommitMessage: null,
        prefilledFor: null,
      }),
    ).toBe(false);
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "",
        lastCommitMessage: "",
        prefilledFor: null,
      }),
    ).toBe(false);
  });

  it("re-arms when the commit being amended changes underneath", () => {
    expect(
      shouldPrefillAmendMessage({
        amend: true,
        message: "",
        lastCommitMessage: "a different HEAD subject",
        prefilledFor: last,
      }),
    ).toBe(true);
  });
});
