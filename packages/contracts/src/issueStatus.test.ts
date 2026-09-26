import { describe, expect, it } from "vite-plus/test";

import {
  type IssueStatus,
  type IssueStatusInput,
  type IssueStatusPullRequest,
  issueStatusOf,
  trustedReviewMark,
} from "./issueStatus.ts";

const pr = (
  state: IssueStatusPullRequest["state"],
  reviewMark: IssueStatusPullRequest["reviewMark"] = null,
  isDraft = false,
): IssueStatusPullRequest => ({ state, reviewMark, isDraft });
const draft = (reviewMark: IssueStatusPullRequest["reviewMark"] = null) =>
  pr("open", reviewMark, true);

const input = (overrides: Partial<IssueStatusInput> = {}): IssueStatusInput => ({
  state: "open",
  openBlockerCount: 0,
  pullRequests: [],
  hasTaskBranch: false,
  linkedThreadCount: 0,
  workingNow: false,
  ...overrides,
});

describe("issueStatusOf: every row of the status table", () => {
  it.each<[IssueStatus, Partial<IssueStatusInput>]>([
    ["done", { state: "done" }],
    ["not-planned", { state: "not-planned" }],
    ["in-review", { pullRequests: [pr("open", "pending")] }],
    ["in-progress", { hasTaskBranch: true, linkedThreadCount: 1, workingNow: true }],
    ["in-progress", { pullRequests: [pr("open")], linkedThreadCount: 1, workingNow: true }],
    ["waiting-for-merge", { pullRequests: [pr("open", "success")] }],
    ["changes-requested", { pullRequests: [pr("open", "failure")] }],
    ["waiting-for-review", { pullRequests: [pr("open")] }],
    ["paused", { hasTaskBranch: true, linkedThreadCount: 1 }],
    ["blocked", { openBlockerCount: 2 }],
    ["discussion", { linkedThreadCount: 1 }],
    ["to-do", {}],
  ])("%s", (expected, overrides) => {
    expect(issueStatusOf(input(overrides))).toBe(expected);
  });
});

describe("issueStatusOf: first match wins", () => {
  const everything: Partial<IssueStatusInput> = {
    openBlockerCount: 1,
    pullRequests: [pr("open", "pending"), pr("open", "success"), pr("open", "failure"), pr("open")],
    hasTaskBranch: true,
    linkedThreadCount: 2,
    workingNow: true,
  };

  it.each<[string, IssueStatus, Partial<IssueStatusInput>]>([
    ["Done over every other signal", "done", { ...everything, state: "done" }],
    ["Not planned over every other signal", "not-planned", { ...everything, state: "not-planned" }],
    ["In review over In progress", "in-review", everything],
    [
      "In progress over Waiting for merge",
      "in-progress",
      { ...everything, pullRequests: [pr("open", "success")] },
    ],
    [
      "Waiting for merge over Changes requested",
      "waiting-for-merge",
      { pullRequests: [pr("open", "failure"), pr("open", "success")] },
    ],
    [
      "Changes requested over Waiting for review",
      "changes-requested",
      { pullRequests: [pr("open"), pr("open", "failure")] },
    ],
    [
      "Waiting for review over Paused",
      "waiting-for-review",
      { pullRequests: [pr("open")], hasTaskBranch: true, linkedThreadCount: 1 },
    ],
    [
      "Paused over Blocked",
      "paused",
      { hasTaskBranch: true, linkedThreadCount: 1, openBlockerCount: 1 },
    ],
    ["Blocked over Discussion", "blocked", { openBlockerCount: 1, linkedThreadCount: 1 }],
    ["Discussion over To do", "discussion", { linkedThreadCount: 1 }],
  ])("%s", (_label, expected, overrides) => {
    expect(issueStatusOf(input(overrides))).toBe(expected);
  });
});

