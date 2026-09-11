/**
 * Dev-only subagent fixtures: fabricated thread activities that light up the
 * Agents panel and the inline chat spawn CTA without running a real fleet.
 *
 * Injection happens at the one point both surfaces already derive from —
 * ChatView's `threadActivities` — so the real fold, the real panel derive, and
 * the real timeline collapse all run. A fixture therefore exercises the same
 * code path a live run does, which is where these bugs actually live; nothing
 * here is a parallel rendering path that can drift from production.
 *
 * Enable with `?dev-agents=<scenario>`; see `useDevSubagentActivities`.
 * DEV only — callers gate on `import.meta.env.DEV`, a static false in
 * production builds, so this module tree-shakes out of the shipped bundle.
 */
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";

export const DEV_SUBAGENT_SCENARIOS = [
  "workflow-live",
  "workflow-settled",
  "workflow-failed",
  "direct",
  "mixed",
  "overflow",
  "many",
  "empty",
] as const;

export type DevSubagentScenario = (typeof DEV_SUBAGENT_SCENARIOS)[number];

export function isDevSubagentScenario(value: string): value is DevSubagentScenario {
  return (DEV_SUBAGENT_SCENARIOS as ReadonlyArray<string>).includes(value);
}

const DEV_TURN_ID = "dev-agents-turn";

/**
 * Live rows are timestamped relative to the moment the fixture is built so the
 * panel's self-ticking elapsed timers read as seconds, not as the decades a
 * hardcoded epoch would produce.
 */
type Clock = { readonly at: (secondsAgo: number) => string };

