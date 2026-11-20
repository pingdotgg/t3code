/* oxlint-disable t3code/no-untranslated-copy -- fixture data in the Gateway's wire form, never shown in a release build */
import type { OrbitGatewayTransport } from "@t3tools/client-runtime/orbit-gateway";

// Design and screenshot data only, in the Gateway's wire form so it runs through the real decoder.
// It mirrors the approved mobile mockup. Only development builds with EXPO_PUBLIC_CONN_TASKS_FIXTURE=1 use it.

const ENV = "a5bf17aa-d514-4c78-a644-edf55dba343f";
const MINUTE = 60_000;

type SubStatus = "todo" | "running" | "reviewing" | "completed" | "failed";
type AgentState = "idle" | "working" | "asking_for_input" | "done" | "failed";

interface FixtureSubtask {
  id: number;
  title: string;
  status: SubStatus;
  brief: string;
  deliverables: string[];
  minutes?: number;
  tokens?: number;
}

interface FixtureAgent {
  id: number;
  role: "implementer" | "reviewer";
  subtasks: number[];
  state: AgentState;
  /** How long ago the agent started. */
  startedMinutesAgo: number;
}

interface FixtureTask {
  id: number;
  title: string;
  status: string;
  workspace: string | null;
  branch?: string;
  node: string;
  updatedMinutesAgo: number;
  brief: string;
  pr?: { number: number; state: "open" | "merged" | "closed" };
  minutes?: number;
  tokens?: number;
  lines?: [number, number];
  shared?: true;
  subtasks: FixtureSubtask[];
  agents: FixtureAgent[];
}

const TASK_BRIEF = `Let users attach images to a message in the composer, on desktop and iOS.

## Outcome
A user can paste, drop or pick an image. It shows as a chip above the input, and it is sent with the message to providers that accept images.

## Constraints
- Respect each provider's size and type limits before upload; never send a file the provider will reject.
- Keep the composer responsive. Large images get a thumbnail, not a full decode on the main thread.
- Attachments belong to the draft and survive switching threads.

## Out of scope
Video, PDFs, and editing images inside Conn.

## Notes for implementers
Start from the existing file attachment path; do not add a second upload pipeline. Chips use the composer's existing control sizes.

Providers differ: some accept images only on certain models. Show that before the user sends, not as an error afterwards.

Leave a short summary in each subtask thread when done, and list the files you touched. The reviewer reads those summaries first.`;

const CHIPS_BRIEF = `Show attached images as chips above the composer input.

Each chip shows a thumbnail, the file name and a remove button. Chips wrap to a second line before they push the input down.

### Acceptance
1. Chips use the composer's existing control height and radius.
2. A chip for an image the selected model cannot accept shows a warning and a reason on hover.
3. Removing a chip never moves focus out of the input.
4. Drafts keep their chips when the user switches threads and returns.

### Edge cases
- Ten or more images: the row scrolls sideways inside the composer.
- Very large files: show the chip at once with a placeholder, then the thumbnail.
- The model changes after attaching: re-check every chip.

### Hand-off
Add browser tests for adding, removing and the unsupported-model warning.`;

const upcoming = (id: number, title: string, brief: string, deliverables: string[]) => ({
  id,
  title,
  status: "todo" as const,
  brief,
  deliverables,
});

