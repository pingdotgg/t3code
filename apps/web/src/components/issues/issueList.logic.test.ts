import type {
  EnvironmentId,
  IssueLink,
  IssueListEntry,
  IssueListResult,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueTree,
  collectIssueFacets,
  issueKey,
  matchesIssueFilters,
  mergeIssueLists,
  repositoryKey,
  sortIssues,
  type EnvironmentIssueEntry,
  type IssueTreeNode,
  environmentIdsWithCapability,
} from "./issueList.logic";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

function link(number: number, overrides: Partial<IssueLink> = {}): IssueLink {
  const repository = overrides.repository ?? "toolboxmd/t3code";
  return {
    host: "github.com",
    repository,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
    state: "open",
    ...overrides,
  };
}

function entry(
  number: number,
  overrides: Partial<EnvironmentIssueEntry> = {},
): EnvironmentIssueEntry {
  return {
    ...link(number, overrides),
    environmentId: ENV_A,
    projectId: "project-1" as ProjectId,
    projectTitle: "t3code",
    author: "lukemaj",
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: `2026-09-${String(number).padStart(2, "0")}T10:00:00Z`,
    updatedAt: "2026-09-25T10:00:00Z",
    parent: null,
    subIssues: [],
    subIssueCount: 0,
    openBlockerCount: 0,
    closingPullRequests: [],
    ...overrides,
  };
}

function result(
  entries: ReadonlyArray<IssueListEntry>,
  overrides: Partial<IssueListResult> = {},
): IssueListResult {
  return {
    repositories: [
      {
        host: "github.com",
        repository: "toolboxmd/t3code",
        projectId: "project-1" as ProjectId,
        projectTitle: "t3code",
      },
    ],
    unsupported: [],
    viewers: [{ host: "github.com", login: "lukemaj" }],
    linkedPullRequests: [],
    errors: [],
    entries,
    nextCursors: {},
    ...overrides,
  };
}

const strip = ({ environmentId: _environmentId, ...rest }: EnvironmentIssueEntry) => rest;

describe("mergeIssueLists", () => {
  it("is null before any server answered", () => {
    expect(mergeIssueLists([])).toBeNull();
  });

  it("keeps the first server's copy of an Issue two servers both list", () => {
    const merged = mergeIssueLists([
      [ENV_A, result([strip(entry(1)), strip(entry(2))])],
      [ENV_B, result([strip(entry(2)), strip(entry(3))])],
    ]);
    expect(merged?.entries.map((row) => [row.number, row.environmentId])).toEqual([
      [1, ENV_A],
      [2, ENV_A],
      [3, ENV_B],
    ]);
    expect(merged?.repositories).toHaveLength(1);
  });

  it("walks a server's continuation forward and drops it once exhausted", () => {
    const first = mergeIssueLists([
      [ENV_A, result([strip(entry(3))], { nextCursors: { "github.com#0": "c1" } })],
    ]);
    expect(first?.nextCursors.get(ENV_A)).toEqual({ "github.com#0": "c1" });
    const second = mergeIssueLists([
      [ENV_A, result([strip(entry(3))], { nextCursors: { "github.com#0": "c1" } })],
      [ENV_A, result([strip(entry(2))], { nextCursors: {} })],
    ]);
    expect(second?.entries.map((row) => row.number)).toEqual([3, 2]);
    expect(second?.nextCursors.has(ENV_A)).toBe(false);
  });

  it("counts each repository on another forge once, across pages and servers", () => {
    const merged = mergeIssueLists([
      [ENV_A, result([], { unsupported: [{ host: "gitlab.com", repository: "a/one" }] })],
      [ENV_A, result([], { unsupported: [{ host: "gitlab.com", repository: "a/one" }] })],
      [
        ENV_B,
        result([], {
          unsupported: [
            { host: "GitLab.com", repository: "A/One" },
            { host: "gitlab.com", repository: "a/two" },
          ],
        }),
      ],
    ]);
    expect(merged?.unsupported).toEqual([{ host: "gitlab.com", repositoryCount: 2 }]);
  });
});

describe("matchesIssueFilters", () => {
  const parent = link(25);
  const row = entry(27, {
    labels: [
      { name: "Bug", color: "d73a4a" },
      { name: "web", color: "000000" },
    ],
    milestone: "M1",
    parent,
  });

  it("narrows by repository", () => {
    expect(
      matchesIssueFilters(row, { repository: repositoryKey("github.com", "toolboxmd/t3code") }),
    ).toBe(true);
    expect(
      matchesIssueFilters(row, { repository: repositoryKey("github.com", "toolboxmd/other") }),
    ).toBe(false);
  });

  it("requires every chosen label, ignoring case", () => {
    expect(matchesIssueFilters(row, { labels: ["bug", "WEB"] })).toBe(true);
    expect(matchesIssueFilters(row, { labels: ["bug", "mobile"] })).toBe(false);
  });

  it("narrows by milestone", () => {
    expect(matchesIssueFilters(row, { milestone: "m1" })).toBe(true);
    expect(matchesIssueFilters(row, { milestone: "M2" })).toBe(false);
    expect(matchesIssueFilters(entry(1), { milestone: "M1" })).toBe(false);
  });

  it("keeps top-level Issues or the children of one parent", () => {
    expect(matchesIssueFilters(row, { parent: "none" })).toBe(false);
    expect(matchesIssueFilters(entry(1), { parent: "none" })).toBe(true);
    expect(matchesIssueFilters(row, { parent: issueKey(parent) })).toBe(true);
    expect(matchesIssueFilters(row, { parent: issueKey(link(26)) })).toBe(false);
  });
});

