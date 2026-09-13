import { issueProjectSourceKey, issueSourceKey, type IssueListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterIssueQueryResults,
  filterIssuesByInvolvement,
  groupIssuesByInvolvement,
  issueEntryKey,
  issueListOrderLabels,
  matchesIssueQuery,
  narrowIssuesToFilters,
  partitionIssuesWithPriority,
  rankIssueMatches,
  readIssueListSnapshot,
  writeIssueListSnapshot,
  scoreIssueMatch,
  resolveProjectScope,
} from "./issueList.logic";

const VIEWERS = { [issueSourceKey("github", "github.com")]: "Bilal" } as const;
const NO_VIEWERS = {} as const;

const actor = (login: string) => ({ login, name: null, avatarUrl: null });

function entry(overrides: Partial<IssueListEntry> & Pick<IssueListEntry, "number">) {
  return {
    provider: "github",
    host: "github.com",
    projectId: "project-1",
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    title: "Add the issues page",
    url: `https://github.com/pingdotgg/t3code/issues/${overrides.number}`,
    author: actor("octocat"),
    state: "open",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    commentCount: 0,
    ...overrides,
  } as IssueListEntry;
}

describe("issue sort order labels", () => {
  it.each([
    ["created", "Oldest", "Newest"],
    ["updated", "Oldest", "Newest"],
    ["best-match", "Oldest", "Newest"],
    ["comments", "Ascending", "Descending"],
    ["reactions", "Ascending", "Descending"],
    ["reactions-heart", "Ascending", "Descending"],
  ] as const)("labels %s order as %s then %s", (sort, ascending, descending) => {
    expect(issueListOrderLabels(sort)).toEqual([ascending, descending]);
  });
});