const TASKS: ReadonlyArray<FixtureTask> = [
  {
    id: 482,
    title: "Image attachments in the composer",
    status: "reviewing",
    workspace: "conn-attachments",
    branch: "orbit/482-image-attachments",
    node: "beast",
    updatedMinutesAgo: 0,
    brief: TASK_BRIEF,
    pr: { number: 1931, state: "open" },
    minutes: 52,
    tokens: 1_800_000,
    lines: [842, 113],
    subtasks: [
      {
        id: 483,
        title: "Upload limits per provider",
        status: "completed",
        brief:
          "List image size, type and model limits for each provider adapter, and expose them to the client so the composer can check before upload.",
        deliverables: ["Limits per provider", "Client-side check"],
        minutes: 12,
        tokens: 280_000,
      },
      {
        id: 484,
        title: "Attachment chips in the composer",
        status: "running",
        brief: CHIPS_BRIEF,
        deliverables: [
          "Chip row in the composer",
          "Unsupported-model warning",
          "Browser tests for add and remove",
        ],
        minutes: 21,
        tokens: 640_000,
      },
      upcoming(
        485,
        "Paste and drop handling",
        "Accept images from paste and drag and drop anywhere over the chat, and route them into the draft's attachments.",
        ["Paste handler", "Drop target over the chat"],
      ),
      upcoming(
        486,
        "iOS photo picker",
        "Add the system photo picker to the iOS composer and reuse the shared attachment state from client-runtime.",
        ["Photo picker button", "Shared attachment state"],
      ),
    ],
    agents: [
      { id: 4821, role: "implementer", subtasks: [483], state: "done", startedMinutesAgo: 52 },
      { id: 4822, role: "implementer", subtasks: [484], state: "idle", startedMinutesAgo: 40 },
      { id: 4823, role: "reviewer", subtasks: [], state: "working", startedMinutesAgo: 3 },
    ],
  },
  {
    id: 479,
    title: "Paste performance in long threads",
    status: "running",
    workspace: "conn-paste-perf",
    branch: "orbit/479-paste-performance",
    node: "beast",
    updatedMinutesAgo: 3,
    brief:
      "Pasting into a long thread stalls the composer. Find the cause and keep paste under one frame.",
    pr: { number: 1928, state: "open" },
    minutes: 12,
    tokens: 310_000,
    lines: [46, 12],
    shared: true,
    subtasks: [
      {
        id: 480,
        title: "Profile paste in a 2,000-message thread",
        status: "completed",
        brief: "Record a profile and name the slow call.",
        deliverables: ["Profile notes"],
        minutes: 8,
        tokens: 180_000,
      },
      {
        id: 481,
        title: "Defer draft persistence",
        status: "running",
        brief: "Write the draft after the frame, not during paste.",
        deliverables: ["Deferred write", "Regression test"],
        minutes: 4,
        tokens: 130_000,
      },
      upcoming(
        497,
        "Measure paste again in the same thread",
        "Repeat the profile after the fix and compare.",
        ["Before and after numbers"],
      ),
    ],
    agents: [
      {
        id: 4791,
        role: "implementer",
        subtasks: [480, 481, 497],
        state: "working",
        startedMinutesAgo: 12,
      },
    ],
  },
  {
    id: 474,
    title: "Restore desktop tabs after restart",
    status: "todo",
    workspace: null,
    node: "mini",
    updatedMinutesAgo: 60,
    brief: "Reopen the preview tabs a user had open when the desktop app restarts.",
    subtasks: [
      upcoming(475, "Persist open tabs", "Save tab URLs per window.", ["Tab store"]),
      upcoming(476, "Reopen on launch", "Restore tabs before first paint.", ["Launch restore"]),
    ],
    agents: [],
  },
  {
    id: 487,
    title: "Voice input on iOS",
    status: "todo",
    workspace: null,
    node: "beast",
    updatedMinutesAgo: 5,
    brief:
      "Add push-to-talk voice input to the iOS composer. Starts after the attachments task lands, because both change the composer toolbar.",
    subtasks: [
      upcoming(
        488,
        "Speech permission flow",
        "Ask for microphone and speech permission on first use.",
        ["Permission prompt"],
      ),
      upcoming(489, "Push-to-talk button", "Hold to record; release to insert the text.", [
        "Composer button",
      ]),
    ],
    agents: [],
  },
  {
    id: 498,
    title: "Jump to an Orbit task from the command palette",
    status: "backlog",
    workspace: null,
    node: "beast",
    updatedMinutesAgo: 3 * 24 * 60,
    brief: "Type a task number or title in the command palette to open it in the Tasks panel.",
    subtasks: [
      upcoming(499, "Index tasks for the palette", "Search tasks by number and title.", [
        "Palette source",
      ]),
    ],
    agents: [],
  },
  {
    id: 500,
    title: "Drop images from Finder onto a thread",
    status: "backlog",
    workspace: null,
    node: "beast",
    updatedMinutesAgo: 7 * 24 * 60,
    brief: "Dropping image files anywhere on a thread attaches them to the draft.",
    subtasks: [],
    agents: [],
  },
  {
    id: 471,
    title: "Lineage row spacing audit",
    status: "completed",
    workspace: "conn-lineage-audit",
    node: "beast",
    updatedMinutesAgo: 2 * 24 * 60,
    brief: "Audit lineage rows against the 32px row rule.",
    pr: { number: 1904, state: "merged" },
    minutes: 10,
    tokens: 280_000,
    lines: [38, 41],
    subtasks: [
      {
        id: 472,
        title: "Audit and fix",
        status: "completed",
        brief: "Audit.",
        deliverables: ["PR"],
        minutes: 7,
        tokens: 190_000,
      },
    ],
    agents: [
      { id: 4711, role: "implementer", subtasks: [472], state: "done", startedMinutesAgo: 2900 },
      { id: 4712, role: "reviewer", subtasks: [], state: "done", startedMinutesAgo: 2890 },
    ],
  },
];

