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
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
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
