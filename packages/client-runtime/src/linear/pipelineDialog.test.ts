import type { LinearIssueDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  includesFromSettings,
  pipelineInputSummary,
  pipelineInputText,
  pipelineWorkspaceStrategy,
  readLastUsedPipelineId,
  resolveInitialPipelineId,
  writeLastUsedPipelineId,
} from "./pipelineDialog.ts";

const detail = {
  issue: {
    id: "i",
    identifier: "ATT-612",
    title: "Handshake",
    url: "https://linear.app/x",
    state: { id: "s", name: "Todo", type: "unstarted", color: "#999" },
    priorityLabel: "High",
    assignee: null,
    labels: [],
    milestone: null,
    project: null,
    team: { id: "t", key: "ATT", name: "Attraccess" },
    branchName: "jan/att-612",
    linkedPullRequests: [],
  },
  description: "Body",
  milestoneProgress: null,
  subIssues: [],
  comments: [],
  attachments: [],
} as unknown as LinearIssueDetail;

describe("resolveInitialPipelineId", () => {
  const pipelineIds = ["a", "b", "c"];
  it("prefers the requested pipeline, then the last used, then the first", () => {
    expect(resolveInitialPipelineId({ pipelineIds, requested: "c", lastUsed: "b" })).toBe("c");
    expect(resolveInitialPipelineId({ pipelineIds, requested: "gone", lastUsed: "b" })).toBe("b");
    expect(resolveInitialPipelineId({ pipelineIds, requested: undefined, lastUsed: "gone" })).toBe(
      "a",
    );
    expect(resolveInitialPipelineId({ pipelineIds: [], requested: "a", lastUsed: "a" })).toBeNull();
  });
});

describe("last used pipeline storage", () => {
  it("round-trips and survives broken storage", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    expect(readLastUsedPipelineId(storage)).toBeNull();
    writeLastUsedPipelineId(storage, "p1");
    expect(readLastUsedPipelineId(storage)).toBe("p1");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLastUsedPipelineId(broken)).toBeNull();
    expect(() => writeLastUsedPipelineId(broken, "p1")).not.toThrow();
    expect(readLastUsedPipelineId(undefined)).toBeNull();
  });
});

describe("pipelineInputText", () => {
  const includes = includesFromSettings({
    includeSubIssues: true,
    includeComments: true,
    includeLinkedPrs: false,
  });
  it("renders the issue unless the person edited the text", () => {
    expect(pipelineInputText({ detail, includes, edited: null })).toContain(
      "# ATT-612 · Handshake",
    );
    expect(pipelineInputText({ detail, includes, edited: "my words" })).toBe("my words");
  });
  it("keeps an emptied edit rather than regenerating", () => {
    expect(pipelineInputText({ detail, includes, edited: "" })).toBe("");
  });
});

describe("pipelineInputSummary", () => {
  it("counts includable items and estimates tokens from the text", () => {
    expect(pipelineInputSummary({ detail, text: "x".repeat(7_600) })).toEqual({
      counts: { subIssues: 0, comments: 0, linkedPrs: 0 },
      tokens: "~1.9k tokens",
    });
  });
});

describe("pipelineWorkspaceStrategy", () => {
  it("uses a worktree on the branch name off the base ref", () => {
    expect(
      pipelineWorkspaceStrategy({
        workspace: "worktree",
        baseRef: "develop",
        branchName: "jan/att-612",
      }),
    ).toEqual({ type: "worktree", baseRef: "develop", branch: "jan/att-612" });
  });
  it("falls back to HEAD without a base and omits an empty branch name", () => {
    expect(
      pipelineWorkspaceStrategy({ workspace: "worktree", baseRef: null, branchName: "" }),
    ).toEqual({
      type: "worktree",
      baseRef: "HEAD",
    });
  });
  it("runs in the checkout for local", () => {
    expect(
      pipelineWorkspaceStrategy({ workspace: "local", baseRef: "x", branchName: "y" }),
    ).toEqual({
      type: "root",
    });
  });
});
