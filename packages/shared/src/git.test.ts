import type { GitStatusRemoteResult, GitStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { applyGitStatusStreamEvent } from "./git";

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: GitStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasOriginRemote: false,
      isDefaultBranch: false,
      branch: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: GitStatusResult = {
      isRepo: true,
      hostingProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasOriginRemote: true,
      isDefaultBranch: false,
      branch: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: GitStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});