describe("issue involvement filtering", () => {
  const entries = [
    entry({ number: 1, author: actor("Bilal") }),
    entry({ number: 2, assignees: [actor("Bilal")] }),
    entry({ number: 3 }),
  ];

  it("matches the viewer's own issues case-insensitively", () => {
    expect(
      filterIssuesByInvolvement(entries, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("reads the host-only viewer key from an older server", () => {
    expect(
      filterIssuesByInvolvement(entries, { "github.com": "Bilal" }, "authored").map(
        (item) => item.number,
      ),
    ).toEqual([1]);
  });

  it("returns nothing for Authored when the viewer is unknown", () => {
    expect(filterIssuesByInvolvement(entries, NO_VIEWERS, "authored")).toEqual([]);
  });

  it("matches any of the assignees for Assigned", () => {
    const shared = entry({ number: 4, assignees: [actor("octocat"), actor("bilal")] });
    expect(
      filterIssuesByInvolvement([...entries, shared], VIEWERS, "assigned").map(
        (item) => item.number,
      ),
    ).toEqual([2, 4]);
  });

  it("leaves the hosts' answer alone for Mentioned, which no row records", () => {
    // Narrowing here against the fields a row does carry would drop every result.
    expect(filterIssuesByInvolvement(entries, VIEWERS, "mentioned")).toHaveLength(3);
  });

  it("does not treat a matching login on another host as the viewer", () => {
    // The same name on GitLab is a different account, and its viewer is unknown here.
    const mixed = [
      entry({ number: 1, author: actor("Bilal") }),
      entry({ number: 2, provider: "gitlab", host: "gitlab.com", author: actor("Bilal") }),
    ];
    expect(
      filterIssuesByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("leaves the superset untouched for All", () => {
    expect(filterIssuesByInvolvement(entries, VIEWERS, "all")).toHaveLength(3);
  });

  it("keeps two hosts of one provider kind as two accounts", () => {
    // A GitHub Enterprise install is a different account from github.com, so the viewer for
    // one must not claim the other's issues.
    const mixed = [
      entry({ number: 1, assignees: [actor("Bilal")] }),
      entry({ number: 2, host: "github.acme.dev", assignees: [actor("Bilal")] }),
    ];
    expect(
      filterIssuesByInvolvement(mixed, VIEWERS, "assigned").map((item) => item.number),
    ).toEqual([1]);
  });

  it("keeps two adapters on one host as two accounts", () => {
    const mixed = [
      entry({ number: 1, author: actor("Bilal") }),
      entry({ number: 2, provider: "jira", author: actor("Jira User") }),
    ];
    const viewers = {
      [issueSourceKey("github", "github.com")]: "Bilal",
      [issueSourceKey("jira", "github.com")]: "Jira User",
    };
    expect(
      filterIssuesByInvolvement(mixed, viewers, "authored").map((item) => item.number),
    ).toEqual([1, 2]);
  });

  it("uses each Linear project's viewer before the shared account fallback", () => {
    const firstProjectId = "linear-one" as IssueListEntry["projectId"];
    const secondProjectId = "linear-two" as IssueListEntry["projectId"];
    const first = entry({
      number: 1,
      provider: "linear",
      host: "linear.app",
      projectId: firstProjectId,
      repository: "T3",
      author: actor("Alice"),
      assignees: [actor("Carol")],
    });
    const second = entry({
      number: 2,
      provider: "linear",
      host: "linear.app",
      projectId: secondProjectId,
      repository: "T3",
      author: actor("Carol"),
      assignees: [actor("Bob")],
    });
    const viewers = {
      [issueProjectSourceKey("linear", "linear.app", firstProjectId)]: "Alice",
      [issueProjectSourceKey("linear", "linear.app", secondProjectId)]: "Bob",
      [issueSourceKey("linear", "linear.app")]: "Fallback",
    };

    expect(filterIssuesByInvolvement([first, second], viewers, "authored")).toEqual([first]);
    expect(filterIssuesByInvolvement([first, second], viewers, "assigned")).toEqual([second]);
  });
});

describe("issue grouping", () => {
  it("buckets assigned above authored and drops empty groups", () => {
    const groups = groupIssuesByInvolvement(
      [
        entry({ number: 1, author: actor("bilal") }),
        entry({ number: 2, assignees: [actor("bilal")] }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => [group.key, group.entries.length])).toEqual([
      ["assigned", 1],
      ["authored", 1],
    ]);
  });

  it("puts everything in Others when the viewer is unknown", () => {
    const groups = groupIssuesByInvolvement([entry({ number: 1 })], NO_VIEWERS);
    expect(groups.map((group) => group.key)).toEqual(["others"]);
  });

  it("counts an issue once, even when the viewer both filed it and has it", () => {
    const groups = groupIssuesByInvolvement(
      [entry({ number: 1, author: actor("bilal"), assignees: [actor("bilal")] })],
      VIEWERS,
    );
    expect(groups.map((group) => group.key)).toEqual(["assigned"]);
  });
});

describe("issue search", () => {
  const target = entry({
    number: 4711,
    title: "Restore sidebar actions",
    assignees: [actor("hexagon")],
    labels: [{ name: "bug", color: "#d73a4a" }],
  });

  it("matches the number with or without the leading hash", () => {
    expect(matchesIssueQuery(target, "#4711")).toBe(true);
    expect(matchesIssueQuery(target, "4711")).toBe(true);
  });

  it("matches title, author, assignee and label case-insensitively", () => {
    expect(matchesIssueQuery(target, "SIDEBAR")).toBe(true);
    expect(matchesIssueQuery(target, "octocat")).toBe(true);
    expect(matchesIssueQuery(target, "Hexagon")).toBe(true);
    expect(matchesIssueQuery(target, "bug")).toBe(true);
  });

  it("ignores surrounding whitespace and rejects non-matches", () => {
    expect(matchesIssueQuery(target, "   ")).toBe(true);
    expect(matchesIssueQuery(target, "kanban")).toBe(false);
  });

  it("filters hosts that cannot search while keeping host search results", () => {
    const localMiss = entry({
      number: 2,
      host: "dev.azure.com",
      provider: "azure-devops",
      title: "Another issue",
    });
    const hiddenHostMatch = entry({ number: 3, title: "Matched in a comment" });

    expect(
      filterIssueQueryResults(
        [target, localMiss, hiddenHostMatch],
        "sidebar",
        true,
        new Set(["github.com"]),
      ).map((item) => item.number),
    ).toEqual([4711, 3]);
  });
});

describe("carrying rows already read into filters nothing has answered yet", () => {
  const rows = [
    entry({ number: 1 }),
    entry({ number: 2, state: "closed", stateReason: "completed" }),
    entry({ number: 3, state: "closed", stateReason: "not-planned" }),
    entry({ number: 4, host: "github.acme.dev" }),
    entry({ number: 5, projectId: "project-2" as IssueListEntry["projectId"] }),
  ];
  const everything = { state: "all", projectId: undefined, host: undefined } as const;

  it("never lets a closed issue sit under Open", () => {
    expect(
      narrowIssuesToFilters(rows, { ...everything, state: "open" }).map((row) => row.number),
    ).toEqual([1, 4, 5]);
  });

  it("keeps both closing reasons under Closed", () => {
    expect(
      narrowIssuesToFilters(rows, { ...everything, state: "closed" }).map((row) => row.number),
    ).toEqual([2, 3]);
  });

  it("narrows to one host, which two installs of one kind cannot share", () => {
    expect(
      narrowIssuesToFilters(rows, { ...everything, host: "github.acme.dev" }).map(
        (row) => row.number,
      ),
    ).toEqual([4]);
  });

  it("narrows to one project", () => {
    expect(
      narrowIssuesToFilters(rows, { ...everything, projectId: "project-2" }).map(
        (row) => row.number,
      ),
    ).toEqual([5]);
  });

  it("holds on to everything when nothing narrows it", () => {
    expect(narrowIssuesToFilters(rows, everything)).toEqual(rows);
  });
});

describe("resolveProjectScope", () => {
  const projects = [{ id: "p1" }, { id: "p2" }];

  it("keeps an id the environment has", () => {
    expect(resolveProjectScope("p2", projects, true)).toBe("p2");
  });

  it("drops an id from another environment", () => {
    expect(resolveProjectScope("p9", projects, false)).toBe("p9");
    expect(resolveProjectScope("p9", projects, true)).toBeUndefined();
  });

  it("keeps an id while the projects are still unknown", () => {
    // Dropping here would list every project for a moment before narrowing back down.
    expect(resolveProjectScope("p9", [], false)).toBe("p9");
  });
});

describe("ranking what a search found", () => {
  const row = (overrides: Partial<IssueListEntry> & { number?: number }) =>
    entry({ number: 1, ...overrides });

  it("puts the issue whose title says it above one that merely mentions it", () => {
    const titled = row({
      number: 1,
      title: "Startup crash on Linux",
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const mentioned = row({ number: 2, title: "Elsewhere", updatedAt: "2026-08-01T00:00:00Z" });
    expect(
      rankIssueMatches([mentioned, titled], "startup crash").map((item) => item.number),
    ).toEqual([1, 2]);
  });

  it("finds the words in any order, which is how people type them", () => {
    // Substrings count, so "crashes" answers "crash" — a search is not a spelling test.
    expect(scoreIssueMatch(row({ title: "It crashes at startup" }), "startup crash")).toBe(70);
    // One of the two words is a mention, not an answer, and ranks under both.
    expect(scoreIssueMatch(row({ title: "A crash, of sorts" }), "startup crash")).toBe(20);
  });

  it("answers a number with the issue that has it, and nothing else", () => {
    expect(scoreIssueMatch(row({ number: 42 }), "#42")).toBe(100);
    expect(scoreIssueMatch(row({ number: 42 }), "43")).toBe(0);
  });

  it("ranks the row's own people and labels above the repository it sits in", () => {
    expect(scoreIssueMatch(row({ author: actor("hexagon") }), "hexagon")).toBe(60);
    expect(scoreIssueMatch(row({ assignees: [actor("hexagon")] }), "hexagon")).toBe(50);
    const labelled = row({ labels: [{ name: "hexagon", color: null }] });
    expect(scoreIssueMatch(labelled, "hexagon")).toBe(40);
    expect(scoreIssueMatch(row({ repository: "pingdotgg/hexagon" }), "hexagon")).toBe(30);
  });

  it("keeps a host's own match last rather than dropping it", () => {
    // GitHub read a body this row does not show; it is a result, it is simply the weakest one.
    expect(scoreIssueMatch(row({ title: "no match here" }), "hexagon")).toBe(10);
  });

  it("keeps recency where nothing tells two results apart", () => {
    const older = row({ number: 1, title: "no match here", updatedAt: "2026-07-01T00:00:00Z" });
    const newer = row({ number: 2, title: "none here either", updatedAt: "2026-08-01T00:00:00Z" });
    expect(rankIssueMatches([older, newer], "hexagon").map((item) => item.number)).toEqual([2, 1]);
  });

  it("leaves a listing with no search in the order it arrived", () => {
    const first = row({ number: 1, updatedAt: "2026-07-01T00:00:00Z" });
    const second = row({ number: 2, updatedAt: "2026-08-01T00:00:00Z" });
    expect(rankIssueMatches([first, second], "  ")).toEqual([first, second]);
  });
});

describe("issue row keys", () => {
  it("tells the same number on two hosts apart", () => {
    expect(issueEntryKey(entry({ number: 7 }))).not.toBe(
      issueEntryKey(entry({ number: 7, host: "github.acme.dev" })),
    );
  });

  it("tells the same Linear team issue from two projects apart", () => {
    const firstProjectId = "linear-one" as IssueListEntry["projectId"];
    const secondProjectId = "linear-two" as IssueListEntry["projectId"];
    const first = entry({
      number: 7,
      provider: "linear",
      host: "linear.app",
      projectId: firstProjectId,
      repository: "T3",
    });
    const second = entry({
      number: 7,
      provider: "linear",
      host: "linear.app",
      projectId: secondProjectId,
      repository: "T3",
    });

    expect(issueEntryKey(first)).not.toBe(issueEntryKey(second));
    expect(partitionIssuesWithPriority([first, second], [], [first], () => true)).toEqual([
      { key: "assigned", label: "Assigned to you", entries: [first] },
      { key: "others", label: "Others", entries: [second] },
    ]);
  });
});

describe("partitioning with the hosts' own priority reads", () => {
  const KEEP_ALL = () => true;
  const assignedRow = (number: number, updatedAt: string) =>
    entry({ number, updatedAt, assignees: [actor("Bilal")] });
  const labelled = (row: IssueListEntry, name: string) => ({
    ...row,
    labels: [{ name, color: null }],
  });

  it("keeps Others in feed order when a continuation lands a row already partitioned", () => {
    const older = entry({ number: 1, updatedAt: "2026-07-05T00:00:00Z" });
    const newer = entry({ number: 2, updatedAt: "2026-07-06T00:00:00Z" });
    const mine = assignedRow(3, "2026-07-04T00:00:00Z");
    // The assigned partition already holds the row the continuation carries.
    const groups = partitionIssuesWithPriority([newer, older, mine], [], [mine], KEEP_ALL);
    expect(groups.map((group) => group.key)).toEqual(["assigned", "others"]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([3]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([2, 1]);
  });

  it("appends a row the partition page missed to Others rather than moving it up", () => {
    const shown = entry({ number: 1, updatedAt: "2026-07-06T00:00:00Z" });
    const olderMine = assignedRow(9, "2026-01-01T00:00:00Z");
    const groups = partitionIssuesWithPriority([shown, olderMine], [], [], KEEP_ALL);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([1, 9]);
  });

  it("gives assigned precedence over authored and orders partitions by recency", () => {
    const both = assignedRow(1, "2026-07-01T00:00:00Z");
    const filed = entry({ number: 2, updatedAt: "2026-07-02T00:00:00Z" });
    const filedOlder = entry({ number: 3, updatedAt: "2026-06-02T00:00:00Z" });
    const groups = partitionIssuesWithPriority([], [both, filedOlder, filed], [both], KEEP_ALL);
    expect(groups.map((group) => group.key)).toEqual(["assigned", "authored"]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([1]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([2, 3]);
  });

  it("lets the feed's copy of a partitioned row replace the partition's", () => {
    const stale = assignedRow(1, "2026-07-01T00:00:00Z");
    const fresh = { ...stale, title: "Retitled" };
    const groups = partitionIssuesWithPriority([fresh], [], [stale], KEEP_ALL);
    expect(groups[0]!.entries[0]!.title).toBe("Retitled");
  });

  it("narrows the partitions by whatever narrowed the feed", () => {
    // The label filter runs on the page, after the partitions answered their own question.
    const wanted = labelled(assignedRow(1, "2026-07-03T00:00:00Z"), "bug");
    const unwanted = labelled(assignedRow(2, "2026-07-04T00:00:00Z"), "docs");
    const filed = labelled(entry({ number: 3, updatedAt: "2026-07-05T00:00:00Z" }), "docs");
    const groups = partitionIssuesWithPriority([wanted], [filed], [wanted, unwanted], (row) =>
      row.labels.some((label) => label.name === "bug"),
    );
    expect(groups.map((group) => group.key)).toEqual(["assigned"]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([1]);
  });
});

describe("the list snapshot across a reload", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  };
  const data = {
    entries: [entry({ number: 1 })],
    viewers: { [issueSourceKey("github", "github.com")]: "Bilal" },
    providers: [],
    errors: [{ projectId: "project-1", projectTitle: "t3code", message: "boom" }],
    truncated: true,
    nextCursors: { "github.com pingdotgg/t3code": "cursor-1" },
  } as never;

  it("hydrates the retained rows so ghosts never replace them", () => {
    const storage = makeStorage();
    writeIssueListSnapshot(storage, "env-1", { scope: "env-1:open:all::", data });
    const snapshot = readIssueListSnapshot(storage, "env-1");
    expect(snapshot?.scope).toBe("env-1:open:all::");
    expect(snapshot?.data.entries.map((item) => item.number)).toEqual([1]);
  });

  it("carries the priority groups, without which a cold start regroups the feed", () => {
    const storage = makeStorage();
    writeIssueListSnapshot(storage, "env-1", {
      scope: "s",
      data,
      partitions: { authored: [entry({ number: 2 })], assigned: [entry({ number: 3 })] },
    });
    const snapshot = readIssueListSnapshot(storage, "env-1");
    expect(snapshot?.partitions?.authored.map((item) => item.number)).toEqual([2]);
    expect(snapshot?.partitions?.assigned.map((item) => item.number)).toEqual([3]);
  });

  it("carries neither stale failures nor stale cursors", () => {
    const storage = makeStorage();
    writeIssueListSnapshot(storage, "env-1", { scope: "s", data });
    const snapshot = readIssueListSnapshot(storage, "env-1");
    expect(snapshot?.data.errors).toEqual([]);
    expect(snapshot?.data.nextCursors).toEqual({});
  });

  it("answers nothing for another environment", () => {
    const storage = makeStorage();
    writeIssueListSnapshot(storage, "env-1", { scope: "s", data });
    expect(readIssueListSnapshot(storage, "env-2")).toBeNull();
  });

  it("rejects a snapshot whose rows do not decode as entries", () => {
    const storage = makeStorage();
    storage.setItem(
      "t3.issues.list:env-1",
      JSON.stringify({ scope: "s", data: { entries: [null] } }),
    );
    expect(readIssueListSnapshot(storage, "env-1")).toBeNull();
    storage.setItem(
      "t3.issues.list:env-1",
      JSON.stringify({ scope: "s", data: { entries: [{ host: "github.com" }] } }),
    );
    expect(readIssueListSnapshot(storage, "env-1")).toBeNull();
  });

  it("shrugs off corrupt storage and no storage at all", () => {
    const storage = makeStorage();
    storage.setItem("t3.issues.list:env-1", "{not json");
    expect(readIssueListSnapshot(storage, "env-1")).toBeNull();
    expect(readIssueListSnapshot(undefined, "env-1")).toBeNull();
  });
});