describe("issueStatusOf: mixed review marks across pull requests", () => {
  it.each<[string, ReadonlyArray<IssueStatusPullRequest>, IssueStatus]>([
    [
      "pending, success and failure",
      [pr("open", "failure"), pr("open", "success"), pr("open", "pending")],
      "in-review",
    ],
    ["pending and failure", [pr("open", "failure"), pr("open", "pending")], "in-review"],
    ["pending and success", [pr("open", "success"), pr("open", "pending")], "in-review"],
    ["success and failure", [pr("open", "failure"), pr("open", "success")], "waiting-for-merge"],
    ["failure and none", [pr("open"), pr("open", "failure")], "changes-requested"],
  ])("%s: %s", (_label, pullRequests, expected) => {
    expect(issueStatusOf(input({ pullRequests }))).toBe(expected);
  });
});

describe("issueStatusOf: which pull requests count", () => {
  it("ignores merged pull requests while the Issue stays open", () => {
    // A component PR merged into an integration branch; the final PR into main closes the Issue.
    expect(issueStatusOf(input({ pullRequests: [pr("merged", "success")] }))).toBe("to-do");
    expect(issueStatusOf(input({ pullRequests: [pr("merged")], linkedThreadCount: 1 }))).toBe(
      "discussion",
    );
  });

  it("ignores closed pull requests and their marks", () => {
    expect(issueStatusOf(input({ pullRequests: [pr("closed", "pending")] }))).toBe("to-do");
  });

  it("reads an open draft with nobody working as Paused, not Waiting for review", () => {
    expect(issueStatusOf(input({ pullRequests: [draft()], linkedThreadCount: 1 }))).toBe("paused");
    // Even over an open blocker: the draft is the work.
    expect(issueStatusOf(input({ pullRequests: [draft()], openBlockerCount: 1 }))).toBe("paused");
  });

  it("keeps an open draft with a working thread In progress", () => {
    expect(
      issueStatusOf(input({ pullRequests: [draft()], linkedThreadCount: 1, workingNow: true })),
    ).toBe("in-progress");
  });

  it("still reads a review mark on a draft", () => {
    expect(issueStatusOf(input({ pullRequests: [draft("pending")] }))).toBe("in-review");
  });

  it("waits for review once any open pull request is ready", () => {
    expect(issueStatusOf(input({ pullRequests: [draft(), pr("open")] }))).toBe(
      "waiting-for-review",
    );
  });

  it("keeps a working thread without a branch or pull request in Discussion", () => {
    expect(issueStatusOf(input({ linkedThreadCount: 1, workingNow: true }))).toBe("discussion");
  });

  it("never shows the review statuses without review marks", () => {
    const review = new Set<IssueStatus>(["in-review", "waiting-for-merge", "changes-requested"]);
    for (const state of ["open", "done", "not-planned"] as const) {
      for (const pullRequests of [[], [pr("open")], [draft()], [pr("merged")], [pr("closed")]]) {
        for (const hasTaskBranch of [false, true]) {
          for (const workingNow of [false, true]) {
            for (const openBlockerCount of [0, 1]) {
              const status = issueStatusOf(
                input({
                  state,
                  pullRequests,
                  hasTaskBranch,
                  workingNow,
                  openBlockerCount,
                  linkedThreadCount: 1,
                }),
              );
              expect(review.has(status)).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("trustedReviewMark", () => {
  const trusted = new Set(["lukemaj", "other-machine"]);

  it.each([
    ["the account of a server that listed it", { state: "success", creator: "LukeMaj" }, "success"],
    ["another listing server's account", { state: "pending", creator: "other-machine" }, "pending"],
    ["anyone else", { state: "success", creator: "github-actions[bot]" }, null],
    ["a deleted account", { state: "failure", creator: null }, null],
    ["no mark", null, null],
  ] as const)("counts a mark from %s", (_label, review, expected) => {
    expect(trustedReviewMark(review, trusted)).toBe(expected);
  });
});
