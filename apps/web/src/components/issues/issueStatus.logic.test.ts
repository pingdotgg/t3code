import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type IssuePullRequest,
  type IssueStatus,
  issueStatusOf,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupIssuesByStatus,
  issueStatusInputOf,
  issuePanelPullRequests,
  issueThreadTargets,
  matchesIssueStatusFilters,
  mergeIssueRowThreads,
  workingThreadKeysOf,
  type IssueRowThread,
} from "./issueStatus.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const REPOSITORY = "toolboxmd/t3code";

function pullRequest(number: number, overrides: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return {
    host: "github.com",
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    state: "open",
    isDraft: false,
    headRefName: `feat/${number}-x`,
    headSha: "abc",
    review: null,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<IssueRowThread> = {}): IssueRowThread {
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    title: id,
    archivedAt: null,
    sources: ["manual"],
    pullRequests: [],
    ...overrides,
  };
}

const openIssue = { state: "open" as const, openBlockerCount: 0, closingPullRequests: [] };
const context = (overrides: Partial<Parameters<typeof issueStatusInputOf>[2]> = {}) => ({
  working: new Set<string>(),
  linkedPullRequests: new Map<string, IssuePullRequest>(),
  trustedLogins: new Set(["lukemaj"]),
  ...overrides,
});
const statusOf = (...args: Parameters<typeof issueStatusInputOf>) =>
  issueStatusOf(issueStatusInputOf(...args));

describe("matchesIssueStatusFilters", () => {
  it.each([
    [{}, "to-do", 0, true],
    [{ statuses: [] }, "paused", 1, true],
    [{ statuses: ["paused", "blocked"] }, "blocked", 0, true],
    [{ statuses: ["paused"] }, "blocked", 0, false],
    [{ linked: "linked" }, "discussion", 1, true],
    [{ linked: "linked" }, "to-do", 0, false],
    [{ linked: "unlinked" }, "blocked", 0, true],
    [{ linked: "unlinked" }, "paused", 2, false],
    [{ statuses: ["blocked"], linked: "linked" }, "blocked", 0, false],
  ] as const)("%j keeps %s with %i threads: %s", (filters, status, linkedThreadCount, kept) => {
    expect(matchesIssueStatusFilters({ status, linkedThreadCount }, filters)).toBe(kept);
  });
});

describe("groupIssuesByStatus", () => {
  it("orders groups by the status table and keeps each group's row order", () => {
    const rows: Array<[string, IssueStatus]> = [
      ["a", "to-do"],
      ["b", "done"],
      ["c", "in-progress"],
      ["d", "to-do"],
      ["e", "blocked"],
    ];
    const groups = groupIssuesByStatus(rows, ([, status]) => status);
    expect(groups.map((group) => [group.status, group.entries.map(([name]) => name)])).toEqual([
      ["done", ["b"]],
      ["in-progress", ["c"]],
      ["blocked", ["e"]],
      ["to-do", ["a", "d"]],
    ]);
  });
});

describe("issueStatusInputOf: pull requests", () => {
  it("counts a thread's PR into a non-default branch, which closes nothing on GitHub", () => {
    const linked = new Map([["github.com toolboxmd/t3code#36", pullRequest(36)]]);
    const threads = [
      thread("t", { pullRequests: [{ host: "github.com", repository: REPOSITORY, number: 36 }] }),
    ];
    expect(statusOf(openIssue, threads, context())).toBe("discussion");
    expect(statusOf(openIssue, threads, context({ linkedPullRequests: linked }))).toBe(
      "waiting-for-review",
    );
  });

  it("counts a pull request both closing and thread-linked once, closing read first", () => {
    const closing = pullRequest(7, { review: { state: "failure", creator: "lukemaj" } });
    const input = issueStatusInputOf(
      { ...openIssue, closingPullRequests: [closing] },
      [
        thread("t", {
          pullRequests: [{ host: "GitHub.com", repository: "Toolboxmd/T3code", number: 7 }],
        }),
      ],
      context({
        linkedPullRequests: new Map([
          ["github.com toolboxmd/t3code#7", pullRequest(7, { review: null })],
        ]),
      }),
    );
    expect(input.pullRequests).toEqual([{ state: "open", isDraft: false, reviewMark: "failure" }]);
  });

  it("trusts a mark from any server that listed the Issue, and no one else", () => {
    const marked = pullRequest(7, { review: { state: "success", creator: "Other-Machine" } });
    const issue = { ...openIssue, closingPullRequests: [marked] };
    expect(statusOf(issue, [], context())).toBe("waiting-for-review");
    expect(
      statusOf(issue, [], context({ trustedLogins: new Set(["lukemaj", "other-machine"]) })),
    ).toBe("waiting-for-merge");
  });
});

