import type { Fixture, Interaction } from "./harness.ts";

function baseGitInteractions(): ReadonlyArray<Interaction> {
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
      result: { code: 0, stdout: "", stderr: "" },
    },
    {
      name: "git staged numstat",
      service: "git.execute",
      match: {
        operation: "GitCore.statusDetails.stagedNumstat",
        args: ["diff", "--cached", "--numstat"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "", stderr: "" },
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
      result: { code: 0, stdout: "main\t1741608000\norigin/main\t1741608000\n", stderr: "" },
    },
    {
      name: "git local branches",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.branchNoColor",
        args: ["branch", "--no-color"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "* main\n", stderr: "" },
    },
    {
      name: "git remote branches",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteBranches",
        args: ["branch", "--no-color", "--remotes"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "", stderr: "" },
    },
    {
      name: "git remote names",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.remoteNames",
        args: ["remote"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "origin\n", stderr: "" },
    },
    {
      name: "git default ref",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.defaultRef",
        args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" },
    },
    {
      name: "git worktree list",
      service: "git.execute",
      match: {
        operation: "GitCore.listBranches.worktreeList",
        args: ["worktree", "list", "--porcelain"],
        cwd: { $ref: "state.cwd" },
      },
      result: { code: 0, stdout: "", stderr: "" },
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

function turnInteraction(index: 1 | 2, prompt: string, answer: string): Interaction {
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

function makeBaseFixture(): Fixture {
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
    interactions: [...baseGitInteractions()],
  };
}

const bootstrap = makeBaseFixture();

const happyPath = {
  ...makeBaseFixture(),
  interactions: [
    ...makeBaseFixture().interactions,
    turnInteraction(
      1,
      "Explain how this harness works.",
      "Harness response for the first message.\n",
    ),
  ],
} satisfies Fixture;

const twoTurns = {
  ...makeBaseFixture(),
  interactions: [
    ...makeBaseFixture().interactions,
    turnInteraction(1, "First question", "First assistant reply.\n"),
    turnInteraction(2, "Second question", "Second assistant reply.\n"),
  ],
} satisfies Fixture;

const providerOffline = {
  ...makeBaseFixture(),
  providerStatuses: [
    {
      provider: "codex",
      status: "error",
      available: false,
      authStatus: "unauthenticated",
      checkedAt: "2026-03-10T12:00:00.000Z",
    },
  ],
} satisfies Fixture;

const fixtures: Record<string, Fixture> = {
  bootstrap,
  happyPath,
  twoTurns,
  providerOffline,
};

export default fixtures;
