import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GitButlerWorkspaceInput, GitButlerWorkspaceStatus } from "./gitButler.ts";

const decodeInput = Schema.decodeSync(GitButlerWorkspaceInput);
const decodeStatus = Schema.decodeSync(GitButlerWorkspaceStatus);
const encodeInput = Schema.encodeSync(GitButlerWorkspaceInput);
const encodeStatus = Schema.encodeSync(GitButlerWorkspaceStatus);
const readyStatus = {
  status: "ready" as const,
  version: "0.22.3",
  unassignedChanges: [],
  conflictedFiles: [],
  stacks: [],
  mergeBaseCommitId: "base123",
  upstreamBehind: 0,
  upstreamLastFetched: null,
};

describe("GitButler contracts", () => {
  it("normalizes workspace input and decodes a ready status", () => {
    const input = decodeInput({ cwd: " /workspace/project " });
    const status = decodeStatus({
      ...readyStatus,
      conflictedFiles: ["src/conflict.ts"],
    });

    expect(input).toEqual({ cwd: "/workspace/project" });
    expect(encodeInput(input)).toEqual({ cwd: "/workspace/project" });
    expect(status).toMatchObject({
      status: "ready",
      conflictedFiles: ["src/conflict.ts"],
      upstreamBehind: 0,
    });
    expect(encodeStatus(status)).toEqual({
      ...readyStatus,
      conflictedFiles: ["src/conflict.ts"],
    });
  });

  it("rejects invalid upstream and review numbers", () => {
    expect(() => decodeStatus({ ...readyStatus, upstreamBehind: -1 })).toThrow();
    expect(() =>
      decodeStatus({
        ...readyStatus,
        stacks: [
          {
            id: "stack-1",
            assignedChanges: [],
            branches: [
              {
                name: "feature/review",
                branchStatus: "unpushedCommits",
                reviewId: "(#0)",
                reviewNumber: 0,
                reviewStatus: "pending",
                commits: [],
                upstreamCommits: [],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
