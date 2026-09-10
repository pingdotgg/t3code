// @effect-diagnostics nodeBuiltinImport:off - the remote-safety test creates a real local Git remote.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentDashboardRepositoryPolicy,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  inspectWorktreeRemoteSafety,
  selectInactiveWorktreeCandidates,
} from "./AgentDashboardInactiveWorktreeCleanup.ts";

const project = {
  id: ProjectId.make("project-1"),
  title: "Acme app",
  workspaceRoot: "/work/acme",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
} satisfies OrchestrationProjectShell;

const thread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: project.id,
  title: "Finished work",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-luna",
    options: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/finished",
  worktreePath: "/work/acme/.t3/worktrees/finished",
  latestTurn: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: "2026-07-03T00:00:00.000Z",
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  pullRequests: [],
  backgroundLiveness: null,
  ...overrides,
});

const policy = (
  enabledAutomations: AgentDashboardRepositoryPolicy["enabledAutomations"],
): AgentDashboardRepositoryPolicy => ({
  repository: { projectId: project.id },
  enabled: true,
  ...(enabledAutomations === undefined ? {} : { enabledAutomations }),
  cadenceMinutes: 120,
  priority: 0,
  riskTier: "low",
  branch: null,
  owner: null,
  enabledChecks: ["repository-review"],
  model: null,
  budgetMinutes: null,
  maxConcurrentRuns: 1,
  exclusions: [],
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("inactive worktree candidate selection", () => {
  const snapshot = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
    ({
      snapshotSequence: 1,
      projects: [project],
      threads,
      updatedAt: "2026-08-10T00:00:00.000Z",
    }) satisfies OrchestrationShellSnapshot;

  it("selects old settled worktrees when this automation type is enabled", () => {
    expect(
      selectInactiveWorktreeCandidates({
        snapshot: snapshot([thread()]),
        policies: [policy(["inactive-worktree-cleanup"])],
        cutoffMs: Date.parse("2026-08-01T00:00:00.000Z"),
      }).map((candidate) => candidate.path),
    ).toEqual(["/work/acme/.t3/worktrees/finished"]);
  });

  it("retains active, unsettled, recent, and project-disabled worktrees", () => {
    const candidates = [
      thread({ id: ThreadId.make("active"), latestTurn: { state: "running" } as never }),
      thread({ id: ThreadId.make("unsettled"), settledAt: null }),
      thread({ id: ThreadId.make("recent"), updatedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    expect(
      selectInactiveWorktreeCandidates({
        snapshot: snapshot(candidates),
        policies: [
          {
            ...policy(undefined),
            disabledAutomations: ["inactive-worktree-cleanup"],
          },
        ],
        cutoffMs: Date.parse("2026-08-01T00:00:00.000Z"),
      }),
    ).toEqual([]);
  });
});

describe("inactive worktree remote safety", () => {
  it("requires a clean worktree whose HEAD is present on its fetched upstream", async () => {
    const temporaryRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-worktree-cleanup-"),
    );
    const repositoryRoot = NodePath.join(temporaryRoot, "repository");
    const remoteRoot = NodePath.join(temporaryRoot, "remote.git");
    const worktreePath = NodePath.join(temporaryRoot, "worktree");
    const git = (cwd: string, args: ReadonlyArray<string>): void => {
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    };

    try {
      await NodeFSP.mkdir(repositoryRoot);
      git(temporaryRoot, ["init", "--bare", remoteRoot]);
      git(repositoryRoot, ["init", "-b", "main"]);
      await NodeFSP.writeFile(NodePath.join(repositoryRoot, "README.md"), "saved\n");
      git(repositoryRoot, ["add", "README.md"]);
      git(repositoryRoot, [
        "-c",
        "user.name=T3 Tests",
        "-c",
        "user.email=t3@example.test",
        "commit",
        "-m",
        "Initial",
      ]);
      git(repositoryRoot, ["remote", "add", "origin", remoteRoot]);
      git(repositoryRoot, ["push", "-u", "origin", "main"]);
      git(repositoryRoot, ["worktree", "add", "-b", "feature/saved", worktreePath]);
      git(worktreePath, ["push", "-u", "origin", "feature/saved"]);

      expect(await inspectWorktreeRemoteSafety({ repositoryRoot, worktreePath })).toMatchObject({
        registered: true,
        clean: true,
        branch: "feature/saved",
        remoteName: "origin",
        upstream: "origin/feature/saved",
        headSavedOnRemote: true,
      });

      await NodeFSP.writeFile(NodePath.join(worktreePath, "local.txt"), "not saved\n");
      expect(await inspectWorktreeRemoteSafety({ repositoryRoot, worktreePath })).toMatchObject({
        clean: false,
      });
      await NodeFSP.unlink(NodePath.join(worktreePath, "local.txt"));

      await NodeFSP.writeFile(NodePath.join(worktreePath, "README.md"), "new local commit\n");
      git(worktreePath, ["add", "README.md"]);
      git(worktreePath, [
        "-c",
        "user.name=T3 Tests",
        "-c",
        "user.email=t3@example.test",
        "commit",
        "-m",
        "Local only",
      ]);
      expect(await inspectWorktreeRemoteSafety({ repositoryRoot, worktreePath })).toMatchObject({
        clean: true,
        headSavedOnRemote: false,
      });
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