describe("issueThreadTargets", () => {
  it("asks every server that keeps links about every row, in batches of 100", () => {
    const closing = pullRequest(40, { state: "merged" });
    const entries = [
      { host: "github.com", repository: REPOSITORY, number: 1, closingPullRequests: [closing] },
      ...Array.from({ length: 150 }, (_, index) => ({
        host: "github.com",
        repository: REPOSITORY,
        number: index + 2,
        closingPullRequests: [],
      })),
    ];
    const targets = issueThreadTargets(entries, new Set([REMOTE, LOCAL]));
    expect(targets.map((target) => [target.environmentId, target.input.issues.length])).toEqual([
      [LOCAL, 100],
      [LOCAL, 51],
      [REMOTE, 100],
      [REMOTE, 51],
    ]);
    expect(targets[0]!.input.issues[0]).toEqual({
      host: "github.com",
      repository: REPOSITORY,
      number: 1,
      closingPullRequests: [{ repository: REPOSITORY, number: 40 }],
    });
    expect(issueThreadTargets(entries, new Set())).toEqual([]);
  });
});

describe("mergeIssueRowThreads", () => {
  it("keys threads by Issue across servers, each thread once", () => {
    const linked = {
      id: ThreadId.make("t1"),
      projectId: ProjectId.make("p"),
      title: "Build it",
      archivedAt: null,
      sources: ["branch" as const],
      pullRequests: [],
    };
    const answer = (repository: string) => ({
      issues: [{ host: "github.com", repository, number: 5, threads: [linked] }],
    });
    const merged = mergeIssueRowThreads([
      [LOCAL, answer("Toolboxmd/T3code")],
      [LOCAL, answer(REPOSITORY)],
      [REMOTE, answer(REPOSITORY)],
    ]);
    expect(merged.get("github.com toolboxmd/t3code#5")?.map((row) => row.environmentId)).toEqual([
      LOCAL,
      REMOTE,
    ]);
  });
});

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("working now", () => {
  const running = {
    threadId: ThreadId.make("x"),
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-25T10:00:00.000Z",
  };
  const keysOf = (shells: ReadonlyArray<EnvironmentThreadShell>) =>
    new Set(
      workingThreadKeysOf(shells)
        .split("\n")
        .filter((key) => key.length > 0),
    );

  it("counts a thread whose own session runs, or whose descendant child thread works", () => {
    expect(
      workingThreadKeysOf([
        shell("own", { session: running }),
        shell("parent"),
        shell("sub.parent.a"),
        shell("sub.sub.parent.a.b", { session: running }),
        shell("idle"),
      ]).split("\n"),
    ).toEqual(["local:own", "local:parent", "local:sub.parent.a", "local:sub.sub.parent.a.b"]);
    expect(workingThreadKeysOf([shell("idle")])).toBe("");
  });

  it("feeds the status from whichever server the linked thread lives on", () => {
    const working = keysOf([
      shell("parent", { environmentId: REMOTE }),
      shell("sub.parent.job", { environmentId: REMOTE, session: running }),
    ]);
    const branchThread = thread("parent", { sources: ["branch"] });
    // Only the remote machine's thread works; its row counts once the remote server answers.
    expect(statusOf(openIssue, [branchThread], context({ working }))).toBe("paused");
    expect(
      statusOf(
        openIssue,
        [branchThread, { ...branchThread, environmentId: REMOTE }],
        context({ working }),
      ),
    ).toBe("in-progress");
  });
});

describe("issuePanelPullRequests", () => {
  it("lists closing PRs, then thread PRs once each, with state where the list read it", () => {
    const threads = [
      thread("a", {
        pullRequests: [
          { host: "github.com", repository: "Toolboxmd/T3code", number: 7 },
          { host: "github.com", repository: REPOSITORY, number: 36 },
        ],
      }),
      thread("b", { pullRequests: [{ host: "github.com", repository: REPOSITORY, number: 50 }] }),
    ];
    const listed = issuePanelPullRequests(
      [pullRequest(7, { state: "merged" })],
      threads,
      new Map([["github.com toolboxmd/t3code#36", pullRequest(36, { isDraft: true })]]),
    );
    expect(listed.map((pr) => [pr.number, pr.state, pr.isDraft, pr.url])).toEqual([
      [7, "merged", false, "https://github.com/toolboxmd/t3code/pull/7"],
      [36, "open", true, "https://github.com/toolboxmd/t3code/pull/36"],
      // Not read by the list (e.g. opened from a thread's link): shown without a state.
      [50, null, false, "https://github.com/toolboxmd/t3code/pull/50"],
    ]);
  });
});
