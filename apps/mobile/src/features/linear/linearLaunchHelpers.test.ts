import type { ComposerContextRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linearDraftWorkspaceSelection, linearThreadCreationFields } from "./linearLaunchHelpers";

const launch = {
  issueId: "issue-1",
  identifier: "ATT-612",
  branchName: "ada/att-612-add-retry",
  mappedProjectId: null,
  moveTo: null,
  moveEnabled: false,
  commentEnabled: true,
};
const chip = { kind: "linear-issue", issueId: "issue-1" } as ComposerContextRecord;
const other = { kind: "mention", path: "src/index.ts" } as ComposerContextRecord;

describe("linear launch helpers", () => {
  it("starts a worktree on the mapped base branch and a local checkout on the current one", () => {
    expect(
      linearDraftWorkspaceSelection({ envMode: "worktree", branch: "main", worktreePath: null }),
    ).toEqual({ mode: "worktree", branch: "main", worktreePath: null });
    expect(
      linearDraftWorkspaceSelection({ envMode: "local", branch: null, worktreePath: null }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null, followsCurrentCheckout: true });
  });

  it("links and branches a new task only while its issue chip is attached", () => {
    const attached = { linearIssue: launch, context: { version: 1 as const, records: [chip] } };
    expect(linearThreadCreationFields(attached, "worktree")).toEqual({
      linearIssue: launch,
      worktreeBranchName: "ada/att-612-add-retry",
    });
    expect(linearThreadCreationFields(attached, "local")).toEqual({ linearIssue: launch });
    expect(
      linearThreadCreationFields(
        { linearIssue: launch, context: { version: 1, records: [other] } },
        "worktree",
      ),
    ).toEqual({});
  });
});