function clockFrom(now: number): Clock {
  return { at: (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString() };
}

type Payload = Record<string, unknown>;

function activity(
  sequence: number,
  kind: string,
  payload: Payload,
  at: string,
): OrchestrationThreadActivity {
  const stamped: Payload =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `dev-agents-${sequence}`,
    tone: kind === "task.completed" && payload.status === "failed" ? "error" : "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: DEV_TURN_ID,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** Accumulates rows while keeping ids and ordering monotonic. */
class Rows {
  private readonly rows: OrchestrationThreadActivity[] = [];
  private sequence = 0;

  push(kind: string, payload: Payload, at: string): this {
    this.sequence += 1;
    this.rows.push(activity(this.sequence, kind, payload, at));
    return this;
  }

  build(): ReadonlyArray<OrchestrationThreadActivity> {
    return this.rows;
  }
}

type Usage = {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolUses?: number;
};

type MemberSpec = {
  readonly slot: number;
  readonly title: string;
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly phaseIndex: number;
  readonly phaseTitle: string;
  /** Terminal states settle the row; the rest leave it in flight. */
  readonly status: "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled";
  readonly progress?: string;
  readonly lastToolName?: string;
  readonly result?: string;
  readonly error?: string;
  readonly usage?: Usage;
  readonly attempt?: number;
};

type WorkflowSpec = {
  readonly id: string;
  readonly workflowName: string;
  readonly title: string;
  readonly phases: ReadonlyArray<{ readonly index: number; readonly title: string }>;
  /** Coordinators settle through task.completed, which knows only these. */
  readonly status: "running" | "completed" | "failed";
  readonly members: ReadonlyArray<MemberSpec>;
  readonly scriptPath?: string;
  readonly usage?: Usage;
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Emits a coordinator plus its members. Member task ids carry the `:wf:`
 * marker the timeline uses to fold a whole run into one CTA row, and
 * `parentAgentId` is what the panel derive groups on — both are required for
 * the two surfaces to agree on the same run.
 */
function pushWorkflow(rows: Rows, clock: Clock, spec: WorkflowSpec): void {
  const coordinatorBase: Payload = {
    taskId: spec.id,
    taskType: "local_workflow",
    title: spec.title,
    workflowName: spec.workflowName,
    phases: spec.phases,
    ...(spec.scriptPath === undefined
      ? {}
      : { runHandles: { runId: spec.id, scriptPath: spec.scriptPath } }),
  };

  rows.push("task.started", { ...coordinatorBase, detail: spec.title }, clock.at(180));

  for (const member of spec.members) {
    const taskId = `${spec.id}:wf:${member.slot}`;
    const base: Payload = {
      taskId,
      taskType: "subagent",
      parentAgentId: spec.id,
      title: member.title,
      agentIndex: member.slot,
      phaseIndex: member.phaseIndex,
      phaseTitle: member.phaseTitle,
      ...(member.role === undefined ? {} : { role: member.role }),
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.effort === undefined ? {} : { effort: member.effort }),
      ...(member.attempt === undefined ? {} : { attempt: member.attempt }),
    };

    rows.push("task.started", base, clock.at(170 - member.slot));

    if (member.progress !== undefined || member.lastToolName !== undefined) {
      rows.push(
        "task.progress",
        {
          ...base,
          ...(member.progress === undefined ? {} : { summary: member.progress }),
          ...(member.lastToolName === undefined ? {} : { lastToolName: member.lastToolName }),
          ...(member.usage === undefined ? {} : { typedUsage: member.usage }),
        },
        clock.at(90 - member.slot),
      );
    }

    // Non-terminal transitions and cancellation both arrive as task.updated:
    // task.completed only understands completed/failed/stopped, so a
    // cancellation sent that way would silently settle as "completed".
    if (member.status === "waiting" || member.status === "idle" || member.status === "cancelled") {
      rows.push(
        "task.updated",
        {
          ...base,
          status: member.status,
          ...(member.usage === undefined ? {} : { typedUsage: member.usage }),
        },
        clock.at(60 - member.slot),
      );
      continue;
    }

    if (TERMINAL.has(member.status)) {
      rows.push(
        "task.completed",
        {
          ...base,
          status: member.status,
          summary: member.status === "failed" ? (member.error ?? "Agent failed") : member.result,
          ...(member.usage === undefined ? {} : { typedUsage: member.usage }),
        },
        clock.at(40 - member.slot),
      );
    }
  }

  if (spec.status === "running") {
    return;
  }
  rows.push(
    "task.completed",
    {
      ...coordinatorBase,
      status: spec.status,
      summary: spec.status === "failed" ? "Workflow failed" : "Workflow finished",
      ...(spec.usage === undefined ? {} : { typedUsage: spec.usage }),
    },
    clock.at(5),
  );
}

/** Direct spawns share a turn so the timeline batches them into one CTA row. */
function pushDirectAgent(
  rows: Rows,
  clock: Clock,
  spec: {
    readonly id: string;
    readonly title: string;
    readonly role?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly status: MemberSpec["status"];
    readonly progress?: string;
    readonly lastToolName?: string;
    readonly result?: string;
    readonly error?: string;
    readonly usage?: Usage;
    readonly offset?: number;
  },
): void {
  const offset = spec.offset ?? 0;
  const base: Payload = {
    taskId: spec.id,
    taskType: "subagent",
    title: spec.title,
    ...(spec.role === undefined ? {} : { role: spec.role }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
  };

  rows.push("task.started", base, clock.at(150 - offset));

  if (spec.progress !== undefined || spec.lastToolName !== undefined) {
    rows.push(
      "task.progress",
      {
        ...base,
        ...(spec.progress === undefined ? {} : { summary: spec.progress }),
        ...(spec.lastToolName === undefined ? {} : { lastToolName: spec.lastToolName }),
        ...(spec.usage === undefined ? {} : { typedUsage: spec.usage }),
      },
      clock.at(80 - offset),
    );
  }

  // See pushWorkflow: cancellation only lands through task.updated.
  if (spec.status === "waiting" || spec.status === "idle" || spec.status === "cancelled") {
    rows.push(
      "task.updated",
      {
        ...base,
        status: spec.status,
        ...(spec.usage === undefined ? {} : { typedUsage: spec.usage }),
      },
      clock.at(50 - offset),
    );
    return;
  }

  if (TERMINAL.has(spec.status)) {
    rows.push(
      "task.completed",
      {
        ...base,
        status: spec.status,
        summary: spec.status === "failed" ? (spec.error ?? "Agent failed") : spec.result,
        ...(spec.usage === undefined ? {} : { typedUsage: spec.usage }),
      },
      clock.at(30 - offset),
    );
  }
}

const REVIEW_PHASES = [
  { index: 0, title: "Scan" },
  { index: 1, title: "Review" },
  { index: 2, title: "Verify" },
] as const;

/** A run mid-flight: one phase done, one working, one still pending. */
function workflowLiveMembers(): ReadonlyArray<MemberSpec> {
  return [
    {
      slot: 0,
      title: "Scan changed files",
      role: "explore",
      model: "claude-sonnet-5",
      phaseIndex: 0,
      phaseTitle: "Scan",
      status: "completed",
      result: "Found 34 changed files across 6 packages",
      usage: { totalTokens: 18_420, toolUses: 12 },
    },
    {
      slot: 1,
      title: "Review correctness",
      role: "reviewer",
      model: "claude-opus-5",
      effort: "high",
      phaseIndex: 1,
      phaseTitle: "Review",
      status: "running",
      progress: "Reading apps/web/src/components/AgentsPanel.tsx",
      lastToolName: "Read",
      usage: { totalTokens: 96_310, toolUses: 41 },
    },
    {
      slot: 2,
      title: "Review performance",
      role: "reviewer",
      model: "claude-opus-5",
      effort: "high",
      phaseIndex: 1,
      phaseTitle: "Review",
      status: "waiting",
      progress: "Awaiting approval to run the profiler",
      usage: { totalTokens: 44_800, toolUses: 18 },
    },
    {
      slot: 3,
      title: "Review accessibility",
      role: "reviewer",
      model: "claude-sonnet-5",
      phaseIndex: 1,
      phaseTitle: "Review",
      status: "running",
      lastToolName: "Grep",
      usage: { totalTokens: 22_150, toolUses: 9 },
    },
  ];
}

function scenarioRows(
  scenario: DevSubagentScenario,
  now: number,
): ReadonlyArray<OrchestrationThreadActivity> {
  const clock = clockFrom(now);
  const rows = new Rows();

  switch (scenario) {
    case "empty":
      return [];

    case "workflow-live":
      pushWorkflow(rows, clock, {
        id: "wf-review",
        workflowName: "review-changes",
        title: "Review changes across dimensions",
        phases: REVIEW_PHASES,
        status: "running",
        scriptPath: "/tmp/t3-workflows/review-changes.js",
        members: workflowLiveMembers(),
      });
      return rows.build();

    case "workflow-settled":
      pushWorkflow(rows, clock, {
        id: "wf-review",
        workflowName: "review-changes",
        title: "Review changes across dimensions",
        phases: REVIEW_PHASES,
        status: "completed",
        scriptPath: "/tmp/t3-workflows/review-changes.js",
        // A finished run has reached its last phase: without a Verify member
        // that phase derives as pending (no members) and the settled panel
        // would still show an unstarted segment.
        members: [
          ...workflowLiveMembers().map((member) => ({
            ...member,
            status: "completed" as const,
            result: member.result ?? "Done",
          })),
          {
            slot: 4,
            title: "Verify findings",
            role: "reviewer",
            model: "claude-opus-5",
            effort: "high",
            phaseIndex: 2,
            phaseTitle: "Verify",
            status: "completed" as const,
            result: "3 of 5 findings confirmed",
            usage: { totalTokens: 33_900, toolUses: 16 },
          },
        ],
      });
      return rows.build();

    case "workflow-failed":
      pushWorkflow(rows, clock, {
        id: "wf-migrate",
        workflowName: "migrate-call-sites",
        title: "Migrate call sites",
        phases: [
          { index: 0, title: "Discover" },
          { index: 1, title: "Transform" },
          { index: 2, title: "Verify" },
        ],
        status: "failed",
        scriptPath: "/tmp/t3-workflows/migrate-call-sites.js",
        members: [
          {
            slot: 0,
            title: "Discover call sites",
            role: "explore",
            model: "claude-sonnet-5",
            phaseIndex: 0,
            phaseTitle: "Discover",
            status: "completed",
            result: "41 call sites in 12 files",
            usage: { totalTokens: 12_300, toolUses: 8 },
          },
          {
            slot: 1,
            title: "Transform packages/contracts",
            model: "claude-sonnet-5",
            phaseIndex: 1,
            phaseTitle: "Transform",
            status: "failed",
            error: "Type error after codemod: Property 'phaseTitle' does not exist on type 'Row'.",
            usage: { totalTokens: 61_040, toolUses: 27 },
            attempt: 2,
          },
          {
            slot: 2,
            title: "Transform apps/web",
            model: "claude-sonnet-5",
            phaseIndex: 1,
            phaseTitle: "Transform",
            status: "cancelled",
            usage: { totalTokens: 8_900, toolUses: 4 },
          },
        ],
      });
      return rows.build();

    case "direct":
      pushDirectAgent(rows, clock, {
        id: "direct-1",
        title: "Find the flaky test",
        role: "debugger",
        model: "claude-opus-5",
        effort: "high",
        status: "running",
        progress: "Re-running apps/server/src/orchestration tests",
        lastToolName: "Bash",
        usage: { totalTokens: 51_200, toolUses: 22 },
        offset: 0,
      });
      pushDirectAgent(rows, clock, {
        id: "direct-2",
        title: "Map the websocket layer",
        role: "explore",
        model: "claude-sonnet-5",
        status: "completed",
        result: "Entry points and reactors mapped",
        usage: { totalTokens: 27_600, toolUses: 15 },
        offset: 1,
      });
      pushDirectAgent(rows, clock, {
        id: "direct-3",
        title: "Idle Codex child",
        model: "gpt-5-codex",
        status: "idle",
        progress: "Resumable — waiting on a follow-up",
        usage: { totalTokens: 9_400, toolUses: 3 },
        offset: 2,
      });
      return rows.build();

    case "mixed":
      pushWorkflow(rows, clock, {
        id: "wf-review",
        workflowName: "review-changes",
        title: "Review changes across dimensions",
        phases: REVIEW_PHASES,
        status: "running",
        scriptPath: "/tmp/t3-workflows/review-changes.js",
        members: workflowLiveMembers(),
      });
      pushDirectAgent(rows, clock, {
        id: "direct-1",
        title: "Find the flaky test",
        role: "debugger",
        model: "claude-opus-5",
        effort: "high",
        status: "running",
        progress: "Re-running orchestration tests",
        lastToolName: "Bash",
        usage: { totalTokens: 51_200, toolUses: 22 },
      });
      pushDirectAgent(rows, clock, {
        id: "direct-2",
        title: "Map the websocket layer",
        role: "explore",
        model: "claude-sonnet-5",
        status: "completed",
        result: "Entry points and reactors mapped",
        usage: { totalTokens: 27_600, toolUses: 15 },
        offset: 1,
      });
      return rows.build();

    // Fixed-height rows must not grow when the data is hostile: long titles,
    // long roles, long errors, and huge counters all have to truncate.
    case "overflow":
      pushWorkflow(rows, clock, {
        id: "wf-overflow",
        workflowName:
          "an-extremely-long-workflow-name-that-should-truncate-rather-than-wrap-the-header",
        title: "Workflow whose title is far too long to fit in the panel header without truncating",
        phases: [
          { index: 0, title: "A phase title that is much longer than the rail expects" },
          { index: 1, title: "Verify" },
        ],
        status: "running",
        members: [
          {
            slot: 0,
            title:
              "An agent title that keeps going well past the point where the row can show it all",
            role: "a-very-long-role-name-that-should-clip",
            model: "claude-opus-5",
            effort: "xhigh",
            phaseIndex: 0,
            phaseTitle: "A phase title that is much longer than the rail expects",
            status: "failed",
            error:
              "A failure message long enough to prove the activity line truncates instead of wrapping and pushing the metrics line out of the row box entirely.",
            usage: { totalTokens: 2_400_000, toolUses: 1284 },
            attempt: 3,
          },
          {
            slot: 1,
            title: "Short one",
            model: "claude-sonnet-5",
            phaseIndex: 1,
            phaseTitle: "Verify",
            status: "running",
            lastToolName: "AnUnusuallyLongToolNameForProgressLines",
            usage: { totalTokens: 999, toolUses: 1 },
          },
        ],
      });
      return rows.build();

    // Scale: the roster caps at 100 agents, so 60 members exercises scrolling
    // and per-row cost without hitting the retention cliff.
    case "many": {
      const phases = Array.from({ length: 5 }, (_, index) => ({
        index,
        title: `Phase ${index + 1}`,
      }));
      const statuses = ["completed", "running", "waiting", "failed", "idle"] as const;
      pushWorkflow(rows, clock, {
        id: "wf-fleet",
        workflowName: "wide-fan-out",
        title: "Wide fan-out",
        phases,
        status: "running",
        members: Array.from({ length: 60 }, (_, slot): MemberSpec => {
          const status = statuses[slot % statuses.length]!;
          const phaseIndex = slot % phases.length;
          return {
            slot,
            title: `Agent ${slot + 1}`,
            ...(slot % 3 === 0 ? { role: "reviewer" } : {}),
            model: slot % 2 === 0 ? "claude-sonnet-5" : "claude-opus-5",
            phaseIndex,
            phaseTitle: `Phase ${phaseIndex + 1}`,
            status,
            ...(status === "running" ? { progress: `Working on chunk ${slot + 1}` } : {}),
            ...(status === "completed" ? { result: `Chunk ${slot + 1} done` } : {}),
            ...(status === "failed" ? { error: `Chunk ${slot + 1} failed` } : {}),
            usage: { totalTokens: 1_000 * (slot + 1), toolUses: slot },
          };
        }),
      });
      return rows.build();
    }
  }
}

/**
 * Fabricated activities for a scenario. `now` is passed in rather than read
 * here so callers can keep the value stable across renders — rebuilding with a
 * fresh clock every render would reset the panel's elapsed timers.
 */
export function devSubagentActivities(
  scenario: DevSubagentScenario,
  now: number,
): ReadonlyArray<OrchestrationThreadActivity> {
  return scenarioRows(scenario, now);
}
