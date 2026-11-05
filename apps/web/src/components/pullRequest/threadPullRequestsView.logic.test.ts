import { ThreadPullRequestLink } from "@t3tools/contracts";
import type { ThreadPullRequestChain } from "@t3tools/client-runtime/thread-pull-requests";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { type LinkedPullRequestView, linkedPullRequestRows } from "./threadPullRequestsView.logic";

const decodeLink = Schema.decodeUnknownSync(ThreadPullRequestLink);

function link(
  number: number,
  status: "draft" | "open" | "merged" | "closed",
  updatedAt: string,
  repository = "acme/web",
) {
  return decodeLink({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-11-01T00:00:00Z",
    stack: null,
    snapshot: {
      state: status === "draft" ? "open" : status,
      isDraft: status === "draft",
      title: `PR ${number}`,
      headBranch: `branch-${number}`,
      baseBranch: "main",
      updatedAt,
      syncedAt: updatedAt,
    },
  });
}

const single = (pr: ThreadPullRequestLink): ThreadPullRequestChain => ({
  kind: "derived",
  layers: [pr],
  depths: [0],
});

const DEFAULT_VIEW: LinkedPullRequestView = {
  sort: "status",
  hiddenStatuses: ["closed"],
  groupStacks: true,
};

// Base #1 and #2 merged, #3 still open on top.
const stack: ThreadPullRequestChain = {
  kind: "native",
  layers: [
    link(1, "merged", "2026-11-01T01:00:00Z"),
    link(2, "merged", "2026-11-01T02:00:00Z"),
    link(3, "open", "2026-11-01T03:00:00Z"),
  ],
  depths: [0, 1, 2],
};

const summarize = (rows: ReturnType<typeof linkedPullRequestRows>) =>
  rows.map((row) =>
    row.kind === "header"
      ? `[${row.label} ${row.count}]`
      : row.kind === "hidden"
        ? `(${row.count} hidden)`
        : `#${row.line.link.number}${row.position === null ? "" : ` ${row.position}/${row.line.stack?.size}`}${row.dimmed ? " dim" : ""}`,
  );

describe("linkedPullRequestRows", () => {
  it("groups by status from draft to merged and hides closed by default", () => {
    const chains = [
      single(link(10, "merged", "2026-11-02T00:00:00Z")),
      single(link(11, "open", "2026-11-02T01:00:00Z")),
      single(link(12, "closed", "2026-11-02T02:00:00Z")),
      single(link(13, "draft", "2026-11-02T03:00:00Z")),
      single(link(14, "open", "2026-11-02T04:00:00Z")),
    ];
    expect(summarize(linkedPullRequestRows(chains, DEFAULT_VIEW))).toEqual([
      "[Draft 1]",
      "#13",
      "[Open 2]",
      "#14",
      "#11",
      "[Merged 1]",
      "#10",
      "(1 hidden)",
    ]);
  });

  it("keeps a grouped stack with its least finished layer and dims finished layers", () => {
    const chains = [single(link(20, "merged", "2026-11-02T00:00:00Z")), stack];
    expect(summarize(linkedPullRequestRows(chains, DEFAULT_VIEW))).toEqual([
      "[Open 3]",
      "#1 dim",
      "#2 dim",
      "#3",
      "[Merged 1]",
      "#20",
    ]);
    expect(
      summarize(linkedPullRequestRows(chains, { ...DEFAULT_VIEW, hiddenStatuses: ["open"] })),
    ).toEqual(["[Merged 4]", "#20", "#1", "#2", "#3 dim"]);
    const draftStack: ThreadPullRequestChain = {
      kind: "native",
      layers: [link(4, "open", "2026-11-01T01:00:00Z"), link(5, "draft", "2026-11-01T02:00:00Z")],
      depths: [0, 1],
    };
    expect(summarize(linkedPullRequestRows([draftStack], DEFAULT_VIEW))).toEqual([
      "[Draft 2]",
      "#4",
      "#5",
    ]);
  });

  it("flattens stacks into their own status groups with each layer's position", () => {
    expect(
      summarize(linkedPullRequestRows([stack], { ...DEFAULT_VIEW, groupStacks: false })),
    ).toEqual(["[Open 1]", "#3 3/3", "[Merged 2]", "#2 2/3", "#1 1/3"]);
  });

  it("groups by repository and sorts newest first inside each group", () => {
    const chains = [
      single(link(30, "open", "2026-11-02T00:00:00Z", "acme/web")),
      single(link(31, "open", "2026-11-02T01:00:00Z", "acme/api")),
      single(link(32, "merged", "2026-11-02T02:00:00Z", "acme/web")),
    ];
    expect(
      summarize(linkedPullRequestRows(chains, { ...DEFAULT_VIEW, sort: "repository" })),
    ).toEqual(["[acme/api 1]", "#31", "[acme/web 2]", "#32", "#30"]);
  });
});
