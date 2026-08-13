import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type VcsStatusAccumulatedResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const observations = vi.hoisted(() => ({
  listRefs: vi.fn(),
  query: vi.fn(),
  remoteStatus: vi.fn(),
  status: vi.fn(),
}));

vi.mock("./query", () => ({ useEnvironmentQuery: observations.query }));
vi.mock("./vcs", () => ({
  vcsEnvironment: {
    listRefs: observations.listRefs,
    remoteStatus: observations.remoteStatus,
    status: observations.status,
  },
}));

import { presentThreadPr } from "./thread-pr-presentation";
import {
  resolveThreadPrStatus,
  resolveThreadPrStatusTarget,
  threadPrStatusTargetKey,
  useThreadPrStatus,
} from "./use-thread-pr";

const environmentId = EnvironmentId.make("environment-1");
const targetKey = threadPrStatusTargetKey({ environmentId, cwd: "/worktree" });
const localAtom = Symbol("local-status");

const pullRequest: NonNullable<VcsStatusAccumulatedResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/t3tools/t3code/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
};

function makeStatus(input: {
  readonly isRepo?: boolean;
  readonly refName: string | null;
  readonly remoteStatusKnown: boolean;
  readonly pr: VcsStatusAccumulatedResult["pr"];
}): VcsStatusAccumulatedResult {
  return {
    isRepo: input.isRepo ?? true,
    sourceControlProvider: {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: input.refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: input.pr,
    remoteStatusKnown: input.remoteStatusKnown,
  };
}

describe("presentThreadPr", () => {
  it("uses the compact pull request number label without a hash prefix", () => {
    expect(presentThreadPr(pullRequest, undefined)).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 pull request merged",
      textClassName: "text-violet-600 dark:text-violet-400",
    });
  });

  it("uses merge-request terminology for GitLab", () => {
    expect(
      presentThreadPr(pullRequest, {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
    });
  });
});

describe("resolveThreadPrStatus", () => {
  it("preserves a same-ref known PR and a same-ref known absence", () => {
    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/a",
        status: makeStatus({
          refName: "feature/a",
          remoteStatusKnown: true,
          pr: pullRequest,
        }),
      }),
    ).toMatchObject({
      targetKey,
      refName: "feature/a",
      remoteStatusKnown: true,
      lifecycleState: "merged",
      pr: { state: "merged", label: "3774" },
    });

    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/a",
        status: makeStatus({ refName: "feature/a", remoteStatusKnown: true, pr: null }),
      }),
    ).toEqual({
      targetKey,
      refName: "feature/a",
      remoteStatusKnown: true,
      lifecycleState: null,
      pr: null,
    });
  });

  it("hides remote-unknown and different-ref cached PR values", () => {
    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/b",
        status: makeStatus({
          refName: "feature/b",
          remoteStatusKnown: false,
          pr: pullRequest,
        }),
      }),
    ).toEqual({
      targetKey,
      refName: "feature/b",
      remoteStatusKnown: false,
      lifecycleState: undefined,
      pr: null,
    });

    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/b",
        status: makeStatus({ refName: "feature/a", remoteStatusKnown: true, pr: pullRequest }),
      }),
    ).toEqual({
      targetKey,
      refName: "feature/a",
      remoteStatusKnown: true,
      lifecycleState: "merged",
      pr: null,
    });
  });

  it("reports a same-target remount as unknown for the current thread ref", () => {
    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/a",
        status: null,
      }),
    ).toEqual({
      targetKey,
      refName: "feature/a",
      remoteStatusKnown: false,
      lifecycleState: undefined,
      pr: null,
    });
  });

  it("binds a confirmed non-repository absence to the requested thread ref", () => {
    expect(
      resolveThreadPrStatus({
        enabled: true,
        targetKey,
        threadRefName: "feature/a",
        status: makeStatus({
          isRepo: false,
          refName: null,
          remoteStatusKnown: false,
          pr: null,
        }),
      }),
    ).toEqual({
      targetKey,
      refName: "feature/a",
      remoteStatusKnown: false,
      lifecycleState: null,
      pr: null,
    });
  });

  it("treats a disabled row as unknown even when a cached PR is known", () => {
    expect(
      resolveThreadPrStatus({
        enabled: false,
        targetKey: null,
        threadRefName: "feature/a",
        status: makeStatus({ refName: "feature/a", remoteStatusKnown: true, pr: pullRequest }),
      }),
    ).toEqual({
      targetKey: null,
      refName: "feature/a",
      remoteStatusKnown: false,
      lifecycleState: undefined,
      pr: null,
    });
  });
});

describe("resolveThreadPrStatusTarget", () => {
  const thread = {
    environmentId,
    branch: "feature/a",
    worktreePath: "/worktree",
  };

  it("omits a status target while the row is logically hidden", () => {
    expect(resolveThreadPrStatusTarget(thread, "/project", false)).toBeNull();
  });

  it("targets local status for a visible row's worktree", () => {
    expect(resolveThreadPrStatusTarget(thread, "/project", true)).toEqual({
      environmentId: thread.environmentId,
      input: { cwd: "/worktree" },
    });
  });

  it("normalizes equivalent target paths and omits branchless targets", () => {
    expect(
      resolveThreadPrStatusTarget({ ...thread, worktreePath: "  /worktree  " }, "/project", true),
    ).toEqual({ environmentId, input: { cwd: "/worktree" } });
    expect(threadPrStatusTargetKey({ environmentId, cwd: "  /worktree  " })).toBe(targetKey);
    expect(resolveThreadPrStatusTarget({ ...thread, branch: null }, "/project", true)).toBeNull();
  });
});

describe("useThreadPrStatus ownership", () => {
  const thread = {
    environmentId,
    id: "thread-1",
    branch: "feature/a",
    worktreePath: "/worktree",
  } as EnvironmentThreadShell;

  beforeEach(() => {
    observations.listRefs.mockReset();
    observations.query.mockReset().mockReturnValue({ data: null });
    observations.remoteStatus.mockReset();
    observations.status.mockReset().mockReturnValue(localAtom);
  });

  it("uses local status only for a visible row", () => {
    useThreadPrStatus(thread, "/project");

    expect(observations.status).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/worktree" },
    });
    expect(observations.query).toHaveBeenCalledWith(localAtom);
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });

  it("releases the query when its retained row is hidden", () => {
    useThreadPrStatus(thread, "/project", { enabled: false });

    expect(observations.query).toHaveBeenCalledWith(null);
    expect(observations.status).not.toHaveBeenCalled();
    expect(observations.remoteStatus).not.toHaveBeenCalled();
    expect(observations.listRefs).not.toHaveBeenCalled();
  });
});
