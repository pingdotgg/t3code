import type { ReplayFixture, ReplayInteraction } from "../types.ts";

function gitFailure(stderr: string, code = 128): {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
} {
  return {
    code,
    stderr,
    stdout: "",
  };
}

function gitSuccess(stdout = "", stderr = ""): {
  readonly code: 0;
  readonly stderr: string;
  readonly stdout: string;
} {
  return {
    code: 0,
    stderr,
    stdout,
  };
}

export function createBaseWebAppInteractions(): ReadonlyArray<ReplayInteraction> {
  return [
    {
      name: "git status upstream",
      service: "git.execute",
      match: {
        operation: "GitCore.resolveCurrentUpstream",
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        cwd: { $ref: "state.cwd" },
      },
      result: {
        code: 128,
        stdout: "@{upstream}\n",
        stderr: "fatal: no upstream configured for branch 'main'\n",
      },
    },
    {
      name: "git status porcelain",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.status",
        args: ["status", "--porcelain=2", "--branch"],
        cwd: { $ref: "state.cwd" },
      },
      result: {
        code: 0,
        stdout: "# branch.oid 0123456789abcdef0123456789abcdef01234567\n# branch.head main\n",
        stderr: "",
      },
    },
    {
      name: "git unstaged numstat",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.unstagedNumstat",
        args: ["diff", "--numstat"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess(),
    },
    {
      name: "git staged numstat",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.stagedNumstat",
        args: ["diff", "--cached", "--numstat"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess(),
    },
    {
      name: "github latest pr lookup",
      service: "github.execute",
      match: {
        args: [
          "pr",
          "list",
          "--head",
          "main",
          "--state",
          "all",
          "--limit",
          "20",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
        ],
        cwd: { $ref: "state.cwd" },
      },
      result: {
        stdout: "[]\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    },
    {
      name: "git branch recency",
      service: "git.execute",
      match: {
        operation: "GitCore.readBranchRecency",
        args: [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess("main\t1741608000\norigin/main\t1741608000\n"),
    },
    {
      name: "git local branches",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.branchNoColor",
        args: ["branch", "--no-color"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess("* main\n"),
    },
    {
      name: "git remote branches",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteBranches",
        args: ["branch", "--no-color", "--remotes"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess(),
    },
    {
      name: "git remote names",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteNames",
        args: ["remote"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess("origin\n"),
    },
    {
      name: "git default ref",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.defaultRef",
        args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess("refs/remotes/origin/main\n"),
    },
    {
      name: "git worktree list",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.worktreeList",
        args: ["worktree", "list", "--porcelain"],
        cwd: { $ref: "state.cwd" },
      },
      result: gitSuccess(),
    },
    {
      name: "codex version check",
      service: "codex.versionCheck",
      match: { binaryPath: "codex" },
      result: { status: 0, stdout: "codex-cli 0.37.0\n", stderr: "" },
    },
    {
      name: "codex initialize",
      service: "codex.request",
      match: { method: "initialize" },
      result: {},
    },
    {
      name: "codex model list",
      service: "codex.request",
      match: { method: "model/list" },
      result: { models: [] },
    },
    {
      name: "codex account read",
      service: "codex.request",
      match: { method: "account/read" },
      result: { account: { type: "apiKey" } },
    },
    {
      name: "codex thread start",
      service: "codex.request",
      match: { method: "thread/start" },
      result: { thread: { id: { $ref: "state.providerThreadId" } } },
    },
  ];
}

export function createBaseWebAppFixture(): ReplayFixture {
  return {
    version: 1,
    state: {
      providerThreadId: "fixture-provider-thread",
      providerTurnId: "fixture-provider-turn-1",
      turnIndex: 0,
    },
    providerStatuses: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: "2026-03-10T12:00:00.000Z",
      },
    ],
    interactions: [...createBaseWebAppInteractions()],
  };
}

export function createTurnInteraction(
  index: 1 | 2,
  prompt: string,
  answer: string,
): ReplayInteraction {
  return {
    name: `codex turn start ${index}`,
    service: "codex.request",
    match: {
      method: "turn/start",
      params: {
        threadId: { $ref: "state.providerThreadId" },
        input: [{ type: "text", text: prompt }],
      },
    },
    whenState: {
      turnIndex: index - 1,
    },
    setState: {
      turnIndex: index,
      providerTurnId: `fixture-provider-turn-${index}`,
    },
    result: {
      turn: {
        id: { $ref: "state.providerTurnId" },
      },
    },
    notifications: [
      {
        method: "turn/started",
        params: {
          turn: {
            id: { $ref: "state.providerTurnId" },
          },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          turnId: { $ref: "state.providerTurnId" },
          delta: answer,
        },
      },
      {
        method: "turn/completed",
        params: {
          turn: {
            id: { $ref: "state.providerTurnId" },
            status: "completed",
          },
        },
      },
    ],
  };
}

interface CheckpointReplayOptions {
  readonly cwdRef?: string;
}

function checkpointCwd(cwdRef: string): { readonly $ref: string } {
  return { $ref: cwdRef };
}

export function createCheckpointReplayState(options?: {
  readonly includeDiffPanelQuery?: boolean;
  readonly includeSecondTurn?: boolean;
}): Record<string, unknown> {
  return {
    baselineCaptured: false,
    turn1Captured: false,
    ...(options?.includeSecondTurn ? { turn2Captured: false } : {}),
    capturePhase: 0,
    checkpointSummaryPhase: 0,
    ...(options?.includeDiffPanelQuery ? { checkpointDiffPhase: 0 } : {}),
  };
}

export function createSimpleDiffPatch(
  filePath: string,
  fromLine: string,
  toLine: string,
): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1 +1 @@",
    `-${fromLine}`,
    `+${toLine}`,
    "",
  ].join("\n");
}

export function createCheckpointSummaryInteractions(
  diffPatch: string,
  options?: CheckpointReplayOptions,
): ReadonlyArray<ReplayInteraction> {
  const cwdRef = options?.cwdRef ?? "state.cwd";

  return [
    {
      name: "checkpoint turn 0 missing before baseline capture",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: false,
      },
      result: gitFailure("fatal: Needed a single revision\n", 1),
    },
    {
      name: "checkpoint baseline has head",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.hasHeadCommit",
        cwd: checkpointCwd(cwdRef),
        args: ["rev-parse", "--verify", "HEAD"],
      },
      whenState: {
        baselineCaptured: false,
      },
      result: gitSuccess("0123456789abcdef0123456789abcdef01234567\n"),
    },
    {
      name: "checkpoint baseline read tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["read-tree", "HEAD"],
      },
      whenState: {
        baselineCaptured: false,
        capturePhase: 0,
      },
      setState: {
        capturePhase: 1,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint baseline add",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["add", "-A", "--", "."],
      },
      whenState: {
        baselineCaptured: false,
        capturePhase: 1,
      },
      setState: {
        capturePhase: 2,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint baseline write tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["write-tree"],
      },
      whenState: {
        baselineCaptured: false,
        capturePhase: 2,
      },
      setState: {
        capturePhase: 3,
      },
      result: gitSuccess("baseline-tree-oid\n"),
    },
    {
      name: "checkpoint baseline commit tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: false,
        capturePhase: 3,
      },
      setState: {
        capturePhase: 4,
      },
      result: gitSuccess("baseline-commit-oid\n"),
    },
    {
      name: "checkpoint baseline update ref",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: false,
        capturePhase: 4,
      },
      setState: {
        baselineCaptured: true,
        capturePhase: 5,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint baseline ref resolves before turn diff capture",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
      },
      result: gitSuccess("baseline-commit-oid\n"),
    },
    {
      name: "checkpoint turn 1 has head",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.hasHeadCommit",
        cwd: checkpointCwd(cwdRef),
        args: ["rev-parse", "--verify", "HEAD"],
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
      },
      result: gitSuccess("0123456789abcdef0123456789abcdef01234567\n"),
    },
    {
      name: "checkpoint turn 1 read tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["read-tree", "HEAD"],
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
        capturePhase: 5,
      },
      setState: {
        capturePhase: 6,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 1 add",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["add", "-A", "--", "."],
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
        capturePhase: 6,
      },
      setState: {
        capturePhase: 7,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 1 write tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["write-tree"],
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
        capturePhase: 7,
      },
      setState: {
        capturePhase: 8,
      },
      result: gitSuccess("turn-1-tree-oid\n"),
    },
    {
      name: "checkpoint turn 1 commit tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
        capturePhase: 8,
      },
      setState: {
        capturePhase: 9,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint turn 1 update ref",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        baselineCaptured: true,
        turn1Captured: false,
        capturePhase: 9,
      },
      setState: {
        turn1Captured: true,
        checkpointSummaryPhase: 0,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 0 resolves for summary diff",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 0,
        turn1Captured: true,
      },
      setState: {
        checkpointSummaryPhase: 1,
      },
      result: gitSuccess("baseline-commit-oid\n"),
    },
    {
      name: "checkpoint turn 1 resolves for summary diff",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 1,
        turn1Captured: true,
      },
      setState: {
        checkpointSummaryPhase: 2,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint patch for timeline summary",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.diffCheckpoints",
        cwd: checkpointCwd(cwdRef),
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "baseline-commit-oid",
          "turn-1-commit-oid",
        ],
      },
      whenState: {
        checkpointSummaryPhase: 2,
      },
      setState: {
        checkpointSummaryPhase: 3,
      },
      result: gitSuccess(diffPatch),
    },
  ];
}

