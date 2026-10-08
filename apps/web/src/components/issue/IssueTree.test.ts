import type { IssueRelativeNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { flattenIssueTree, issueTreeLabel, mergeIssueTrees } from "./IssueTree";

function issue(
  number: number,
  subIssues: Array<IssueRelativeNode> = [],
  team = "ENG",
): IssueRelativeNode {
  return {
    repository: team,
    number,
    title: `Issue ${number}`,
    url: `https://linear.app/acme/issue/${team}-${number}/issue-${number}`,
    state: "open",
    subIssues,
  };
}

describe("issue tree", () => {
  const root = {
    ...issue(2, [issue(3, [issue(5)]), issue(4)]),
    ancestors: [issue(0), issue(1)],
  };

  it("lists ancestors, the issue, then sub-issues depth-first", () => {
    expect(flattenIssueTree(root).map((row) => [row.issue.number, row.depth, row.current])).toEqual(
      [
        [0, 0, false],
        [1, 1, false],
        [2, 2, true],
        [3, 3, false],
        [5, 4, false],
        [4, 3, false],
      ],
    );
  });
});

describe("merged issue trees", () => {
  const provider = "linear";
  const epic = { ...issue(94, [issue(96), issue(95)]), ancestors: [issue(97)] };
  const sibling = {
    ...issue(101),
    ancestors: [issue(97)],
    linkedPullRequests: [
      {
        repository: "acme/web",
        number: 751,
        title: "Hello",
        url: "https://github.com/acme/web/pull/751",
        state: "open" as const,
        isDraft: true,
        closesIssue: true,
      },
    ],
  };
  const child = { ...issue(96), ancestors: [issue(97), issue(94)] };

  it("puts linked issues under a shared ancestor in one tree, each where it sits", () => {
    const [tree, ...rest] = mergeIssueTrees([
      { provider, linkKey: "a", detail: epic },
      { provider, linkKey: "b", detail: sibling },
      { provider, linkKey: "c", detail: child },
    ]);
    expect(rest).toEqual([]);
    expect(tree!.rows.map((row) => [row.issue.number, row.depth, row.linkKey])).toEqual([
      [97, 0, null],
      [94, 1, "a"],
      [96, 2, "c"],
      [95, 2, null],
      [101, 1, "b"],
    ]);
    expect(tree!.rows.at(-1)!.issue.linkedPullRequests?.[0]?.number).toBe(751);
  });

  it("keeps same-number issues of different teams and workspaces apart", () => {
    const ops = issue(94, [], "OPS");
    const [tree, ...rest] = mergeIssueTrees([
      { provider, linkKey: "a", detail: { ...epic, subIssues: [ops, issue(95)] } },
      { provider, linkKey: "b", detail: { ...ops, ancestors: [issue(97), issue(94)] } },
      {
        provider,
        linkKey: "c",
        detail: { ...issue(97), url: "https://linear.app/other/issue/ENG-97" },
      },
    ]);
    expect(rest).toHaveLength(1);
    expect(tree!.rows.map((row) => [row.issue.repository, row.issue.number, row.linkKey])).toEqual([
      ["ENG", 97, null],
      ["ENG", 94, "a"],
      ["OPS", 94, "b"],
      ["ENG", 95, null],
    ]);
  });

  it("joins linked issues whose bounded reads overlap on one chain", () => {
    const b = { ...issue(2, [issue(3, [issue(4, [issue(5)])])]), ancestors: [issue(1)] };
    const e = {
      ...issue(5),
      ancestors: [issue(2), issue(3), issue(4)],
      linkedPullRequests: sibling.linkedPullRequests,
    };
    const sources = [
      { provider, linkKey: "b", detail: b },
      { provider, linkKey: "e", detail: e },
    ];
    for (const order of [sources, sources.toReversed()]) {
      const [tree, ...rest] = mergeIssueTrees(order);
      expect(rest).toEqual([]);
      expect(tree!.rows.map((row) => [row.issue.number, row.depth, row.linkKey])).toEqual([
        [1, 0, null],
        [2, 1, "b"],
        [3, 2, null],
        [4, 3, null],
        [5, 4, "e"],
      ]);
      expect(tree!.rows.at(-1)!.issue.linkedPullRequests?.[0]?.number).toBe(751);
    }
  });

  const github = (repo: string, number: number, host = "github.com"): IssueRelativeNode => ({
    repository: repo,
    number,
    title: `${repo} ${number}`,
    url: `https://${host}/${repo}/issues/${number}`,
    state: "open",
    subIssues: [],
  });

  it("keeps same-number issues of different repositories and hosts apart", () => {
    const [tree, ...rest] = mergeIssueTrees([
      {
        provider: "github",
        linkKey: "a",
        detail: { ...github("acme/web", 1), subIssues: [github("acme/api", 1)] },
      },
      { provider: "github", linkKey: "b", detail: github("acme/web", 1, "github.acme.test") },
    ]);
    expect(rest).toHaveLength(1);
    expect(tree!.rows.map((row) => row.issue.repository)).toEqual(["acme/web", "acme/api"]);
  });

  it("merges linked siblings from different repositories beneath their common parent", () => {
    const parent = github("acme/epics", 7);
    const [tree, ...rest] = mergeIssueTrees([
      {
        provider: "github",
        linkKey: "a",
        detail: { ...github("acme/web", 3), ancestors: [parent] },
      },
      {
        provider: "github",
        linkKey: "b",
        detail: { ...github("acme/api", 3), ancestors: [parent] },
      },
    ]);
    expect(rest).toEqual([]);
    expect(tree!.rows.map((row) => [row.issue.repository, row.depth, row.linkKey])).toEqual([
      ["acme/epics", 0, null],
      ["acme/web", 1, "a"],
      ["acme/api", 1, "b"],
    ]);
  });
});

describe("issue tree labels", () => {
  it("names other repositories and gives each Linear issue its own team key", () => {
    expect(issueTreeLabel({ ...issue(4), repository: "acme/web" }, "acme/web", "hash")).toBe("#4");
    expect(issueTreeLabel({ ...issue(4), repository: "acme/api" }, "acme/web", "hash")).toBe(
      "acme/api#4",
    );
    expect(issueTreeLabel(issue(4), "ENG", "key-number")).toBe("ENG-4");
    expect(issueTreeLabel(issue(42, [], "OPS"), "ENG", "key-number")).toBe("OPS-42");
  });
});
