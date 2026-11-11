import { assert, it } from "@effect/vitest";

import * as Option from "effect/Option";

import {
  countContributors,
  formatReleaseSummary,
  isReleaseNoteCommit,
  readReleaseHighlights,
  type PullRequest,
} from "./generate-release-notes.ts";

const pullRequest = (author: PullRequest["author"]): PullRequest => ({
  body: "",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  author,
});

it("counts each person once and leaves out bots", () => {
  const commits = [
    { subject: "fix(web): one (#1)", authorName: "Ada Lovelace" },
    { subject: "fix(web): two (#2)", authorName: "Ada Lovelace" },
    { subject: "chore: bump (#3)", authorName: "dependabot[bot]" },
    { subject: "fix: direct push by a PR author", authorName: "Ada Lovelace" },
    { subject: "fix: direct push by someone else", authorName: "Grace Hopper" },
    { subject: "chore: direct push by a bot", authorName: "t3-code[bot]" },
    { subject: "fix(web): four (#4)", authorName: "Linus T" },
    { subject: "fix: direct push by a PR author with no profile name", authorName: "Linus T" },
    { subject: "fix(web): five, whose PR did not resolve (#5)", authorName: "Ken T" },
  ];
  const pullRequests = new Map([
    [1, pullRequest({ __typename: "User", login: "ada", name: "Ada Lovelace" })],
    [2, pullRequest({ __typename: "User", login: "ada", name: "Ada Lovelace" })],
    [3, pullRequest({ __typename: "Bot", login: "dependabot" })],
    [4, pullRequest({ __typename: "User", login: "linus", name: null })],
  ]);

  assert.equal(countContributors(commits, pullRequests), 4);
});

it("leaves mobile-only scopes out and keeps shared ones", () => {
  const subjects = {
    "fix(mobile): a": false,
    "feat(android): b": false,
    "fix(ios)!: c": false,
    "fix(web,mobile): d": true,
    "feat(mobile,web): f": true,
    "fix(server): e": true,
  };
  for (const [subject, kept] of Object.entries(subjects)) {
    assert.equal(isReleaseNoteCommit({ subject, authorName: "" }), kept, subject);
  }
});

it("reads highlights only from a completed JSON response", () => {
  const output = [
    { type: "message", content: [{ type: "output_text", text: ' {"highlights":[]} ' }] },
  ];
  assert.deepStrictEqual(readReleaseHighlights({ status: "completed", output }), Option.some([]));
  assert.deepStrictEqual(readReleaseHighlights({ status: "incomplete", output }), Option.none());
});

it("counts fixes and performance changes once, outside the selected highlights", () => {
  const commits = [
    "feat: schedule a task once",
    "fix: use the selected time",
    "perf(server): read less history",
    "fix(mobile): restore the chat position",
    "docs: update instructions",
  ].map((subject) => ({ subject, authorName: "" }));
  const selected = [
    { label: "One-time tasks", detail: "Schedule a task for a specific time.", commits: [1, 2] },
  ] as const;
  assert.deepStrictEqual(
    formatReleaseSummary(commits, selected),
    Option.some(
      "- **One-time tasks.** Schedule a task for a specific time.\n\n### Plus 2 more bug fixes and performance improvements.",
    ),
  );
  assert.deepStrictEqual(
    formatReleaseSummary(commits.slice(0, 2), selected),
    Option.some("- **One-time tasks.** Schedule a task for a specific time."),
  );
  assert.deepStrictEqual(formatReleaseSummary(commits.slice(2), selected), Option.none());
  assert.deepStrictEqual(
    formatReleaseSummary(commits, []),
    Option.some("**3 bug fixes and performance improvements.**"),
  );
  assert.deepStrictEqual(formatReleaseSummary(commits.slice(-1), []), Option.some(""));
});

it("counts fixes beyond the seven displayed highlights in the footer", () => {
  const commits = Array.from({ length: 8 }, (_, i) => ({
    subject: `fix: change ${i + 1}`,
    authorName: "",
  }));
  const highlights = commits.map((_, i) => ({
    label: `Fix ${i + 1}`,
    detail: "A fix.",
    commits: [i + 1] as const,
  }));
  const summary = Option.getOrThrow(formatReleaseSummary(commits, highlights));
  assert.lengthOf(summary.match(/^- /gm) ?? [], 7);
  assert.include(summary, "Plus 1 more bug fix.");
});