const ago = (now: number, minutes: number) => new Date(now - minutes * MINUTE).toISOString();

function wireTask(task: FixtureTask, now: number) {
  const count = (status: SubStatus) => task.subtasks.filter((sub) => sub.status === status).length;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    attention: null,
    project: { id: 78, slug: "conn", name: "Conn", code: "CON" },
    workspace:
      task.workspace === null
        ? null
        : {
            instance_id: 3000 + task.id,
            name: task.workspace,
            status: "active",
            power_state: "running",
            node: { id: 9, name: task.node },
            branch: task.branch ?? `orbit/${task.id}-${task.workspace.replace(/^conn-/, "")}`,
            conn_environment_id: ENV,
          },
    pull_request: task.pr
      ? { ...task.pr, url: `https://github.com/nckrtl/conn/pull/${task.pr.number}` }
      : null,
    subtask_counts: {
      total: task.subtasks.length,
      todo: count("todo"),
      running: count("running") + count("reviewing"),
      completed: count("completed"),
      failed: count("failed"),
      cancelled: 0,
    },
    created_at: ago(now, task.updatedMinutesAgo + 60),
    updated_at: ago(now, task.updatedMinutesAgo),
    last_activity_at: task.status === "backlog" ? null : ago(now, task.updatedMinutesAgo),
  };
}