describe("sortIssues", () => {
  const rows = [
    entry(3, { updatedAt: "2026-09-20T00:00:00Z" }),
    entry(1, { updatedAt: "2026-09-25T00:00:00Z" }),
    entry(2, { updatedAt: "2026-09-22T00:00:00Z", repository: "toolboxmd/b" }),
    entry(2, { updatedAt: "2026-09-22T00:00:00Z", repository: "toolboxmd/a" }),
  ];

  it("orders by last update, newest first, stable on ties", () => {
    expect(sortIssues(rows, "updated").map((row) => `${row.repository}#${row.number}`)).toEqual([
      "toolboxmd/t3code#1",
      "toolboxmd/a#2",
      "toolboxmd/b#2",
      "toolboxmd/t3code#3",
    ]);
  });

  it("orders by creation and by number, newest first", () => {
    expect(sortIssues(rows, "created").map((row) => row.number)).toEqual([3, 2, 2, 1]);
    expect(sortIssues(rows, "number").map((row) => row.number)).toEqual([3, 2, 2, 1]);
  });
});

describe("collectIssueFacets", () => {
  it("offers labels by use, milestones and the parents of loaded rows", () => {
    const facets = collectIssueFacets([
      entry(1, { labels: [{ name: "bug", color: "red" }], milestone: "M1", parent: link(9) }),
      entry(2, {
        labels: [
          { name: "Bug", color: "red" },
          { name: "docs", color: "blue" },
        ],
        parent: link(9),
      }),
    ]);
    expect(facets.labels.map((label) => label.name)).toEqual(["bug", "docs"]);
    expect(facets.milestones).toEqual(["M1"]);
    expect(facets.parents.map((parent) => parent.number)).toEqual([9]);
  });
});

describe("buildIssueTree", () => {
  const projects = new Set([repositoryKey("github.com", "toolboxmd/t3code")]);
  const shape = (nodes: ReadonlyArray<IssueTreeNode>): unknown =>
    nodes.map((node) => ({
      key: `${node.link.repository}#${node.link.number}`,
      loaded: node.entry !== null,
      ...(node.outsideProjects ? { outside: true } : {}),
      ...(node.unlistedChildCount > 0 ? { more: node.unlistedChildCount } : {}),
      ...(node.children.length > 0 ? { children: shape(node.children) } : {}),
    }));

  it("nests loaded children under their parent and keeps orphans at the root", () => {
    const parent = entry(25, { subIssues: [link(27), link(28)], subIssueCount: 2 });
    const tree = buildIssueTree(
      [
        parent,
        entry(27, { parent: link(25) }),
        entry(28, { parent: link(25) }),
        entry(40, { parent: link(99) }),
      ],
      projects,
    );
    expect(shape(tree)).toEqual([
      {
        key: "toolboxmd/t3code#25",
        loaded: true,
        children: [
          { key: "toolboxmd/t3code#27", loaded: true },
          { key: "toolboxmd/t3code#28", loaded: true },
        ],
      },
      // Its parent is not on the page, so it stays a root.
      { key: "toolboxmd/t3code#40", loaded: true },
    ]);
  });

  it("shows children in other repositories as link rows marked outside the projects", () => {
    const tree = buildIssueTree(
      [
        entry(3, {
          subIssues: [
            link(1, { repository: "toolboxmd/agent-observer" }),
            link(5, { state: "done" }),
          ],
          subIssueCount: 4,
        }),
      ],
      projects,
    );
    expect(shape(tree)).toEqual([
      {
        key: "toolboxmd/t3code#3",
        loaded: true,
        more: 2,
        children: [
          { key: "toolboxmd/agent-observer#1", loaded: false, outside: true },
          // Not loaded (filtered out or on a later page) but inside the projects: unmarked.
          { key: "toolboxmd/t3code#5", loaded: false },
        ],
      },
    ]);
  });

  it("attaches a loaded child its parent's first page left out, and survives a cycle", () => {
    const tree = buildIssueTree(
      [
        entry(1, { subIssues: [link(2)], subIssueCount: 60, parent: null }),
        entry(2, { parent: link(1), subIssues: [link(1)], subIssueCount: 1 }),
        entry(70, { parent: link(1) }),
      ],
      projects,
    );
    expect(shape(tree)).toEqual([
      {
        key: "toolboxmd/t3code#1",
        loaded: true,
        more: 59,
        children: [
          { key: "toolboxmd/t3code#2", loaded: true },
          { key: "toolboxmd/t3code#70", loaded: true },
        ],
      },
    ]);
  });
});

describe("environmentIdsWithCapability", () => {
  const server = (id: string, capabilities: { issues?: boolean; issueLinks?: boolean } | null) => ({
    environmentId: id as EnvironmentId,
    serverConfig: capabilities === null ? null : { environment: { capabilities } },
  });
  const environments = [
    server("upstream", {}),
    server("fork-b", { issues: true, issueLinks: true }),
    server("connecting", null),
    server("fork-a", { issues: true }),
  ];

  it("keeps only servers that advertise the capability, sorted", () => {
    // Upstream and older servers would answer `issues.list` with an unknown-tag error.
    expect(environmentIdsWithCapability(environments, "issues")).toEqual(["fork-a", "fork-b"]);
    expect(environmentIdsWithCapability(environments, "issueLinks")).toEqual(["fork-b"]);
  });
});
