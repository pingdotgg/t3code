// Dummy data for the mobile mock. The thread shapes and the question threads are the native lab's
// (apps/mobile/scripts/lab/fixtures.mts), copied so the web typecheck stays out of apps/mobile.
// Edit the text here; the screens read it live.
import type { Provider } from "../components/Icon";

export type LabEntry =
  | { readonly kind: "user"; readonly text: string; readonly minutesAgo: number }
  | {
      readonly kind: "agentMessage";
      readonly from: string;
      readonly text: string;
      readonly minutesAgo: number;
    }
  | { readonly kind: "assistant"; readonly text: string; readonly minutesAgo: number }
  | {
      readonly kind: "delegatedNotice";
      readonly task: string;
      readonly outcome: "completed" | "failed" | "cancelled";
      readonly minutesAgo: number;
    }
  | {
      readonly kind: "subagent";
      readonly title: string;
      readonly status: "running" | "completed" | "failed";
      readonly elapsed: string;
      readonly prompt: string;
      readonly instanceId: Provider;
      readonly model: string;
    }
  | {
      readonly kind: "userInput";
      readonly minutesAgo: number;
      readonly questions: ReadonlyArray<LabUserInputQuestion>;
    };

export interface LabUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect?: boolean;
}

export interface LabThread {
  readonly key: string;
  readonly title: string;
  readonly project: string;
  readonly branch?: string;
  readonly instanceId: Provider;
  readonly model: string;
  readonly minutesAgo: number;
  readonly entries: ReadonlyArray<LabEntry>;
}

export const LAB_ENVIRONMENT_LABEL = "mini";

const CODE_LAB = [
  "Code block lab:",
  "",
  "```ts",
  "const median = sorted[Math.floor(sorted.length / 2)];",
  'export const releaseEvery = "hour";',
  "```",
].join("\n");

export const FEED_THREAD: LabThread = {
  key: "stalled-threads",
  title: "Map Stalled Orbit Threads and PRs",
  project: "apps",
  branch: "main",
  instanceId: "claudeAgent",
  model: "Opus 5.5",
  minutesAgo: 1,
  entries: [
    {
      kind: "user",
      minutesAgo: 62,
      text: "Map every stalled Orbit thread and its PRs. Delegate the checks, then give me one list of what needs me.",
    },
    {
      kind: "assistant",
      minutesAgo: 16,
      text: "The ingress thread sent a full report. Summary:\n\n1. **Three threads are stalled**: workers, ingress and one idle thread\n2. **Two threads are still working**, so I left them alone\n3. **Next steps**\n   - approve PR #4812\n   - settle the delivery-speed thread\n\nI'm starting one more task to check the icons work.",
    },
    {
      kind: "assistant",
      minutesAgo: 13,
      text: CODE_LAB,
    },
    {
      kind: "agentMessage",
      from: "dlf-leden backlog: one Orbit task per item",
      minutesAgo: 15,
      text: "FYI: the dlf-leden backlog now has one Orbit task per item (19 tasks, all queued).",
    },
    {
      kind: "subagent",
      title: "Conn icons: superheroicons 16 solid",
      status: "running",
      elapsed: "25m",
      prompt: "Check the Conn icon set against superheroicons 16 solid.",
      instanceId: "claudeAgent",
      model: "Opus 5.5",
    },
  ],
};

const SHIP_CONTEXT =
  "The worker change is finished and all 412 tests pass. It touches three files, and two things shaped the options below:\n\n- **Risk:** it changes how the queue drains, so a bad deploy stalls every worker until someone rolls it back.\n- **Speed:** auto-release ships merged work within the hour. A draft pull request waits for a review.\n\nI lean towards merging, but this is your call.";