function wireDetail(task: FixtureTask, now: number) {
  const implementerOf = (subtaskId: number) =>
    task.agents.find((agent) => agent.role === "implementer" && agent.subtasks.includes(subtaskId))
      ?.id ?? null;
  return {
    ...wireTask(task, now),
    brief: task.brief,
    execution: { implementer_mode: task.shared ? "shared" : "per_subtask" },
    metrics: {
      duration_ms: task.minutes === undefined ? null : task.minutes * MINUTE,
      tokens: task.tokens ?? null,
      lines_added: task.lines?.[0] ?? null,
      lines_deleted: task.lines?.[1] ?? null,
    },
    subtasks: task.subtasks.map((sub, index) => ({
      id: sub.id,
      position: index + 1,
      title: sub.title,
      brief: sub.brief,
      deliverables: sub.deliverables.map((description, item) => ({
        id: `d${item + 1}`,
        type: "artifact",
        description,
      })),
      status: sub.status,
      attention: null,
      current_implementer_agent_id: sub.status === "todo" ? null : implementerOf(sub.id),
      metrics: {
        duration_ms: sub.minutes === undefined ? null : sub.minutes * MINUTE,
        tokens: sub.tokens ?? null,
        lines_added: null,
        lines_deleted: null,
      },
    })),
    agents: task.agents.map((agent) => ({
      id: agent.id,
      role: agent.role,
      subtask_ids: agent.subtasks,
      current: true,
      attempt: 1,
      provider: agent.role === "reviewer" ? "claude" : "codex",
      model: agent.role === "reviewer" ? "Claude Opus 5.5" : "GPT-5.5 Codex",
      effort: "medium",
      state: agent.state,
      needs_input: agent.state === "asking_for_input",
      created_at: ago(now, agent.startedMinutesAgo),
      observed_at: ago(now, 0),
      conn: { environment_id: ENV, thread_id: `orbit-${agent.id}` },
    })),
  };
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

/** A Gateway transport that answers the two Conn Tasks routes from the mockup's data. */
const DAY = 24 * 60 * MINUTE;

/**
 * The board's numbers, as Orbit's `task-insights` would send them. Merge wait stays out: it needs
 * the PR's opened time (Orbit 6042), so the strip shows its dash.
 */
function wireInsights(now: number) {
  const merges = [
    0, 1, 0, 2, 1, 0, 0, 1, 1, 0, 2, 0, 1, 0, 1, 0, 0, 1, 2, 0, 1, 1, 0, 1, 0, 2, 1, 0, 1, 1,
  ];
  const day = (index: number) => new Date(now - (29 - index) * DAY).toISOString().slice(0, 10);
  return {
    data: {
      period: "30d",
      current: {
        tasks: 27,
        merged: 22,
        tokens: 941_600_000,
        tokens_per_merged_pr: 42_800_000,
        lead_time_ms: 15_120_000,
        pr_first_pass: 0.58,
        wasted_share: 0.18,
        review_rounds: 1.6,
      },
      previous: {
        tasks: 24,
        merged: 18,
        tokens: 820_000_000,
        tokens_per_merged_pr: 45_600_000,
        lead_time_ms: 18_000_000,
        pr_first_pass: 0.52,
        wasted_share: 0.21,
        review_rounds: 1.8,
      },
      weekly: [51.2, 47.9, 44.1, 42.8].map((millions, index) => ({
        week_start: day(index * 7),
        tokens_per_merged_pr: millions * 1_000_000,
      })),
      daily: merges.map((merged, index) => ({ date: day(index), merged })),
      breakdowns: {
        model: [
          {
            key: "gpt-5.5-codex",
            label: "GPT-5.5 Codex",
            tasks: 14,
            merged: 13,
            tokens_per_merged_pr: 39_000_000,
            lead_time_ms: 13_500_000,
          },
          {
            key: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            tasks: 10,
            merged: 7,
            tokens_per_merged_pr: 48_000_000,
            lead_time_ms: 18_000_000,
          },
          {
            key: "gemini-3-pro",
            label: "Gemini 3 Pro",
            tasks: 3,
            merged: 2,
            tokens_per_merged_pr: 50_000_000,
            lead_time_ms: 16_000_000,
          },
        ],
      },
    },
  };
}

/**
 * Lab only: a series for every number the Gateway reports no history for, so each card in the
 * lab has a sparkline (the mobile lab's trends). Values are in the insight's raw unit.
 */
const LAB_TRENDS: Readonly<Record<string, ReadonlyArray<number>>> = {
  spent: [30, 34, 33, 38, 41, 40, 44, 47, 46, 52, 55, 58, 61, 63, 66].map((n) => n * 1_000_000),
  wasted: [0.24, 0.25, 0.23, 0.22, 0.23, 0.21, 0.2, 0.21, 0.2, 0.19, 0.19, 0.18, 0.19, 0.18, 0.18],
  delivery: [6.1, 5.8, 6.0, 5.4, 5.2, 5.5, 4.9, 4.8, 4.6, 4.7, 4.4, 4.3, 4.2].map(
    (hours) => hours * 3_600_000,
  ),
  firstPass: [49, 51, 50, 53, 52, 54, 55, 53, 56, 57, 56, 58].map((n) => n / 100),
  mergeWait: [52, 49, 50, 47, 46, 44, 45, 42, 41, 40, 39, 38].map((minutes) => minutes * 60_000),
  reviewRounds: [2.1, 2.0, 2.0, 1.9, 1.9, 1.8, 1.8, 1.7, 1.7, 1.7, 1.6, 1.6, 1.6],
};

export function fixtureInsightTrend(id: string, now: number) {
  const values = LAB_TRENDS[id];
  if (!values) return null;
  return values.map((value, index) => ({
    date: new Date(now - (values.length - 1 - index) * 2 * DAY).toISOString().slice(0, 10),
    value,
  }));
}

/**
 * The Gateway as fixtures. `insights: "unhandled"` answers the board's numbers the way the live
 * Gateway does until Orbit 6040, so the strip shows its dashes.
 */
export function fixtureOrbitTasksTransport(
  options: { readonly insights?: "fixture" | "unhandled" } = {},
): OrbitGatewayTransport {
  return async (request) => {
    const now = Date.now();
    if (request.path === "/task-insights")
      return options.insights === "unhandled"
        ? json(500, {
            status: 500,
            error: { code: "gateway.unhandled", message: "Not completed.", details: {} },
          })
        : json(200, wireInsights(now));
    if (request.path === "/tasks" && Number(request.query?.limit ?? 0) > 100)
      return json(422, {
        status: 422,
        error: { code: "validation.failed", message: "limit must be at most 100.", details: {} },
      });
    if (request.path === "/tasks")
      return json(200, {
        data: TASKS.map((task) => wireTask(task, now)),
        meta: { next_cursor: null },
      });
    const id = Number(/^\/tasks\/(\d+)$/.exec(request.path)?.[1]);
    const task = TASKS.find((entry) => entry.id === id);
    return task
      ? json(200, { data: wireDetail(task, now) })
      : json(404, { status: 404, error: { code: "http.404", message: "Not found.", details: {} } });
  };
}