export function createCheckpointDiffPanelInteractions(
  diffPatch: string,
  options?: CheckpointReplayOptions,
): ReadonlyArray<ReplayInteraction> {
  const cwdRef = options?.cwdRef ?? "state.cwd";

  return [
    {
      name: "checkpoint turn 0 exists for diff panel query",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 3,
        checkpointDiffPhase: 0,
      },
      setState: {
        checkpointDiffPhase: 1,
      },
      result: gitSuccess("baseline-commit-oid\n"),
    },
    {
      name: "checkpoint turn 1 exists for diff panel query",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 3,
        checkpointDiffPhase: 1,
      },
      setState: {
        checkpointDiffPhase: 2,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint turn 0 resolves for diff panel patch",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 3,
        checkpointDiffPhase: 2,
      },
      setState: {
        checkpointDiffPhase: 3,
      },
      result: gitSuccess("baseline-commit-oid\n"),
    },
    {
      name: "checkpoint turn 1 resolves for diff panel patch",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 3,
        checkpointDiffPhase: 3,
      },
      setState: {
        checkpointDiffPhase: 4,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint patch for diff panel",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.diffCheckpoints",
        cwd: checkpointCwd(cwdRef),
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "baseline-commit-oid",
          "turn-1-commit-oid",
        ],
      },
      whenState: {
        checkpointSummaryPhase: 3,
        checkpointDiffPhase: 4,
      },
      setState: {
        checkpointDiffPhase: 5,
      },
      result: gitSuccess(diffPatch),
    },
  ];
}

