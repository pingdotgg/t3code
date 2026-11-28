import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
  rereadIssuePage,
} from "./issueList.ts";

const environmentId = "env-1" as EnvironmentId;
const api = "api" as ProjectId;

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/api",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/api/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: api,
    projectTitle: "api",
    ...overrides,
  };
}

function answer(overrides: Partial<IssueListResult>): IssueListResult {
  return { viewers: {}, trackers: [], entries: [], errors: [], nextCursors: {}, ...overrides };
}

function hold(first: IssueListResult) {
  return holdIssuePages([[environmentId, first]], new Map()).get(environmentId)!;
}

describe("continueIssuePage", () => {
  const failure = { projectId: api, projectTitle: "api", message: "rate limited" };
  const firstPageFailure = { projectId: "web" as ProjectId, projectTitle: "web", message: "boom" };
  const cursors = { "github.com acme/api": "c1", "linear.app ENG": "l1" };

  it("drops a continuation's error once a retry of the same cursors works", () => {
    const first = hold(answer({ errors: [firstPageFailure], nextCursors: cursors }));
    const failed = continueIssuePage(
      first,
      answer({ errors: [failure], nextCursors: cursors }),
      cursors,
    );
    expect(failed.errors.map((error) => error.message)).toEqual(["boom", "rate limited"]);
    const retried = continueIssuePage(failed, answer({ entries: [entry({ key: "2" })] }), cursors);
    // The first page's failure has no cursor, so no continuation retried it.
    expect(retried.errors.map((error) => error.message)).toEqual(["boom"]);
  });

  it("moves only the cursors asked for and keeps the other trackers' errors", () => {
    const first = hold(answer({ nextCursors: cursors }));
    const linear = issueCursorsForHost(cursors, "linear.app");
    expect(linear).toEqual({ "linear.app ENG": "l1" });
    const linearFailed = continueIssuePage(
      first,
      answer({ errors: [failure], nextCursors: linear }),
      linear,
    );
    const github = issueCursorsForHost(linearFailed.nextCursors, "github.com");
    const next = continueIssuePage(
      linearFailed,
      answer({ entries: [entry({ key: "2" })], nextCursors: { "github.com acme/api": "c2" } }),
      github,
    );
    expect(next.nextCursors).toEqual({ "github.com acme/api": "c2", "linear.app ENG": "l1" });
    expect(next.errors).toEqual([failure]);
    const done = continueIssuePage(
      next,
      answer({}),
      issueCursorsForHost(next.nextCursors, "github.com"),
    );
    expect(done.nextCursors).toEqual({ "linear.app ENG": "l1" });
  });
});

describe("holdIssuePages", () => {
  it("keeps the loaded pages when a refresh after a ticket action changes the first page", () => {
    const cursors = { "github.com acme/api": "page-2" };
    const first = answer({ entries: [entry({ key: "3" })], nextCursors: cursors });
    const continued = continueIssuePage(
      hold(first),
      answer({ entries: [entry({ key: "2" }), entry({ key: "1" })] }),
      cursors,
    );
    // Closing #1 moves it to the top of the first page the refresh reads.
    const refreshed = answer({
      entries: [entry({ key: "1", updatedAt: "2026-10-02T00:00:00.000Z" }), entry({ key: "3" })],
      nextCursors: cursors,
    });
    const held = holdIssuePages(
      [[environmentId, refreshed]],
      new Map([[environmentId, continued]]),
    ).get(environmentId)!;
    expect(held.entries.map((issue) => issue.key)).toContain("2");
  });

  it("starts over when the list's filters change", () => {
    const cursors = { "github.com acme/api": "page-2" };
    const first = holdIssuePages(
      [[environmentId, answer({ entries: [entry({ key: "3" })], nextCursors: cursors })]],
      new Map(),
      "open",
    ).get(environmentId)!;
    const continued = continueIssuePage(first, answer({ entries: [entry({ key: "2" })] }), cursors);
    const closed = answer({ entries: [entry({ key: "1" })], nextCursors: cursors });
    const held = holdIssuePages(
      [[environmentId, closed]],
      new Map([[environmentId, continued]]),
      "closed",
    ).get(environmentId)!;
    expect(held.entries.map((issue) => issue.key)).toEqual(["1"]);
    expect(held.nextCursors).toEqual(cursors);
  });

  it("reads the loaded pages again, dropping a continuation ticket closed out of an open list", async () => {
    const cursors = { "github.com acme/api": "page-2" };
    const firstPage = [entry({ key: "4" }), entry({ key: "3" })];
    const continued = continueIssuePage(
      hold(answer({ entries: firstPage, nextCursors: cursors })),
      answer({ entries: [entry({ key: "2" }), entry({ key: "1" })] }),
      cursors,
    );
    // Closing #2 leaves the open first page as it was.
    const refreshed = answer({ entries: firstPage, nextCursors: cursors });
    const held = holdIssuePages(
      [[environmentId, refreshed]],
      new Map([[environmentId, continued]]),
    ).get(environmentId)!;
    expect(held.rereading).toBe(refreshed);
    const asked: unknown[] = [];
    const reread = await rereadIssuePage({ ...held, rereading: refreshed }, async (next) => {
      asked.push(next);
      return answer({ entries: [entry({ key: "1" })] });
    });
    expect(asked).toEqual([cursors]);
    expect(reread.entries.map((issue) => issue.key)).toEqual(["4", "3", "1"]);
    expect(reread.nextCursors).toEqual({});
    expect(
      holdIssuePages([[environmentId, refreshed]], new Map([[environmentId, reread]])).get(
        environmentId,
      ),
    ).toBe(reread);
  });
});

