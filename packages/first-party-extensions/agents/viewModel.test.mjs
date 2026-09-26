import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  DEFAULT_APPROVAL_OPTIONS,
  DEFERRED_SECTIONS,
  EMPTY_AGENTS_FEED,
  HOST_CHROME_NOTE,
  SCRIPTS_SCOPE_NOTE,
  SCRIPT_RUN_MAX_CANDIDATES,
  T3_PROJECT_FILE_MAX_SCRIPTS,
  agentActivityText,
  agentStatusLabel,
  agentsFooterSummary,
  applyAgentsEvent,
  applyDiffStreamEvent,
  approvalOptions,
  buildUserInputAnswers,
  checkpointLabel,
  claimableTerminal,
  collectDiffStream,
  countAnsweredQuestions,
  createDiffAssembly,
  deriveAgentsPanelModel,
  describeReceipt,
  describeScriptRun,
  elapsedBetween,
  formatAgentModelLabel,
  formatAgentTokenCount,
  formatElapsedSeconds,
  isActiveAgentStatus,
  isTerminalAgentStatus,
  operationSupport,
  parseT3ProjectFile,
  resolveQuestionAnswer,
  runWorkspaceScript,
  scriptRunNonce,
  scriptRuntimeEnv,
  scriptSlug,
  scriptTerminalBaseId,
  scriptTerminalCandidates,
  scriptWriteData,
  setQuestionCustomAnswer,
  terminalBusy,
  themeVarOverrides,
  trackThemeVars,
  toggleQuestionOption,
  userInputOptionValue,
  workspaceFromRevision,
} from "./viewModel.ts";

