// Mobile UI lab fixtures. Edit this file, then run `vp run mobile:lab -- --reseed` (or just restart
// the lab); the seeder (apps/server/scripts/mobile-lab-seed.ts) turns it into real server events.
// Pure data on purpose: only a sibling data module is imported, so Node, the seeder and any editor can read it.
import { LAB_PHONE_SCREENSHOT } from "./phoneScreenshot.mts";

export type LabEntry =
  /** A message you typed. Starts a turn. */
  | { readonly kind: "user"; readonly text: string; readonly minutesAgo: number }
  /** Another thread sent this through conn_thread_send. Shows as the folded "Agent" pill. */
  | {
      readonly kind: "agentMessage";
      readonly from: string;
      readonly text: string;
      readonly minutesAgo: number;
    }
  /** Assistant markdown. */
  | { readonly kind: "assistant"; readonly text: string; readonly minutesAgo: number }
  /** `Delegated task "<task>" finished` (or failed) row. */
  | {
      readonly kind: "delegatedNotice";
      readonly task: string;
      readonly outcome: "completed" | "failed" | "cancelled";
      readonly minutesAgo: number;
    }
  /** The inline child-task card. A running one ticks its duration from `startedMinutesAgo`. */
  | {
      readonly kind: "subagent";
      readonly title: string;
      readonly status: "running" | "completed" | "failed";
      readonly startedMinutesAgo: number;
      /** Seconds the task ran, for finished tasks. */
      readonly durationSeconds?: number;
      readonly prompt: string;
      readonly result?: string;
      readonly instanceId: "claudeAgent" | "codex";
      readonly model: string;
    }
  /**
   * An `mcp__orbit__task-create` tool call and its result: the thread shows the created task as a
   * live card. The card reads the task from the Tasks fixtures by `id` (see orbitTasksFixtures.ts)
   * and falls back to this snapshot when the id is not there.
   */
  | {
      readonly kind: "taskReceipt";
      readonly minutesAgo: number;
      readonly id: number;
      readonly title: string;
      readonly status: "todo" | "running" | "reviewing" | "completed";
      readonly project: { readonly id: number; readonly slug: string; readonly name: string };
      readonly node?: string;
      readonly subtasks: { readonly total: number; readonly completed: number };
      readonly pullRequest?: { readonly number: number; readonly state: "open" | "merged" };
    }
  /**
   * A pending question from the agent: the "Needs your answer" card. A real runtime request the app
   * can answer. The lab server has no agent behind it, so Send or Skip only resolves it; `reseed` brings it back.
   */
  | {
      readonly kind: "userInput";
      readonly minutesAgo: number;
      readonly questions: ReadonlyArray<LabUserInputQuestion>;
    };

export interface LabUserInputQuestion {
  readonly id: string;
  /** The short title above the question. */
  readonly header: string;
  /** Markdown. */
  readonly question: string;
  /** Every option needs a description. A trailing "(Recommended)" in a label is how agents mark their pick. */
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly preview?: string;
  }>;
  readonly multiSelect?: boolean;
  /** `false` hides the "Other…" field. */
  readonly allowCustomAnswer?: boolean;
  readonly required?: boolean;
}

export interface LabThread {
  readonly key: string;
  readonly title: string;
  /** Project key from LAB_PROJECTS. */
  readonly project: string;
  readonly branch?: string;
  readonly instanceId: "claudeAgent" | "codex";
  readonly model: string;
  /** Minutes since the last activity, for the thread row. */
  readonly minutesAgo: number;
  readonly entries: ReadonlyArray<LabEntry>;
}

export const LAB_ENVIRONMENT_LABEL = "mini";