const QUESTION_THREADS: Record<"single" | "multi" | "long", LabThread> = {
  single: {
    key: "question-single",
    title: "Card lab: one question",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "Opus 5.5",
    minutesAgo: 2,
    entries: [
      { kind: "user", minutesAgo: 9, text: "Ship the worker change when it is ready." },
      { kind: "assistant", minutesAgo: 8, text: SHIP_CONTEXT },
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
  multi: {
    key: "question-multi",
    title: "Card lab: three questions",
    project: "apps",
    branch: "main",
    instanceId: "claudeAgent",
    model: "Opus 5.5",
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
  long: {
    key: "question-long",
    title: "Card lab: long question",
    project: "apps",
    instanceId: "claudeAgent",
    model: "Opus 5.5",
    minutesAgo: 4,
    entries: [
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
};

export interface QuestionScenario {
  readonly thread: LabThread;
  /** The step to open on. */
  readonly step: number;
  /** Option labels (without "(Recommended)") already picked, per question id. */
  readonly picked: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Answers typed in the prompt box, per question id. */
  readonly custom: Readonly<Record<string, string>>;
}

export const QUESTION_SCENARIOS: Record<string, QuestionScenario> = {
  single: { thread: QUESTION_THREADS.single, step: 0, picked: {}, custom: {} },
  selected: {
    thread: QUESTION_THREADS.single,
    step: 0,
    picked: { ship: ["Merge to main after CI passes and delete the branch (Recommended)"] },
    custom: {},
  },
  "multi-1": { thread: QUESTION_THREADS.multi, step: 0, picked: {}, custom: {} },
  "multi-2": {
    thread: QUESTION_THREADS.multi,
    step: 1,
    picked: { provider: ["UpCloud (Recommended)"], checks: ["TLS renewal", "Route replay"] },
    custom: {},
  },
  "multi-3": {
    thread: QUESTION_THREADS.multi,
    step: 2,
    picked: { provider: ["UpCloud (Recommended)"], checks: ["TLS renewal"] },
    custom: { window: "Tomorrow at 06:00, a quiet hour." },
  },
  long: { thread: QUESTION_THREADS.long, step: 0, picked: {}, custom: {} },
  "cant-submit": { thread: QUESTION_THREADS.multi, step: 2, picked: {}, custom: {} },
};

export interface ListThread {
  readonly title: string;
  readonly project: string;
  readonly branch?: string;
  readonly provider: Provider;
  readonly time: string;
  readonly state: "done" | "working" | "waiting" | "failed";
  /** Where the thread runs. */
  readonly machine: "laptop" | "server" | "cloud";
  readonly pr?: { readonly number: number; readonly state: "open" | "merged" | "draft" };
  readonly diff?: { readonly added: number; readonly removed: number };
}

export const LIST_THREADS: ReadonlyArray<ListThread> = [
  {
    title: "Improve Orbit Task Delivery Speed",
    project: "apps",
    branch: "main",
    provider: "claudeAgent",
    time: "23m",
    state: "done",
    machine: "server",
    pr: { number: 4812, state: "open" },
    diff: { added: 17, removed: 4 },
  },
  {
    title: "dlf-leden backlog: one Orbit task per item",
    project: "apps",
    provider: "claudeAgent",
    time: "43m",
    state: "waiting",
    machine: "server",
  },
  {
    title: "Plan a dedicated ingress Node in front of the fleet",
    project: "apps",
    provider: "claudeAgent",
    time: "1h",
    state: "done",
    machine: "laptop",
    diff: { added: 212, removed: 38 },
  },
  {
    title: "Move Orbit Workers to Target Nodes",
    project: "apps",
    branch: "orbit-workers",
    provider: "codex",
    time: "2h",
    state: "done",
    machine: "server",
    pr: { number: 4809, state: "merged" },
    diff: { added: 96, removed: 121 },
  },
  {
    title: "Paste performance in long threads",
    project: "conn",
    branch: "paste-perf",
    provider: "codex",
    time: "3h",
    state: "failed",
    machine: "cloud",
    pr: { number: 1928, state: "draft" },
    diff: { added: 8, removed: 2 },
  },
  {
    title: "Hauzer: map view clustering",
    project: "hauzer",
    branch: "map-clusters",
    provider: "claudeAgent",
    time: "1d",
    state: "done",
    machine: "laptop",
    pr: { number: 211, state: "merged" },
  },
];
export const WORKING_THREADS: ReadonlyArray<ListThread> = [
  {
    title: "Map Stalled Orbit Threads and PRs",
    project: "apps",
    branch: "main",
    provider: "claudeAgent",
    time: "25m",
    state: "working",
    machine: "server",
    diff: { added: 17, removed: 0 },
  },
  {
    title: "Conn icons: superheroicons 16 solid",
    project: "conn",
    branch: "icons-16-solid",
    provider: "claudeAgent",
    time: "1h 9m",
    state: "working",
    machine: "laptop",
    pr: { number: 1940, state: "draft" },
    diff: { added: 1204, removed: 388 },
  },
];

export interface InsightCard {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly change: string | null;
  readonly tone: "good" | "bad" | "neutral";
  readonly down?: boolean;
  /** Sparkline points; null when the board sends no trend. */
  readonly trend: ReadonlyArray<number> | null;
}

export const INSIGHTS: ReadonlyArray<InsightCard> = [
  {
    id: "completed",
    label: "Tasks completed",
    value: "22",
    change: "+22%",
    tone: "good",
    trend: [2, 5, 7, 7, 6, 7, 5, 4, 6, 8, 9, 10, 8, 8, 10],
  },
  {
    id: "tokens",
    label: "Tokens spent",
    value: "942M",
    change: "+15%",
    tone: "neutral",
    trend: [30, 34, 33, 38, 41, 40, 44, 47, 46, 52, 55, 58, 61, 63, 66],
  },
  {
    id: "tokens-per-task",
    label: "Tokens per task",
    value: "42.8M",
    change: "−3%",
    tone: "neutral",
    down: true,
    trend: [10, 9, 9, 8, 8, 7, 7, 6, 6, 6, 5, 5, 4],
  },
  {
    id: "delivery",
    label: "Delivery time",
    value: "4h 12m",
    change: "−16%",
    tone: "good",
    down: true,
    trend: [6.1, 5.8, 6.0, 5.4, 5.2, 5.5, 4.9, 4.8, 4.6, 4.7, 4.4, 4.3, 4.2],
  },
  {
    id: "first-pass",
    label: "PR first pass",
    value: "58%",
    change: "+6 pts",
    tone: "good",
    trend: [49, 51, 50, 53, 52, 54, 55, 53, 56, 57, 56, 58],
  },
  {
    id: "merge-wait",
    label: "Merge wait",
    value: "38m",
    change: "−9%",
    tone: "good",
    down: true,
    trend: [52, 49, 50, 47, 46, 44, 45, 42, 41, 40, 39, 38],
  },
];

export interface TaskCardData {
  readonly id: number;
  readonly project: string;
  readonly title: string;
  readonly subtasks: string;
  readonly node: string;
  readonly time: string;
  readonly pr: { readonly number: number; readonly state: "open" | "merged" } | null;
  readonly dot: "working" | "waiting" | "done" | "failed";
}

export const TASKS: ReadonlyArray<TaskCardData> = [
  {
    id: 482,
    project: "Conn",
    title: "Image attachments in the composer",
    subtasks: "1/4",
    node: "beast",
    time: "52m",
    pr: { number: 1931, state: "open" },
    dot: "working",
  },
  {
    id: 479,
    project: "Conn",
    title: "Paste performance in long threads",
    subtasks: "1/3",
    node: "beast",
    time: "12m",
    pr: { number: 1928, state: "open" },
    dot: "working",
  },
  {
    id: 476,
    project: "Orbit",
    title: "Fix TLS renewal",
    subtasks: "2/2",
    node: "mini",
    time: "3m",
    pr: { number: 4812, state: "open" },
    dot: "waiting",
  },
  {
    id: 471,
    project: "Conn",
    title:
      "Show the agent's last message above the question so the user has the context to pick the right answer",
    subtasks: "3/5",
    node: "beast",
    time: "1h 24m",
    pr: { number: 1924, state: "open" },
    dot: "working",
  },
  {
    id: 468,
    project: "Orbit",
    title: "Retry the deploy step when the node is waking",
    subtasks: "0/3",
    node: "ci-sabre-1",
    time: "2h 5m",
    pr: null,
    dot: "failed",
  },
  {
    id: 465,
    project: "Hauzer",
    title: "Map view",
    subtasks: "4/4",
    node: "beast",
    time: "38m",
    pr: { number: 211, state: "merged" },
    dot: "done",
  },
  {
    id: 459,
    project: "Vault",
    title: "Sync conflict banner: keep both copies, and explain which device wrote the newer one",
    subtasks: "1/2",
    node: "mini",
    time: "9m",
    pr: null,
    dot: "working",
  },
];

/** 30 days of the chart card's line (Tasks completed). */
export const CHART_SERIES: ReadonlyArray<number> = [
  3, 4, 2, 5, 6, 4, 3, 5, 7, 6, 8, 5, 4, 6, 9, 8, 7, 6, 8, 10, 9, 7, 8, 11, 10, 9, 12, 10, 9, 11,
];