export function createCheckpointDiffInteractions(
  diffPatch: string,
  options?: CheckpointReplayOptions,
): ReadonlyArray<ReplayInteraction> {
  return [
    ...createCheckpointSummaryInteractions(diffPatch, options),
    ...createCheckpointDiffPanelInteractions(diffPatch, options),
  ];
}

export function createTwoTurnCheckpointSummaryInteractions(
  firstDiffPatch: string,
  secondDiffPatch: string,
  options?: CheckpointReplayOptions,
): ReadonlyArray<ReplayInteraction> {
  const cwdRef = options?.cwdRef ?? "state.cwd";

  return [
    ...createCheckpointSummaryInteractions(firstDiffPatch, options),
    {
      name: "checkpoint turn 1 resolves before turn 2 capture",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 3,
        turn1Captured: true,
        turn2Captured: false,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint turn 2 has head",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.hasHeadCommit",
        cwd: checkpointCwd(cwdRef),
        args: ["rev-parse", "--verify", "HEAD"],
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
      },
      result: gitSuccess("0123456789abcdef0123456789abcdef01234567\n"),
    },
    {
      name: "checkpoint turn 2 read tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["read-tree", "HEAD"],
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
        capturePhase: 9,
      },
      setState: {
        capturePhase: 10,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 2 add",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["add", "-A", "--", "."],
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
        capturePhase: 10,
      },
      setState: {
        capturePhase: 11,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 2 write tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
        args: ["write-tree"],
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
        capturePhase: 11,
      },
      setState: {
        capturePhase: 12,
      },
      result: gitSuccess("turn-2-tree-oid\n"),
    },
    {
      name: "checkpoint turn 2 commit tree",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
        capturePhase: 12,
      },
      setState: {
        capturePhase: 13,
      },
      result: gitSuccess("turn-2-commit-oid\n"),
    },
    {
      name: "checkpoint turn 2 update ref",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.captureCheckpoint",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        turn1Captured: true,
        turn2Captured: false,
        capturePhase: 13,
      },
      setState: {
        turn2Captured: true,
        capturePhase: 14,
        checkpointSummaryPhase: 4,
      },
      result: gitSuccess(),
    },
    {
      name: "checkpoint turn 1 resolves for turn 2 summary diff",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 4,
        turn2Captured: true,
      },
      setState: {
        checkpointSummaryPhase: 5,
      },
      result: gitSuccess("turn-1-commit-oid\n"),
    },
    {
      name: "checkpoint turn 2 resolves for summary diff",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd: checkpointCwd(cwdRef),
      },
      whenState: {
        checkpointSummaryPhase: 5,
        turn2Captured: true,
      },
      setState: {
        checkpointSummaryPhase: 6,
      },
      result: gitSuccess("turn-2-commit-oid\n"),
    },
    {
      name: "checkpoint patch for turn 2 timeline summary",
      service: "git.execute",
      match: {
        operation: "CheckpointStore.diffCheckpoints",
        cwd: checkpointCwd(cwdRef),
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "turn-1-commit-oid",
          "turn-2-commit-oid",
        ],
      },
      whenState: {
        checkpointSummaryPhase: 6,
        turn2Captured: true,
      },
      setState: {
        checkpointSummaryPhase: 7,
      },
      result: gitSuccess(secondDiffPatch),
    },
  ];
}