NodeTest.describe("parseT3ProjectFile", () => {
  NodeTest.it("parses checked-in scripts into runnable entries", () => {
    const result = parseT3ProjectFile(
      JSON.stringify({
        $schema: "https://t3.codes/schema/t3.json",
        scripts: [
          { name: "  Dev Server  ", command: " vp run dev ", icon: "play" },
          {
            name: "Setup Worktree",
            command: "vp i",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
          { name: "Preview", command: "vp run build", previewUrl: "http://localhost:5173" },
        ],
      }),
    );
    NodeAssert.equal(result.kind, "ready");
    NodeAssert.deepEqual(result.scripts, [
      {
        name: "Dev Server",
        command: "vp run dev",
        icon: "play",
        runOnWorktreeCreate: false,
        previewUrl: null,
      },
      {
        name: "Setup Worktree",
        command: "vp i",
        icon: "configure",
        runOnWorktreeCreate: true,
        previewUrl: null,
      },
      {
        name: "Preview",
        command: "vp run build",
        icon: null,
        runOnWorktreeCreate: false,
        previewUrl: "http://localhost:5173",
      },
    ]);
  });

  NodeTest.it("treats a file with no scripts key as empty, not invalid", () => {
    NodeAssert.deepEqual(parseT3ProjectFile("{}"), { kind: "empty" });
    NodeAssert.deepEqual(parseT3ProjectFile('{"scripts": []}'), { kind: "empty" });
  });

  NodeTest.it("names invalid files instead of treating them as absent", () => {
    NodeAssert.equal(parseT3ProjectFile("not json").kind, "invalid");
    NodeAssert.equal(parseT3ProjectFile('{"scripts": "build"}').kind, "invalid");
    NodeAssert.equal(parseT3ProjectFile('{"scripts": [{"name": "x"}]}').kind, "invalid");
    NodeAssert.equal(
      parseT3ProjectFile('{"scripts": [{"name": "x", "command": "y", "icon": "fire"}]}').kind,
      "invalid",
    );
    NodeAssert.equal(
      parseT3ProjectFile(
        '{"scripts": [{"name": "x", "command": "y", "runOnWorktreeCreate": "yes"}]}',
      ).kind,
      "invalid",
    );
  });

  NodeTest.it("rejects scripts arrays over the native cap", () => {
    const scripts = Array.from({ length: T3_PROJECT_FILE_MAX_SCRIPTS + 1 }, (_, i) => ({
      name: `s${i}`,
      command: "true",
    }));
    const result = parseT3ProjectFile(JSON.stringify({ scripts }));
    NodeAssert.equal(result.kind, "invalid");
  });
});

NodeTest.describe("workspaceFromRevision", () => {
  NodeTest.it("parses the public extensionWorkspaceRevision payload", () => {
    NodeAssert.deepEqual(workspaceFromRevision('["/repo", null]'), {
      cwd: "/repo",
      workspaceRoot: "/repo",
      worktreePath: null,
    });
    NodeAssert.deepEqual(workspaceFromRevision('["/repo", "/repo/.worktrees/t1"]'), {
      cwd: "/repo/.worktrees/t1",
      workspaceRoot: "/repo",
      worktreePath: "/repo/.worktrees/t1",
    });
  });

  NodeTest.it("rejects absent or malformed revisions", () => {
    NodeAssert.equal(workspaceFromRevision(undefined), null);
    NodeAssert.equal(workspaceFromRevision("not json"), null);
    NodeAssert.equal(workspaceFromRevision('["/repo"]'), null);
    NodeAssert.equal(workspaceFromRevision('["", null]'), null);
    NodeAssert.equal(workspaceFromRevision('{"root": "/repo"}'), null);
  });
});

NodeTest.describe("scriptRuntimeEnv", () => {
  NodeTest.it("carries the native T3CODE_* runtime variables", () => {
    const env = scriptRuntimeEnv({
      cwd: "/repo/.worktrees/t1",
      workspaceRoot: "/repo",
      worktreePath: "/repo/.worktrees/t1",
    });
    NodeAssert.equal(env.T3CODE_PROJECT_ROOT, "/repo");
    NodeAssert.equal(env.T3CODE_WORKTREE_PATH, "/repo/.worktrees/t1");
  });

  NodeTest.it("omits the worktree variable for root checkouts", () => {
    const env = scriptRuntimeEnv({ cwd: "/repo", workspaceRoot: "/repo", worktreePath: null });
    NodeAssert.equal(env.T3CODE_PROJECT_ROOT, "/repo");
    NodeAssert.equal("T3CODE_WORKTREE_PATH" in env, false);
  });
});

NodeTest.describe("script terminal ids", () => {
  NodeTest.it("normalizes script names like the native script-id rule", () => {
    NodeAssert.equal(scriptSlug("Dev Server"), "dev-server");
    NodeAssert.equal(scriptSlug("  Build & Test!! "), "build-test");
    NodeAssert.equal(scriptSlug("!!!"), "script");
    NodeAssert.equal(scriptSlug("a".repeat(80)).length <= 24, true);
  });

  NodeTest.it("normalizes script names into the dedicated terminal prefix", () => {
    NodeAssert.equal(scriptTerminalBaseId({ name: "Dev Server" }), "t3-agents-dev-server");
    NodeAssert.equal(scriptTerminalBaseId({ name: "!!!" }), "t3-agents-script");
    NodeAssert.equal(scriptTerminalBaseId({ name: "a".repeat(80) }).length <= 128, true);
  });

  NodeTest.it("overflow ids carry the mount nonce so recreated panels never re-pick them", () => {
    const candidates = scriptTerminalCandidates("t3-agents-dev", "n1");
    NodeAssert.deepEqual(candidates, [
      "t3-agents-dev",
      "t3-agents-dev-n1-2",
      "t3-agents-dev-n1-3",
      "t3-agents-dev-n1-4",
    ]);
    NodeAssert.equal(candidates.length, SCRIPT_RUN_MAX_CANDIDATES);
    const otherMount = scriptTerminalCandidates("t3-agents-dev", "n2");
    for (const id of otherMount.slice(1))
      NodeAssert.ok(!candidates.includes(id), `${id} disjoint across mounts`);
    NodeAssert.equal(scriptRunNonce() === scriptRunNonce(), false);
  });

  NodeTest.it("reads the busy half of the native allocation rule", () => {
    NodeAssert.equal(terminalBusy({ hasRunningSubprocess: true }), true);
    NodeAssert.equal(terminalBusy({ hasRunningSubprocess: false }), false);
    NodeAssert.equal(terminalBusy(null), false);
  });

  NodeTest.it("claims only the asked-for session when it is alive and not busy", () => {
    const id = "t3-agents-dev";
    const live = { terminalId: id, status: "running", hasRunningSubprocess: false };
    NodeAssert.equal(claimableTerminal(live, id), true);
    NodeAssert.equal(
      claimableTerminal({ terminalId: id, status: "starting", hasRunningSubprocess: false }, id),
      true,
    );
    NodeAssert.equal(
      claimableTerminal({ terminalId: id, status: "running", hasRunningSubprocess: true }, id),
      false,
    );
    NodeAssert.equal(
      claimableTerminal({ terminalId: id, status: "exited", hasRunningSubprocess: false }, id),
      false,
    );
    NodeAssert.equal(
      claimableTerminal(
        { terminalId: "t3-agents-other", status: "running", hasRunningSubprocess: false },
        id,
      ),
      false,
    );
    NodeAssert.equal(claimableTerminal(null, id), false);
  });
});

NodeTest.describe("script run state machine", () => {
  NodeTest.it("writes the command with the native carriage return", () => {
    NodeAssert.equal(scriptWriteData("vp run dev"), "vp run dev\r");
  });

  NodeTest.it("describes each stage and failure honestly", () => {
    NodeAssert.equal(
      describeScriptRun({ kind: "running", stage: "attach", terminalId: "t3-agents-dev" }),
      "Opening terminal t3-agents-dev…",
    );
    NodeAssert.match(
      describeScriptRun({ kind: "running", stage: "claim", terminalId: "t3-agents-dev-n1-2" }),
      /busy.*t3-agents-dev-n1-2/,
    );
    NodeAssert.match(
      describeScriptRun({ kind: "sent", terminalId: "t3-agents-dev", status: "running" }),
      /Sent to t3-agents-dev \(session running\)/,
    );
    NodeAssert.match(
      describeScriptRun({
        kind: "failed",
        stage: "write",
        terminalId: "t3-agents-dev",
        message: "denied",
      }),
      /writing the command.*denied/,
    );
  });
});

NodeTest.describe("runWorkspaceScript glue", () => {
  const workspace = { cwd: "/repo", workspaceRoot: "/repo", worktreePath: null };
  const script = {
    name: "Dev",
    command: "vp run dev",
    icon: null,
    runOnWorktreeCreate: false,
    previewUrl: null,
  };
  const meta = (terminalId, overrides = {}) => ({
    terminalId,
    status: "running",
    hasRunningSubprocess: false,
    ...overrides,
  });

  NodeTest.it("claims the dedicated terminal and writes the command", async () => {
    const calls = [];
    const control = {
      attach: async (input) => {
        calls.push({ method: "attach", input });
        return meta(input.terminalId);
      },
      write: async (input) => {
        calls.push({ method: "write", input });
        return {};
      },
    };
    const reports = [];
    const result = await runWorkspaceScript({
      control,
      script,
      workspace,
      nonce: "n1",
      report: (run) => reports.push(run),
    });
    NodeAssert.deepEqual(result, {
      kind: "sent",
      terminalId: "t3-agents-dev",
      status: "running",
    });
    NodeAssert.equal(calls.filter((c) => c.method === "attach").length, 1);
    NodeAssert.deepEqual(calls.at(-1), {
      method: "write",
      input: { terminalId: "t3-agents-dev", data: "vp run dev\r" },
    });
    NodeAssert.equal(calls[0].input.env.T3CODE_PROJECT_ROOT, "/repo");
  });

  NodeTest.it("overflows past a busy dedicated terminal to a nonce-keyed id", async () => {
    const writes = [];
    const control = {
      attach: async (input) =>
        meta(input.terminalId, {
          hasRunningSubprocess: input.terminalId === "t3-agents-dev",
        }),
      write: async (input) => {
        writes.push(input);
        return {};
      },
    };
    const result = await runWorkspaceScript({
      control,
      script,
      workspace,
      nonce: "n1",
      report: () => {},
    });
    NodeAssert.equal(result.kind, "sent");
    NodeAssert.equal(result.terminalId, "t3-agents-dev-n1-2");
    NodeAssert.deepEqual(writes, [{ terminalId: "t3-agents-dev-n1-2", data: "vp run dev\r" }]);
  });

  NodeTest.it(
    "never writes to a returned busy overflow terminal (recreated-panel collision)",
    async () => {
      // A previous panel mount left t3-agents-dev and the deterministic
      // overflow busy; the server returns those same running sessions for the
      // requested ids (attach is not create-exclusive). The run must skip
      // every busy session and write only to a confirmed-free candidate.
      const calls = [];
      const control = {
        attach: async (input) => {
          calls.push({ method: "attach", input });
          const preExisting = !input.terminalId.endsWith("-4");
          return meta(input.terminalId, { hasRunningSubprocess: preExisting });
        },
        write: async (input) => {
          calls.push({ method: "write", input });
          return {};
        },
      };
      const result = await runWorkspaceScript({
        control,
        script,
        workspace,
        nonce: "n1",
        report: () => {},
      });
      NodeAssert.equal(result.kind, "sent");
      NodeAssert.equal(result.terminalId, "t3-agents-dev-n1-4");
      const writes = calls.filter((c) => c.method === "write");
      NodeAssert.deepEqual(writes, [
        { method: "write", input: { terminalId: "t3-agents-dev-n1-4", data: "vp run dev\r" } },
      ]);
      for (const busy of ["t3-agents-dev", "t3-agents-dev-n1-2", "t3-agents-dev-n1-3"])
        NodeAssert.ok(
          writes.every((c) => c.input.terminalId !== busy),
          `no write to busy ${busy}`,
        );
    },
  );

  NodeTest.it("fails by name with zero writes when every candidate is busy", async () => {
    const writes = [];
    const control = {
      attach: async (input) => meta(input.terminalId, { hasRunningSubprocess: true }),
      write: async (input) => {
        writes.push(input);
        return {};
      },
    };
    const reports = [];
    const result = await runWorkspaceScript({
      control,
      script,
      workspace,
      nonce: "n1",
      report: (run) => reports.push(run),
    });
    NodeAssert.equal(result.kind, "failed");
    NodeAssert.equal(writes.length, 0);
    NodeAssert.match(result.message, /no claimable script terminal/);
    NodeAssert.match(result.message, /busy/);
  });

  NodeTest.it(
    "treats an attach rejection as a claim failure and tries the next candidate",
    async () => {
      const writes = [];
      const control = {
        attach: async (input) => {
          if (input.terminalId === "t3-agents-dev")
            throw new Error("Terminal session is unavailable in the requested workspace");
          return meta(input.terminalId);
        },
        write: async (input) => {
          writes.push(input);
          return {};
        },
      };
      const result = await runWorkspaceScript({
        control,
        script,
        workspace,
        nonce: "n1",
        report: () => {},
      });
      NodeAssert.equal(result.kind, "sent");
      NodeAssert.equal(result.terminalId, "t3-agents-dev-n1-2");
      NodeAssert.equal(writes.length, 1);
    },
  );
});

NodeTest.describe("deferred sections", () => {
  NodeTest.it("state a missing contract or client restriction for every named capability", () => {
    for (const section of DEFERRED_SECTIONS) {
      NodeAssert.ok(section.title.length > 0, "deferred section has a title");
      NodeAssert.match(
        section.blocker,
        /net-new design|contract|web\/desktop only/,
        `${section.title} names what it lacks`,
      );
    }
  });

  NodeTest.it("separates the scan/import section from the net-new sections", () => {
    const scan = DEFERRED_SECTIONS.find((section) => /scan\/import/.test(section.title));
    NodeAssert.ok(scan, "scan/import gets its own section");
    NodeAssert.match(scan.blocker, /provisioning scan exists/);
    NodeAssert.match(scan.blocker, /narrow public scan contract/);
    NodeAssert.doesNotMatch(scan.blocker, /no native .* binding exists/);
    const netNew = DEFERRED_SECTIONS.find((section) => /deep links/.test(section.title));
    NodeAssert.ok(netNew, "logs/deep links keep their own section");
    NodeAssert.match(netNew.blocker, /net-new design/);
  });

  NodeTest.it("name the scripts-list and host-chrome boundaries", () => {
    NodeAssert.match(SCRIPTS_SCOPE_NOTE, /settings/i);
    NodeAssert.match(HOST_CHROME_NOTE, /host chat UI/);
  });
});

// --- Live orchestration model -------------------------------------------------

const makeAgent = (overrides = {}) => ({
  id: "agent-1",
  kind: "subagent",
  title: "Explorer",
  role: null,
  model: "claude-sonnet-5",
  effort: "high",
  status: "running",
  activationCount: 1,
  usage: { totalTokens: 1200, toolUses: 3 },
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:10.000Z",
  completedAt: null,
  updatedAt: "2026-01-01T00:00:20.000Z",
  ...overrides,
});

const makeSnapshot = (overrides = {}) => ({
  kind: "snapshot",
  streamEpoch: "epoch-1",
  revision: 1,
  agents: [],
  pendingApprovals: [],
  pendingUserInputs: [],
  checkpoints: [],
  session: null,
  turn: null,
  receipts: [],
  retention: { agentsCap: 100, receiptsCap: 100 },
  ...overrides,
});

NodeTest.describe("status semantics", () => {
  NodeTest.it("collapses to the native visual buckets", () => {
    for (const status of ["pending", "running", "waiting"])
      NodeAssert.equal(isActiveAgentStatus(status), true);
    for (const status of ["completed", "failed", "cancelled", "interrupted"])
      NodeAssert.equal(isTerminalAgentStatus(status), true);
    NodeAssert.equal(isActiveAgentStatus("idle"), false);
    NodeAssert.equal(isTerminalAgentStatus("idle"), false);
    NodeAssert.equal(agentStatusLabel(makeAgent({ status: "running" })), "Working");
    NodeAssert.equal(agentStatusLabel(makeAgent({ status: "idle" })), "Idle · resumable");
    NodeAssert.equal(
      agentStatusLabel(makeAgent({ kind: "subagent_batch", status: "idle" })),
      "Idle",
    );
    NodeAssert.equal(agentStatusLabel(makeAgent({ status: "cancelled" })), "Stopped");
  });

  NodeTest.it("orders the activity line with the native precedence", () => {
    const base = { progress: "thinking", lastToolName: "Read", result: "done", error: "boom" };
    NodeAssert.equal(agentActivityText(makeAgent({ ...base, status: "running" })), "thinking");
    NodeAssert.equal(
      agentActivityText(makeAgent({ ...base, status: "running", progress: null })),
      "▸ Read",
    );
    NodeAssert.equal(
      agentActivityText(
        makeAgent({ ...base, status: "running", progress: null, lastToolName: null }),
      ),
      "done",
    );
    NodeAssert.equal(
      agentActivityText(
        makeAgent({
          ...base,
          status: "running",
          progress: null,
          lastToolName: null,
          result: null,
        }),
      ),
      "boom",
    );
    NodeAssert.equal(agentActivityText(makeAgent({ ...base, status: "failed" })), "boom");
    NodeAssert.equal(
      agentActivityText(makeAgent({ ...base, status: "completed", error: null })),
      "done",
    );
  });

  NodeTest.it("formats elapsed, model, and token chips like the native panel", () => {
    NodeAssert.equal(formatElapsedSeconds(45), "45s");
    NodeAssert.equal(formatElapsedSeconds(185), "3m 05s");
    NodeAssert.equal(formatElapsedSeconds(3900), "1h 05m");
    NodeAssert.equal(elapsedBetween("2026-01-01T00:00:00Z", "2026-01-01T00:01:05Z"), "1m 05s");
    NodeAssert.equal(elapsedBetween("not-a-date", null), "");
    NodeAssert.equal(formatAgentModelLabel("claude-sonnet-5", "high"), "sonnet-5 · high");
    NodeAssert.equal(formatAgentModelLabel("claude-opus-4-20250514", null), "opus-4");
    NodeAssert.equal(formatAgentModelLabel("gpt-6-astra-latest", null), "gpt-6-astra");
    NodeAssert.equal(formatAgentModelLabel(null, "high"), null);
    NodeAssert.equal(formatAgentTokenCount(999), "999");
    NodeAssert.equal(formatAgentTokenCount(1200), "1.2k");
    NodeAssert.equal(formatAgentTokenCount(120_000), "120k");
    NodeAssert.equal(formatAgentTokenCount(2_500_000), "2.5M");
  });
});

NodeTest.describe("deriveAgentsPanelModel", () => {
  NodeTest.it("returns the empty model for an empty roster", () => {
    const model = deriveAgentsPanelModel([]);
    NodeAssert.equal(model.hasAgents, false);
    NodeAssert.equal(model.liveCount, 0);
  });

  NodeTest.it("groups workflow members under phases and skips container counts", () => {
    const coordinator = makeAgent({
      id: "wf",
      kind: "workflow",
      title: "Ship it",
      status: "running",
      usage: { totalTokens: 999999 },
      phases: [
        { index: 0, title: "Plan" },
        { index: 1, title: "Build" },
      ],
    });
    const planner = makeAgent({
      id: "m1",
      parentAgentId: "wf",
      phaseIndex: 0,
      agentIndex: 0,
      status: "completed",
      usage: { totalTokens: 500 },
    });
    const builder = makeAgent({
      id: "m2",
      parentAgentId: "wf",
      phaseIndex: 1,
      agentIndex: 0,
      status: "running",
      usage: { totalTokens: 1500 },
    });
    const direct = makeAgent({ id: "d1", status: "idle", usage: { totalTokens: 100 } });
    const model = deriveAgentsPanelModel([coordinator, builder, planner, direct]);
    NodeAssert.equal(model.workflows.length, 1);
    NodeAssert.equal(model.workflows[0].phases.length, 2);
    NodeAssert.deepEqual(
      model.workflows[0].phases.map((phase) => phase.title),
      ["Plan", "Build"],
    );
    NodeAssert.equal(model.workflows[0].phases[0].state, "done");
    NodeAssert.equal(model.workflows[0].phases[1].state, "running");
    NodeAssert.equal(model.directAgents.length, 1);
    // Coordinator's inflated aggregate usage must not double-count.
    NodeAssert.equal(model.totalTokens, 2100);
    NodeAssert.equal(model.runningCount, 1);
    NodeAssert.equal(model.idleCount, 1);
    NodeAssert.equal(model.settledCount, 1);
    NodeAssert.equal(model.liveCount, 1);
  });

  NodeTest.it("counts an idle member as phase-live but roster-idle", () => {
    const coordinator = makeAgent({
      id: "wf",
      kind: "workflow",
      phases: [{ index: 0, title: "Work" }],
    });
    const member = makeAgent({
      id: "m1",
      parentAgentId: "wf",
      phaseIndex: 0,
      status: "idle",
    });
    const model = deriveAgentsPanelModel([coordinator, member]);
    NodeAssert.equal(model.workflows[0].phases[0].state, "running");
    NodeAssert.equal(model.idleCount, 1);
    NodeAssert.equal(model.liveCount, 0);
  });

  NodeTest.it("keeps orphan members and member-less coordinators visible", () => {
    const orphan = makeAgent({ id: "o1", parentAgentId: "gone", status: "completed" });
    const lone = makeAgent({ id: "wf", kind: "workflow", status: "completed" });
    const model = deriveAgentsPanelModel([orphan, lone]);
    NodeAssert.equal(model.workflows.length, 1);
    NodeAssert.deepEqual(model.directAgents.map((agent) => agent.id).sort(), ["o1"]);
    NodeAssert.equal(model.settledCount, 2);
  });

  NodeTest.it("keeps stable first-seen order for the direct list", () => {
    const late = makeAgent({ id: "b", firstSeenAt: "2026-01-01T00:00:02Z" });
    const early = makeAgent({ id: "a", firstSeenAt: "2026-01-01T00:00:01Z" });
    const model = deriveAgentsPanelModel([late, early]);
    NodeAssert.deepEqual(
      model.directAgents.map((agent) => agent.id),
      ["a", "b"],
    );
  });

  NodeTest.it("summarizes the footer like the native panel", () => {
    const model = deriveAgentsPanelModel([
      makeAgent({ id: "a", status: "running", usage: { totalTokens: 1500 } }),
      makeAgent({ id: "b", status: "idle", usage: null }),
      makeAgent({ id: "c", status: "completed", usage: null }),
    ]);
    NodeAssert.equal(agentsFooterSummary(model), "1 working · 1 idle · 1 settled · 1.5k tokens");
  });
});

NodeTest.describe("applyAgentsEvent", () => {
  NodeTest.it("adopts the snapshot projection", () => {
    const snapshot = makeSnapshot({ agents: [makeAgent()] });
    const feed = applyAgentsEvent(EMPTY_AGENTS_FEED, snapshot);
    NodeAssert.equal(feed.state?.agents.length, 1);
    NodeAssert.equal(feed.streamEpoch, "epoch-1");
    NodeAssert.equal(feed.revision, 1);
    NodeAssert.equal(feed.ended, null);
  });

  NodeTest.it("latest wins across epochs (adapter restart)", () => {
    let feed = applyAgentsEvent(EMPTY_AGENTS_FEED, makeSnapshot({ revision: 3 }));
    feed = applyAgentsEvent(feed, {
      ...makeSnapshot({ agents: [makeAgent(), makeAgent({ id: "agent-2" })] }),
      kind: "updated",
      streamEpoch: "epoch-2",
      revision: 1,
    });
    NodeAssert.equal(feed.streamEpoch, "epoch-2");
    NodeAssert.equal(feed.state?.agents.length, 2);
  });

  NodeTest.it("retains the last receipt and marks server close", () => {
    const receipt = { commandId: "c1", status: "accepted", sequence: 7, error: null };
    let feed = applyAgentsEvent(EMPTY_AGENTS_FEED, makeSnapshot());
    feed = applyAgentsEvent(feed, {
      kind: "receipt",
      streamEpoch: "epoch-1",
      revision: 2,
      receipt,
    });
    NodeAssert.equal(feed.lastReceipt, receipt);
    NodeAssert.equal(feed.state?.agents.length, 0);
    feed = applyAgentsEvent(feed, {
      kind: "closed",
      streamEpoch: "epoch-1",
      reason: "overflow",
    });
    NodeAssert.deepEqual(feed.ended, { reason: "overflow" });
  });
});

NodeTest.describe("operation gating and receipts", () => {
  const caps = {
    operations: {
      "turn.start": true,
      "turn.interrupt": false,
      "thread.settle": true,
    },
    streamEpoch: "epoch-1",
    revision: 4,
  };

  NodeTest.it("names unsupported operations instead of hiding the failure", () => {
    NodeAssert.deepEqual(operationSupport(caps, "turn.start"), { kind: "ready" });
    NodeAssert.deepEqual(operationSupport(caps, "turn.interrupt"), {
      kind: "unsupported",
      detail: "turn.interrupt is not supported by this provider",
    });
    NodeAssert.deepEqual(operationSupport(caps, "session.stop"), {
      kind: "unsupported",
      detail: "session.stop is not supported by this provider",
    });
    NodeAssert.deepEqual(operationSupport(null, "turn.start"), { kind: "unknown" });
  });

  NodeTest.it("describes receipts with their terminal status and sequence", () => {
    NodeAssert.equal(
      describeReceipt({ commandId: "c", status: "accepted", sequence: 3, error: null }),
      "accepted · seq 3",
    );
    NodeAssert.equal(
      describeReceipt({
        commandId: "c",
        status: "rejected",
        sequence: 4,
        error: "OrchestrationUnsupported: checkpoint.revert",
      }),
      "rejected — OrchestrationUnsupported: checkpoint.revert",
    );
  });
});

NodeTest.describe("pending approvals", () => {
  NodeTest.it("falls back to the native default options", () => {
    const approval = { requestId: "r1", requestKind: "command", createdAt: "t" };
    NodeAssert.deepEqual(approvalOptions(approval), DEFAULT_APPROVAL_OPTIONS);
    const custom = [{ decision: "accept", label: "Allow" }];
    NodeAssert.deepEqual(approvalOptions({ ...approval, options: custom }), custom);
  });
});

NodeTest.describe("pending user inputs", () => {
  const question = {
    id: "q1",
    header: "Pick",
    question: "Which?",
    options: [
      { label: "Alpha", description: "a", value: "alpha" },
      { label: "Beta", description: "b" },
    ],
  };

  NodeTest.it("uses option values over labels and requires every question", () => {
    NodeAssert.equal(userInputOptionValue(question.options[0]), "alpha");
    NodeAssert.equal(userInputOptionValue(question.options[1]), "Beta");
    const drafts = { q1: toggleQuestionOption(question, undefined, "alpha") };
    NodeAssert.deepEqual(buildUserInputAnswers([question], drafts), { q1: "alpha" });
    NodeAssert.equal(buildUserInputAnswers([question], {}), null);
    NodeAssert.equal(countAnsweredQuestions([question], drafts), 1);
  });

  NodeTest.it("multi-select answers stay arrays and toggle", () => {
    const multi = { ...question, multiSelect: true };
    let draft = toggleQuestionOption(multi, undefined, "alpha");
    draft = toggleQuestionOption(multi, draft, "Beta");
    NodeAssert.deepEqual(buildUserInputAnswers([multi], { q1: draft }), {
      q1: ["alpha", "Beta"],
    });
    draft = toggleQuestionOption(multi, draft, "alpha");
    NodeAssert.deepEqual(resolveQuestionAnswer(multi, draft), ["Beta"]);
  });

  NodeTest.it("custom answers win and clear the option pick", () => {
    let draft = toggleQuestionOption(question, undefined, "alpha");
    draft = setQuestionCustomAnswer(question, draft, "something else");
    NodeAssert.deepEqual(buildUserInputAnswers([question], { q1: draft }), {
      q1: "something else",
    });
    const locked = { ...question, allowCustomAnswer: false };
    NodeAssert.equal(
      resolveQuestionAnswer(locked, { customAnswer: "nope", selectedOptionValues: ["alpha"] }),
      "alpha",
    );
  });
});

NodeTest.describe("checkpoints", () => {
  NodeTest.it("labels a checkpoint with turn, file count, and delta", () => {
    NodeAssert.equal(
      checkpointLabel({
        turnId: "t1",
        checkpointTurnCount: 3,
        checkpointRef: "refs/t3/checkpoints/x",
        status: "ready",
        files: [
          { path: "a.ts", kind: "modified", additions: 4, deletions: 2 },
          { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
        ],
        assistantMessageId: null,
        completedAt: "t",
      }),
      "turn 3 · 2 files · +14 −2",
    );
  });
});

NodeTest.describe("verified diff reassembly", () => {
  const sha256 = async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const utf8 = (text) => new TextEncoder().encode(text).length;

  const buildFrames = async (bodies, splitAt = 3) => {
    const sources = [];
    const chunks = [];
    for (const [index, body] of bodies.entries()) {
      const parts = [];
      for (let start = 0; start < body.length; start += splitAt)
        parts.push(body.slice(start, start + splitAt));
      if (parts.length === 0) parts.push("");
      sources.push({
        id: `src-${index}`,
        kind: "working-tree",
        title: `Source ${index}`,
        baseRef: null,
        headRef: null,
        truncated: false,
        diffHash: await sha256(body),
        diffByteLength: utf8(body),
        chunkCount: parts.length,
      });
      parts.forEach((data, chunkIndex) =>
        chunks.push({ kind: "chunk", sourceIndex: index, chunkIndex, data }),
      );
    }
    return [
      { kind: "manifest", generatedAt: "2026-01-01T00:00:00Z", sources },
      ...chunks,
      { kind: "complete", payloadSha256: await sha256(bodies.join("")) },
    ];
  };

  const toStream = (events) =>
    (async function* () {
      for (const [index, event] of events.entries())
        yield { type: index === 0 ? "snapshot" : "data", value: event };
    })();

  NodeTest.it("reassembles chunked sources and verifies end-to-end", async () => {
    const bodies = ["diff --git a/x b/x\n+one\n", "diff --git a/y b/y\n-two\n+2\n"];
    const outcome = await collectDiffStream(
      toStream(await buildFrames(bodies)),
      new AbortController().signal,
    );
    NodeAssert.equal(outcome.kind, "verified");
    NodeAssert.deepEqual(
      outcome.patch.sources.map((source) => source.diff),
      bodies,
    );
    NodeAssert.equal(outcome.patch.sources[0].diffHash, await sha256(bodies[0]));
  });

  NodeTest.it("rejects an out-of-order chunk before any byte is produced", async () => {
    const events = await buildFrames(["abcdef"], 2);
    const bad = [events[0], events[2], events[1], events[3]];
    let assembly = createDiffAssembly();
    let failed = null;
    for (const event of bad) {
      const next = applyDiffStreamEvent(assembly, event);
      if (!next.ok) {
        failed = next.detail;
        break;
      }
      assembly = next.assembly;
    }
    NodeAssert.match(failed, /out-of-order chunk/);
  });

  NodeTest.it("rejects a tampered body at the per-source hash", async () => {
    const events = await buildFrames(["abc"], 3);
    events[1] = { ...events[1], data: "abd" };
    const outcome = await collectDiffStream(toStream(events), new AbortController().signal);
    NodeAssert.equal(outcome.kind, "mismatch");
    NodeAssert.match(outcome.detail, /manifest hash/);
  });

  NodeTest.it("rejects a stream that ends before the complete frame", async () => {
    const events = (await buildFrames(["abc"], 3)).slice(0, -1);
    const outcome = await collectDiffStream(toStream(events), new AbortController().signal);
    NodeAssert.equal(outcome.kind, "incomplete");
  });

  NodeTest.it("rejects frames that arrive before the manifest", () => {
    const result = applyDiffStreamEvent(createDiffAssembly(), {
      kind: "complete",
      payloadSha256: "0".repeat(64),
    });
    NodeAssert.equal(result.ok, false);
    NodeAssert.match(result.detail, /before the manifest/);
  });
});

NodeTest.describe("themeVarOverrides", () => {
  const cssVars = {
    mutedForeground: "--app-theme-muted-foreground",
    border: "--app-theme-border",
    error: "--app-theme-error",
    text: "--app-theme-text",
    canvas: "--app-theme-canvas",
  };

  NodeTest.it("republishes contract tokens as panel-scoped vars", () => {
    const overrides = themeVarOverrides(
      {
        mutedForeground: "#98a2b3",
        border: "#eaecf0",
        error: "#f04438",
        text: "#101828",
        canvas: "#ffffff",
      },
      cssVars,
    );
    NodeAssert.deepEqual(overrides, {
      "--t3-agents-muted-foreground": "var(--app-theme-muted-foreground, #98a2b3)",
      "--t3-agents-border": "var(--app-theme-border, #eaecf0)",
      "--t3-agents-error": "var(--app-theme-error, #f04438)",
      "--t3-agents-text": "var(--app-theme-text, #101828)",
      "--t3-agents-canvas": "var(--app-theme-canvas, #ffffff)",
    });
  });

  NodeTest.it("skips roles the host did not resolve rather than overriding them", () => {
    const overrides = themeVarOverrides({ text: "#101828" }, cssVars);
    NodeAssert.deepEqual(overrides, {
      "--t3-agents-text": "var(--app-theme-text, #101828)",
    });
  });

  NodeTest.it("falls back to the resolved value when no css var is advertised", () => {
    const overrides = themeVarOverrides({ mutedForeground: "#98a2b3" }, {});
    NodeAssert.deepEqual(overrides, {
      "--t3-agents-muted-foreground": "#98a2b3",
    });
  });

  NodeTest.it("ignores unrelated roles the contract does not publish to this panel", () => {
    const overrides = themeVarOverrides(
      { mutedForeground: "#98a2b3", terminalBackground: "#000000", chrome: "#111" },
      { ...cssVars, terminalBackground: "--app-theme-terminal-background" },
    );
    NodeAssert.deepEqual(Object.keys(overrides), ["--t3-agents-muted-foreground"]);
  });
});

NodeTest.describe("trackThemeVars", () => {
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  /** Frames, then an open stream that never ends (the healthy steady state). */
  const openStream = async function* (frames) {
    for (const frame of frames) yield frame;
    await new Promise(() => {});
  };
  const endedStream = async function* (frames) {
    for (const frame of frames) yield frame;
  };
  /** A stream whose first read rejects — the transport-failure shape. */
  const failingStream = () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream lost")) }),
  });
  const SNAPSHOT = { tokens: { text: "#101828" }, cssVars: { text: "--app-theme-text" } };
  const TEXT_VAR = { "--t3-agents-text": "var(--app-theme-text, #101828)" };

  NodeTest.it("clears retained overrides when a token read fails", async () => {
    const emits = [];
    let reads = 0;
    trackThemeVars(
      {
        getTokens: () =>
          ++reads === 1 ? Promise.resolve(SNAPSHOT) : Promise.reject(new Error("denied")),
        subscribeState: () => openStream([{ type: "data", value: {} }]),
      },
      new AbortController().signal,
      (vars) => emits.push(vars),
    );
    await flush();
    NodeAssert.deepEqual(emits, [TEXT_VAR, null]);
  });

  NodeTest.it("clears retained overrides when the state stream closes", async () => {
    const emits = [];
    trackThemeVars(
      {
        getTokens: () => Promise.resolve(SNAPSHOT),
        subscribeState: () => endedStream([{ type: "closed" }]),
      },
      new AbortController().signal,
      (vars) => emits.push(vars),
    );
    await flush();
    NodeAssert.deepEqual(emits, [TEXT_VAR, null]);
  });

  NodeTest.it("clears retained overrides when the state stream errors", async () => {
    const emits = [];
    trackThemeVars(
      {
        getTokens: () => Promise.resolve(SNAPSHOT),
        subscribeState: failingStream,
      },
      new AbortController().signal,
      (vars) => emits.push(vars),
    );
    await flush();
    NodeAssert.deepEqual(emits, [TEXT_VAR, null]);
  });

  NodeTest.it("ignores a read that resolves after the stream is already lost", async () => {
    const emits = [];
    const read = deferred();
    trackThemeVars(
      {
        getTokens: () => read.promise,
        subscribeState: () => endedStream([{ type: "closed" }]),
      },
      new AbortController().signal,
      (vars) => emits.push(vars),
    );
    await flush();
    read.resolve(SNAPSHOT);
    await flush();
    NodeAssert.deepEqual(emits, [null]);
  });

  NodeTest.it("does not let an older failed read clear a newer result", async () => {
    const emits = [];
    const first = deferred();
    let reads = 0;
    trackThemeVars(
      {
        getTokens: () => (++reads === 1 ? first.promise : Promise.resolve(SNAPSHOT)),
        subscribeState: () => openStream([{ type: "data", value: {} }]),
      },
      new AbortController().signal,
      (vars) => emits.push(vars),
    );
    await flush();
    first.reject(new Error("stale denial"));
    await flush();
    NodeAssert.deepEqual(emits, [TEXT_VAR]);
  });
});
