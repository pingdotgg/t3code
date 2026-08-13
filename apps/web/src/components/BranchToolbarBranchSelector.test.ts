import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveBranchPickerRefTarget,
  resolveWorktreeBaseBranchCandidate,
  resolveWorktreeBaseBranchLifecycle,
  type ImplicitWorktreeBaseBranch,
} from "./BranchToolbarBranchSelector";

const environmentId = EnvironmentId.make("env-1");

describe("resolveBranchPickerRefTarget", () => {
  it("releases the ref-list target while the picker is closed", () => {
    expect(
      resolveBranchPickerRefTarget({
        isOpen: false,
        environmentId,
        cwd: "/repo",
        query: "feature",
      }),
    ).toEqual({ environmentId: null, cwd: null, query: null });
  });

  it("retains the exact ref-list target while the picker is open", () => {
    expect(
      resolveBranchPickerRefTarget({
        isOpen: true,
        environmentId,
        cwd: "/repo",
        query: "feature",
      }),
    ).toEqual({ environmentId, cwd: "/repo", query: "feature" });
  });
});

describe("resolveWorktreeBaseBranchCandidate", () => {
  it("uses local status while the ref picker is closed", () => {
    expect(
      resolveWorktreeBaseBranchCandidate({
        isOpen: false,
        isInitialLoadPending: false,
        defaultBranchName: "main",
        currentGitBranch: "feature/current",
      }),
    ).toBe("feature/current");
  });

  it("prefers the listed default ref after the picker loads", () => {
    expect(
      resolveWorktreeBaseBranchCandidate({
        isOpen: true,
        isInitialLoadPending: false,
        defaultBranchName: "main",
        currentGitBranch: "feature/current",
      }),
    ).toBe("main");
  });
});

describe("resolveWorktreeBaseBranchLifecycle", () => {
  it("upgrades only an untouched implicit fallback when the preferred ref loads", () => {
    const scopeKey = JSON.stringify([environmentId, "/repo"]);
    let activeThreadBranch: string | null = null;
    let implicitBranch: ImplicitWorktreeBaseBranch | null = null;
    const phases = [
      {
        name: "closed",
        candidate: "feature/current",
        preferredBranch: null,
        expectedBranch: "feature/current",
      },
      {
        name: "open loading",
        candidate: null,
        preferredBranch: null,
        expectedBranch: "feature/current",
      },
      {
        name: "open loaded",
        candidate: "main",
        preferredBranch: "main",
        expectedBranch: "main",
      },
      {
        name: "closed again",
        candidate: "feature/current",
        preferredBranch: null,
        expectedBranch: "main",
      },
    ] as const;

    for (const phase of phases) {
      const resolution = resolveWorktreeBaseBranchLifecycle({
        enabled: true,
        scopeKey,
        activeThreadBranch,
        candidate: phase.candidate,
        preferredBranch: phase.preferredBranch,
        implicitBranch,
      });
      implicitBranch = resolution.implicitBranch;
      activeThreadBranch = resolution.branchToSet ?? activeThreadBranch;
      expect(activeThreadBranch, phase.name).toBe(phase.expectedBranch);
    }
  });

  it("does not replace an explicit selection with a later preferred ref", () => {
    const scopeKey = JSON.stringify([environmentId, "/repo"]);
    const resolution = resolveWorktreeBaseBranchLifecycle({
      enabled: true,
      scopeKey,
      activeThreadBranch: "feature/current",
      candidate: "main",
      preferredBranch: "main",
      implicitBranch: null,
    });

    expect(resolution).toEqual({ branchToSet: null, implicitBranch: null });
  });
});