export function createWorktreeInteractions(): ReadonlyArray<ReplayInteraction> {
  return [
    {
      name: "git create worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.createWorktree",
        cwd: { $ref: "state.cwd" },
      },
      capture: {
        worktreeBranch: "request.args.3",
        worktreePath: "request.args.4",
      },
      setState: {
        worktreeReady: true,
      },
      result: gitSuccess(),
    },
    {
      name: "git status upstream in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.resolveCurrentUpstream",
        cwd: { $ref: "state.worktreePath" },
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitFailure("fatal: no upstream configured for branch 'main'\n"),
    },
    {
      name: "git status porcelain in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.status",
        cwd: { $ref: "state.worktreePath" },
        args: ["status", "--porcelain=2", "--branch"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess(
        "# branch.oid 89abcdef0123456789abcdef0123456789abcdef\n# branch.head main\n",
      ),
    },
    {
      name: "git unstaged numstat in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.unstagedNumstat",
        cwd: { $ref: "state.worktreePath" },
        args: ["diff", "--numstat"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess(),
    },
    {
      name: "git staged numstat in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.stagedNumstat",
        cwd: { $ref: "state.worktreePath" },
        args: ["diff", "--cached", "--numstat"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess(),
    },
    {
      name: "git branch recency in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.readBranchRecency",
        cwd: { $ref: "state.worktreePath" },
        args: [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess("main\t1741608000\norigin/main\t1741608000\n"),
    },
    {
      name: "git local branches in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.branchNoColor",
        cwd: { $ref: "state.worktreePath" },
        args: ["branch", "--no-color"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess("* main\n"),
    },
    {
      name: "git remote branches in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteBranches",
        cwd: { $ref: "state.worktreePath" },
        args: ["branch", "--no-color", "--remotes"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess(),
    },
    {
      name: "git remote names in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteNames",
        cwd: { $ref: "state.worktreePath" },
        args: ["remote"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess("origin\n"),
    },
    {
      name: "git default ref in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.defaultRef",
        cwd: { $ref: "state.worktreePath" },
        args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess("refs/remotes/origin/main\n"),
    },
    {
      name: "git worktree list in worktree",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.worktreeList",
        cwd: { $ref: "state.worktreePath" },
        args: ["worktree", "list", "--porcelain"],
      },
      whenState: {
        worktreeReady: true,
      },
      result: gitSuccess(),
    },
    {
      name: "git branch exists in worktree rename flow",
      service: "git.execute",
      match: {
        operation: "GitCore.branchExists",
        cwd: { $ref: "state.worktreePath" },
      },
      result: {
        code: 1,
        stdout: "",
        stderr: "",
      },
    },
    {
      name: "git rename worktree branch",
      service: "git.execute",
      match: {
        operation: "GitCore.renameBranch",
        cwd: { $ref: "state.worktreePath" },
      },
      capture: {
        worktreeBranch: "request.args.4",
      },
      result: gitSuccess(),
    },
  ];
}