export const LAB_PROJECTS = [
  {
    key: "apps",
    title: "apps",
    directory: "apps",
    /** Project scripts, so the Terminal sheet has rows to run. */
    scripts: [
      {
        id: "test",
        name: "Run tests",
        command: "vp test run",
        icon: "test",
        runOnWorktreeCreate: false,
      },
      {
        id: "dev",
        name: "Start dev server",
        command: "vp run dev",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    ],
  },
] as const;

/** The thread to open first. */
export const LAB_PRIMARY_THREAD = "stalled-threads";

const LONG_AGENT_REPORT = `Stalled-thread audit for the Orbit fleet, as of this morning.

## What I checked

- Every thread in project **apps** on Mini and on Beast that has had no run in the last 6 hours.
- Every linked pull request, with its CI state and the last review comment.
- Orbit tasks whose agent session ended without a handoff.

## Findings

1. \`Move Orbit Workers to Target Nodes\` is blocked on the node pool change. PR #4812 is green, but nobody has approved it.
2. \`Improve Orbit Task Delivery Speed\` finished its last run 3 hours ago and the PR is merged. The thread only needs to be settled.
3. \`Plan a dedicated ingress Node\` has 4 merged PRs and one open question: which provider hosts the ingress Node.
4. Two threads (\`Conn icons: superheroicons 16 solid\`, \`dlf-leden backlog\`) are still working and are not stalled.

## Suggested next steps

- Approve PR #4812, then let the worker thread continue.
- Settle the delivery-speed thread.
- Ask Nick which provider should host the ingress Node.

\`\`\`
threads scanned: 41
stalled:          3
working:          2
settled:         36
\`\`\`

Nothing else needs attention right now.`;

export const LAB_THREADS: ReadonlyArray<LabThread> = [
  {
    key: "stalled-threads",
    title: "Map Stalled Orbit Threads and PRs",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 1,
    entries: [
      {
        kind: "user",
        minutesAgo: 62,
        text: "Map every stalled Orbit thread and its PRs. Delegate the checks, then give me one list of what needs me.",
      },
      {
        kind: "assistant",
        minutesAgo: 61,
        text: "I'll split the audit into three delegated tasks and merge the results.\n\n- **Threads**: find threads with no run in the last 6 hours\n- **Pull requests**: CI state and review state for every linked PR\n- **Orbit tasks**: tasks whose agent ended without a handoff",
      },
      {
        kind: "delegatedNotice",
        minutesAgo: 48,
        outcome: "completed",
        task: "Audit Orbit threads with no run in 6 hours",
      },
      {
        kind: "delegatedNotice",
        minutesAgo: 41,
        outcome: "completed",
        task: "Check CI and review state of linked PRs",
      },
      {
        kind: "delegatedNotice",
        minutesAgo: 33,
        outcome: "failed",
        task: "List Orbit tasks that ended without a handoff",
      },
      {
        kind: "agentMessage",
        from: "orbit-task-delivery",
        minutesAgo: 30,
        text: "Done with the delivery-speed thread. Its last PR (#4790) is merged and the thread can be settled.",
      },
      {
        kind: "assistant",
        minutesAgo: 29,
        text: "Thanks. I marked **Improve Orbit Task Delivery Speed** as ready to settle.\n\nOne task failed (the handoff scan). I'll rerun it after the other checks.",
      },
      {
        kind: "agentMessage",
        from: "orbit-workers",
        minutesAgo: 22,
        text: "Blocked: PR #4812 is green but has no approval. I cannot move on until someone approves it.",
      },
      {
        kind: "agentMessage",
        from: "ingress-node",
        minutesAgo: 17,
        text: LONG_AGENT_REPORT,
      },
      {
        kind: "assistant",
        minutesAgo: 16,
        text: "The ingress thread sent a full report. Summary:\n\n1. **Three threads are stalled**: workers, ingress and one idle thread\n2. **Two threads are still working**, so I left them alone\n3. **Next steps**\n   - approve PR #4812\n   - settle the delivery-speed thread\n   - decide which provider hosts the ingress Node\n\nI'm starting one more task to check the icons work, since it touches the same PRs.",
      },
      {
        kind: "agentMessage",
        from: "dlf-backlog",
        minutesAgo: 15,
        text: "FYI: the dlf-leden backlog now has one Orbit task per item (19 tasks, all queued).",
      },
      {
        kind: "assistant",
        minutesAgo: 13,
        text: 'Code block lab:\n\n```ts\nconst median = sorted[Math.floor(sorted.length / 2)];\nexport const releaseEvery = "hour";\n```\n\nA long line:\n\n```bash\ncurl -sS -X POST https://gateway.orbit.example/api/v1/instances/4812/deploy -H "Authorization: Bearer $ORBIT_TOKEN" -d \'{"ref":"main","wait":true}\'\n```\n\nNo language:\n\n```\nCI median: 24 min\nauto-release: hourly\n```',
      },
      {
        kind: "assistant",
        minutesAgo: 14,
        text: `Here is the thread list as it looks on the phone now:\n\n![Thread list on iPhone](${LAB_PHONE_SCREENSHOT})\n\nThe stalled threads sit at the top.`,
      },
      {
        kind: "subagent",
        title: "Conn icons: superheroicons 16 solid",
        status: "running",
        startedMinutesAgo: 13.75,
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        prompt:
          "Check the Conn icon set against superheroicons 16 solid. List every icon that has no 16 solid match and propose a replacement.",
      },
    ],
  },
  // Sibling threads: sidebar rows, and the senders of the Agent pills above.
  {
    key: "orbit-task-delivery",
    title: "Improve Orbit Task Delivery Speed",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 13,
    entries: [
      { kind: "user", minutesAgo: 200, text: "Make Orbit task delivery faster." },
      {
        kind: "assistant",
        minutesAgo: 190,
        text: "Delivery now streams the task brief instead of polling.\n\n- cut the median start time from 41 s to 9 s\n- added a fallback poll every 30 s",
      },
    ],
  },
  {
    key: "orbit-workers",
    title: "Move Orbit Workers to Target Nodes",
    project: "apps",
    branch: "orbit-workers",
    instanceId: "codex",
    model: "gpt-5.4",
    minutesAgo: 125,
    entries: [
      { kind: "user", minutesAgo: 300, text: "Move the Orbit workers onto their target Nodes." },
      {
        kind: "assistant",
        minutesAgo: 125,
        text: "Workers now start on the Node their task names. PR #4812 is open.",
      },
    ],
  },
  {
    key: "ingress-node",
    title: "Plan a dedicated ingress Node in front of the fleet",
    project: "apps",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 62,
    entries: [
      { kind: "user", minutesAgo: 400, text: "Plan a dedicated ingress Node." },
      {
        kind: "assistant",
        minutesAgo: 62,
        text: "The plan has three steps:\n\n1. pick a provider\n2. move TLS to the ingress Node\n3. cut over the routes",
      },
    ],
  },
  {
    key: "dlf-backlog",
    title: "dlf-leden backlog: one Orbit task per item",
    project: "apps",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 33,
    entries: [
      { kind: "user", minutesAgo: 90, text: "Create one Orbit task per backlog item." },
      { kind: "assistant", minutesAgo: 33, text: "Created 19 tasks, all queued." },
    ],
  },
  // Question card lab: each thread holds one pending question. Edit the text, then `lab.mts reseed`.
  {
    key: "question-single",
    title: "Card lab: one question",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 2,
    entries: [
      { kind: "user", minutesAgo: 9, text: "Ship the worker change when it is ready." },
      {
        kind: "assistant",
        minutesAgo: 8,
        text: "The worker change is finished and all 412 tests pass. It touches three files, and two things shaped the options below:\n\n- **Risk:** it changes how the queue drains, so a bad deploy stalls every worker until someone rolls it back.\n- **Speed:** auto-release ships merged work within the hour. A draft pull request waits for a review.\n\nI lean towards merging, but this is your call.",
      },
      {
        kind: "userInput",
        minutesAgo: 2,
        questions: [
          {
            id: "ship",
            header: "Ship",
            question: "How should the worker change reach `main`?",
            options: [
              {
                label: "Merge to main after CI passes and delete the branch (Recommended)",
                description: "Fastest. The auto-release job picks it up within the hour.",
              },
              {
                label: "Open a draft pull request",
                description: "Nothing merges until you approve it.",
              },
              {
                label: "Keep it on the branch",
                description: "I stop here and leave the branch as it is.",
              },
            ],
          },
        ],
      },
    ],
  },
  // Task receipt lab: the agent created Orbit tasks. 482 is live in the Tasks fixtures (it moves on
  // from this snapshot); 990 is not there, so its card keeps the snapshot.
  {
    key: "task-receipts",
    title: "Card lab: task receipts",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 1,
    entries: [
      { kind: "user", minutesAgo: 6, text: "Turn the plan into Orbit tasks." },
      {
        kind: "taskReceipt",
        minutesAgo: 5,
        id: 482,
        title: "Image attachments in the composer",
        status: "todo",
        project: { id: 12, slug: "conn", name: "Conn" },
        subtasks: { total: 4, completed: 0 },
      },
      {
        kind: "taskReceipt",
        minutesAgo: 4,
        id: 990,
        title: "Retry the deploy step when the node is waking up",
        status: "todo",
        project: { id: 78, slug: "orbit", name: "Orbit" },
        subtasks: { total: 3, completed: 0 },
      },
      {
        kind: "assistant",
        minutesAgo: 3,
        text: "I created two tasks. The first is already running; the second waits for a node.",
      },
    ],
  },
  {
    key: "question-multi",
    title: "Card lab: three questions",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 3,
    entries: [
      { kind: "user", minutesAgo: 20, text: "Plan the ingress Node rollout." },
      {
        kind: "assistant",
        minutesAgo: 19,
        text: "I have a plan for the ingress Node. Three choices are yours, and each one has a trade-off:\n\n1. **Provider.** UpCloud shares the private network with the other Nodes. Hetzner costs less, but it needs a new account and firewall rules.\n2. **Checks.** Route replay is the slowest, about 20 minutes, but it caught the routing error that broke the last cutover.\n3. **Window.** WireGuard peers reconnect within 30 seconds, so a quiet hour is enough.\n\nI will call the Node `ingress-2` unless you say otherwise.",
      },
      {
        kind: "userInput",
        minutesAgo: 3,
        questions: [
          {
            id: "provider",
            header: "Provider",
            question: "Which provider should host the ingress Node?",
            options: [
              {
                label: "UpCloud (Recommended)",
                description: "Already holds the other Nodes. Same private network.",
              },
              { label: "Hetzner", description: "Cheaper, but a new account and firewall setup." },
              { label: "Beast", description: "Our own hardware. No provider bill." },
            ],
          },
          {
            id: "checks",
            header: "Checks",
            question:
              "Which checks should run before the cutover?\n\n```\ncutover order: tls -> replay -> handshake\n```",
            multiSelect: true,
            options: [
              { label: "TLS renewal", description: "Renew every certificate on the new Node." },
              { label: "Route replay", description: "Replay the last hour of traffic." },
              { label: "WireGuard handshake", description: "Confirm every peer reconnects." },
            ],
          },
          {
            id: "window",
            header: "Cutover window",
            question: "When should I cut over? Name a day and a time.",
            options: [],
          },
        ],
      },
    ],
  },
  {
    key: "question-long",
    title: "Card lab: long question",
    project: "apps",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    minutesAgo: 4,
    entries: [
      // No assistant text before the question: the panel shows no context.
      { kind: "user", minutesAgo: 30, text: "Clean up the stalled PRs." },
      {
        kind: "userInput",
        minutesAgo: 4,
        questions: [
          {
            id: "prs",
            header: "Stalled PRs",
            question:
              "Three pull requests have been green for more than a day with no review. I can merge them, close them or leave them.\n\n- **#4812** moves the Orbit workers onto their target Nodes. It touches `OrchestratorLayer` and the Node pool, so it is the risky one.\n- **#4790** is the delivery-speed change. Its thread is already settled.\n- **#4755** renames two settings keys. Old keys keep working for one release.\n\nIf I merge #4812 first, the other two need a rebase. If I merge them first, #4812 waits for another CI run, about 25 minutes.\n\n```\nCI median: 24 min\nauto-release: hourly\n```\n\nWhat should I do?",
            options: [
              {
                label: "Merge all three, riskiest last (Recommended)",
                description: "#4790, then #4755, then #4812 after its CI run.",
              },
              {
                label: "Merge #4790 and #4755 only",
                description: "Leave #4812 for you to review.",
              },
              { label: "Close all three", description: "Nothing here is needed any more." },
            ],
          },
        ],
      },
    ],
  },
];
