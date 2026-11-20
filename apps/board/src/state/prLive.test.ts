import {
  EnvironmentId,
  ProjectId,
  type PullRequestChecks,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CheckRun } from "../domain/readiness";
import type { Ticket } from "../domain/ticket";
import { buildLive, type PrProject, ticketPrRef, trackRunning } from "./prLive";

const project: PrProject = {
  id: ProjectId.make("project-1"),
  environmentId: EnvironmentId.make("env-1"),
};

const snapshot = (
  fields: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {},
): NonNullable<ThreadPullRequestLink["snapshot"]> => ({
  state: "open",
  title: "Add login",
  headBranch: "feat/login",
  baseBranch: "main",
  isDraft: false,
  updatedAt: null,
  syncedAt: "2026-11-20T10:00:00.000Z",
  ...fields,
});

const link = (
  number: number,
  fields: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  source: "agent",
  linkedAt: "2026-11-20T10:00:00.000Z",
  snapshot: null,
  stack: null,
  ...fields,
});

const ticket = (fields: Partial<Ticket> = {}): Ticket => ({
  key: "T-1",
  title: "Add login",
  stage: "pr",
  ...fields,
});

const checks = (
  entries: ReadonlyArray<readonly [string, PullRequestChecks["checks"][number]["status"]]>,
): PullRequestChecks["checks"] =>
  entries.map(([name, status]) => ({
    name,
    status,
    description: null,
    url: `https://ci.example/run/1/${name}`,
  }));

describe("a ticket's pull request", () => {
  it("Given a bare number that a thread of the ticket links, when it is resolved, then the link's repository is used", () => {
    expect(ticketPrRef(ticket({ pr: 12 }), [link(12)], project)).toEqual({
      projectId: "project-1",
      host: "github.com",
      repository: "acme/app",
      number: 12,
    });
  });

  it("Given no pr and two linked pull requests, when it is resolved, then the one on the ticket's branch wins", () => {
    const own = [
      link(7, { snapshot: snapshot({ headBranch: "feat/other" }) }),
      link(9, { snapshot: snapshot({ headBranch: "feat/login" }) }),
      link(11),
    ];
    expect(ticketPrRef(ticket({ branch: "feat/login" }), own, project)?.number).toBe(9);
  });

  it("Given a link that was dismissed from a stack, when no pr is set, then it is not the ticket's", () => {
    expect(ticketPrRef(ticket(), [link(5, { source: "stack-dismissed" })], project)).toBeNull();
  });
});

describe("running checks", () => {
  const runs = (seen: Map<string, number>, entries: Parameters<typeof checks>[0], now: number) =>
    trackRunning(seen, "pr", checks(entries), now);

  it("Given a check seen running at two reads, when the second read runs, then it keeps the first read's time", () => {
    const seen = new Map<string, number>();
    runs(seen, [["test", "pending"]], 1_000);
    expect(runs(seen, [["test", "pending"]], 61_000)[0]?.runningSince).toBe(1_000);
  });

  it("Given a check that finished and then runs again, when it is read, then its clock starts over", () => {
    const seen = new Map<string, number>();
    runs(seen, [["test", "pending"]], 1_000);
    runs(seen, [["test", "failure"]], 2_000);
    expect(runs(seen, [["test", "pending"]], 3_000)[0]?.runningSince).toBe(3_000);
  });

  it("Given a running check whose link names a new run, when it is read, then its clock starts over", () => {
    const seen = new Map<string, number>();
    runs(seen, [["test", "pending"]], 1_000);
    const next = trackRunning(
      seen,
      "pr",
      [
        {
          name: "test",
          status: "pending",
          description: null,
          url: "https://ci.example/run/2/test",
        },
      ],
      61_000,
    );
    expect(next[0]?.runningSince).toBe(61_000);
  });

  it("Given a finished check, when it is read, then it is not marked running", () => {
    const run: CheckRun | undefined = runs(new Map(), [["test", "success"]], 1_000)[0];
    expect(run?.runningSince).toBeNull();
  });
});

describe("live pull request state", () => {
  it("Given a snapshot that says failing and a check list that has not caught up, when it is built, then the snapshot decides", () => {
    const pushed = snapshot({ checksState: "failing", mergeability: "conflicting" });
    const stale = checks([["test", "pending"]]);
    const live = buildLive({
      link: link(12, { snapshot: pushed }),
      summary: null,
      checks: { state: "open", checks: stale },
      runs: trackRunning(new Map(), "pr", stale, 0),
    });
    expect(live).toMatchObject({
      state: "open",
      checksState: "failing",
      mergeability: "conflicting",
    });
  });

  it("Given a check list read after the snapshot, when it is built, then the check list decides", () => {
    const pushed = snapshot({ checksState: "passing" });
    const failed = checks([["unit", "failure"]]);
    const live = buildLive({
      link: link(12, { snapshot: pushed }),
      summary: null,
      checks: { state: "open", checks: failed, observedAt: Date.parse("2026-11-20T10:05:00.000Z") },
      runs: trackRunning(new Map(), "pr", failed, 0),
    });
    expect(live?.checksState).toBe("failing");
  });

  it("Given a saved check list older than the snapshot, when it is built, then the snapshot decides", () => {
    const pushed = snapshot({ checksState: "failing" });
    const saved = checks([["unit", "success"]]);
    const live = buildLive({
      link: link(12, { snapshot: pushed }),
      summary: null,
      checks: { state: "open", checks: saved, observedAt: Date.parse("2026-11-20T09:00:00.000Z") },
      runs: trackRunning(new Map(), "pr", saved, 0),
    });
    expect(live?.checksState).toBe("failing");
  });

  it("Given a source that says merged, when another still says open, then the pull request is merged", () => {
    const live = buildLive({
      link: link(12, { snapshot: snapshot() }),
      summary: null,
      checks: { state: "merged", checks: [] },
      runs: [],
    });
    expect(live?.state).toBe("merged");
  });

  it("Given no source has answered, when it is built, then there is no live state", () => {
    expect(buildLive({ link: undefined, summary: null, checks: null, runs: [] })).toBeNull();
  });
});
