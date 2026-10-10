import { describe, expect, it } from "vite-plus/test";

import {
  detailSummaryChecksState,
  resolvePullRequestConflict,
  resolvePullRequestState,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

describe("resolvePullRequestState", () => {
  it.each([
    [
      "open",
      { state: "open", isDraft: false },
      PullRequestGlyph.pullRequest,
      "Open",
      "text-emerald-600 dark:text-emerald-300/90",
    ],
    [
      "draft",
      { state: "open", isDraft: true },
      PullRequestGlyph.draft,
      "Draft",
      "text-zinc-500 dark:text-zinc-400/80",
    ],
    [
      "closed",
      { state: "closed", isDraft: false },
      PullRequestGlyph.closed,
      "Closed",
      "text-red-600 dark:text-red-300/90",
    ],
    [
      "merged",
      { state: "merged", isDraft: false },
      PullRequestGlyph.merged,
      "Merged",
      "text-violet-600 dark:text-violet-300/90",
    ],
  ] as const)(
    "resolves the %s lifecycle presentation",
    (_name, input, Icon, label, toneClassName) => {
      expect(resolvePullRequestState(input)).toEqual({
        Icon,
        label,
        toneClassName,
      });
    },
  );

  it("keeps a merged pull request merged when stale draft metadata is also present", () => {
    expect(resolvePullRequestState({ state: "merged", isDraft: true })).toMatchObject({
      Icon: PullRequestGlyph.merged,
      label: "Merged",
    });
  });

  it("keeps a closed pull request closed when stale draft metadata is also present", () => {
    expect(resolvePullRequestState({ state: "closed", isDraft: true })).toMatchObject({
      Icon: PullRequestGlyph.closed,
      label: "Closed",
    });
  });

  it("keeps lifecycle and conflict presentation independent for an open conflicting pull request", () => {
    const input = {
      state: "open" as const,
      isDraft: false,
      mergeability: "conflicting" as const,
      baseBranch: "main",
    };

    expect(resolvePullRequestState(input)).toMatchObject({
      Icon: PullRequestGlyph.pullRequest,
      label: "Open",
    });
    expect(resolvePullRequestConflict(input)).toMatchObject({
      Icon: PullRequestGlyph.conflicting,
      label: "Conflicts with main",
      toneClassName: "text-destructive",
    });
  });
});

describe("resolvePullRequestConflict", () => {
  it.each([
    ["closed", { state: "closed", isDraft: false }],
    ["merged", { state: "merged", isDraft: false }],
    ["closed draft", { state: "closed", isDraft: true }],
    ["merged draft", { state: "merged", isDraft: true }],
    ["open draft", { state: "open", isDraft: true }],
  ] as const)("does not report a conflict for %s", (_name, input) => {
    expect(
      resolvePullRequestConflict({
        ...input,
        mergeability: "conflicting",
        baseBranch: "main",
      }),
    ).toBeNull();
  });

  it.each([
    ["omitted", undefined],
    ["unknown", "unknown"],
    ["mergeable", "mergeable"],
  ] as const)("does not report an open conflict when mergeability is %s", (_name, mergeability) => {
    const input = {
      state: "open" as const,
      isDraft: false,
      ...(mergeability === undefined ? {} : { mergeability }),
    };
    expect(resolvePullRequestConflict(input)).toBeNull();
  });

  it("reports a known conflict with its base branch", () => {
    expect(
      resolvePullRequestConflict({
        state: "open",
        isDraft: false,
        mergeability: "conflicting",
        baseBranch: "main",
      }),
    ).toEqual({
      Icon: PullRequestGlyph.conflicting,
      label: "Conflicts with main",
      toneClassName: "text-destructive",
    });
  });

  it("reports a known conflict without inventing a base branch", () => {
    expect(
      resolvePullRequestConflict({
        state: "open",
        isDraft: false,
        mergeability: "conflicting",
      }),
    ).toEqual({
      Icon: PullRequestGlyph.conflicting,
      label: "Has conflicts",
      toneClassName: "text-destructive",
    });
  });
});

describe("detailSummaryChecksState", () => {
  const passed = { name: "CI", status: "success", description: null, url: null } as const;

  it("passes on the head commit's rollup when the detail could not read checks", () => {
    expect(
      detailSummaryChecksState({
        checks: [],
        checksUnreadable: true,
        checksRollupState: "failing",
      }),
    ).toBe("failing");
    // Without one it clears, rather than keeping an older rollup as current.
    expect(detailSummaryChecksState({ checks: [], checksUnreadable: true })).toBe(null);
  });

  it("holds an unreadable detail pending while a workflow awaits approval", () => {
    const awaiting = {
      name: "CI",
      status: "action-required",
      description: null,
      url: null,
    } as const;
    expect(
      detailSummaryChecksState({
        checks: [awaiting],
        checksUnreadable: true,
        checksRollupState: "passing",
      }),
    ).toBe("pending");
    expect(detailSummaryChecksState({ checks: [awaiting], checksUnreadable: true })).toBe(
      "pending",
    );
    expect(
      detailSummaryChecksState({
        checks: [awaiting],
        checksUnreadable: true,
        checksRollupState: "failing",
      }),
    ).toBe("failing");
  });

  it("works the rollup out from checks the detail could read", () => {
    expect(detailSummaryChecksState({ checks: [passed], checksRollupState: "failing" })).toBe(
      "passing",
    );
    expect(detailSummaryChecksState({ checks: [] })).toBe(null);
  });
});