describe("issueFilterScopes", () => {
  const tracker = (overrides: Partial<IssueTrackerSummary>): IssueTrackerSummary =>
    ({
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
      ...overrides,
    }) as IssueTrackerSummary;
  const linearRow = entry({
    key: "ENG-1",
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "ENG",
  });

  it("offers a bound standalone tracker's scope, named by the rows it listed", () => {
    const held = new Map([
      [
        environmentId,
        hold(
          answer({
            trackers: [tracker({})],
            entries: [linearRow, { ...linearRow, key: "ENG-2" }],
          }),
        ),
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([
      {
        environmentId,
        input: { projectId: api, tracker: "linear", host: "linear.app", scope: "ENG" },
      },
    ]);
  });

  it("offers a bound tracker's scope the answer names when a search matches nothing", () => {
    const scope = {
      projectId: api,
      tracker: "linear" as IssueTrackerKind,
      host: "linear.app",
      scope: "ENG",
    };
    const held = new Map([
      [environmentId, hold(answer({ trackers: [tracker({})], entries: [], scopes: [scope] }))],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([{ environmentId, input: scope }]);
  });

  it("offers the same team key of two Linear accounts as two scopes", () => {
    const first = {
      projectId: api,
      tracker: "linear" as IssueTrackerKind,
      host: "linear.app",
      scope: "ENG",
    };
    const second = hold(
      answer({
        trackers: [tracker({})],
        scopes: [first, { ...first, projectId: "home" as ProjectId }],
      }),
    );
    const other = hold(
      answer({ trackers: [tracker({})], scopes: [{ ...first, projectId: "o" as ProjectId }] }),
    );
    // Older servers name no scopes; their rows stand in, once per team on that server.
    const older = hold(
      answer({ trackers: [tracker({})], entries: [linearRow, { ...linearRow, key: "ENG-2" }] }),
    );
    const count = (...pages: ReadonlyArray<ReturnType<typeof hold>>) =>
      issueFilterScopes(
        new Map(pages.map((page, index) => [`env-${index}` as EnvironmentId, page])),
        [],
      ).length;
    expect([count(second), count(second, other), count(other, second)]).toEqual([2, 3, 3]);
    expect([count(older), count(older, second), count(second, older)]).toEqual([1, 3, 3]);
  });

  it("skips a tracker that cannot be read", () => {
    const held = new Map([
      [
        environmentId,
        hold(answer({ trackers: [tracker({ configured: false })], entries: [linearRow] })),
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([]);
  });
});

describe("groupIssues", () => {
  it("lists an issue once when two environments hold the same repository", () => {
    const github = {
      tracker: "github",
      host: "github.com",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const page = answer({
      trackers: [github],
      entries: [entry({ key: "1" }), entry({ key: "2" })],
    });
    const held = holdIssuePages(
      [
        [environmentId, page],
        [
          "env-2" as EnvironmentId,
          answer({
            ...page,
            entries: page.entries.map((row) => ({ ...row, projectId: "other" as ProjectId })),
          }),
        ],
      ],
      new Map(),
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.displayKey)).toEqual(["#1", "#2"]);
  });

  it("keeps same-keyed issues from two Linear workspaces apart", () => {
    const linear = {
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const inWorkspace = (workspace: string) =>
      answer({
        trackers: [linear],
        entries: [
          entry({
            tracker: "linear" as IssueTrackerKind,
            host: "linear.app",
            scope: "ENG",
            key: "ENG-1",
            url: `https://linear.app/${workspace}/issue/ENG-1`,
          }),
        ],
      });
    const held = holdIssuePages(
      [
        [environmentId, inWorkspace("acme")],
        ["env-2" as EnvironmentId, inWorkspace("globex")],
      ],
      new Map(),
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.url)).toEqual([
      "https://linear.app/acme/issue/ENG-1",
      "https://linear.app/globex/issue/ENG-1",
    ]);
  });
});
