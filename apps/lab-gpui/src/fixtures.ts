// Lab data. Each thread starts from a test/fakeEnvironment.ts fixture with its own title;
// swap or add freely.
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  assistantItem,
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  threadWithHistory,
  threadWithQuestion,
  type FakeThread,
} from "../../web/test/fakeEnvironment";
import phoneScreenshotPath from "./phone-screenshot.png";

// Markdown drops data: URLs, so the tall phone screenshot (390x844) is an absolute URL Vite serves.
const LAB_PHONE_SCREENSHOT = new URL(phoneScreenshotPath, window.location.origin).href;

const titled = (thread: FakeThread, title: string): FakeThread => ({ ...thread, title });

// The subagent turn started a few minutes before the page opened, so its timers read naturally.
const minutesAgo = (minutes: number) => DateTime.makeUnsafe(Date.now() - minutes * 60_000);

interface SubagentSpec {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly result?: string;
  readonly progress?: string;
  readonly startedMinutesAgo: number;
  readonly endedMinutesAgo?: number;
  readonly model?: ModelSelection;
}

const CODEX_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
};
const CLAUDE_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};

/**
 * A turn that hands work to delegated tasks, so the chat shows its inline subagent cards. One
 * task is a lone card; two or more are a group whose expanded rows are the same cards.
 */
function threadWithSubagentSpecs(name: string, specs: ReadonlyArray<SubagentSpec>): FakeThread {
  const thread = threadWithHistory(name, 1);
  const runId = thread.runs[0]!.id;
  const [user] = thread.items;
  const at = minutesAgo(Math.max(...specs.map((spec) => spec.startedMinutesAgo)));
  const modelOf = (spec: SubagentSpec) => spec.model ?? CODEX_MODEL;
  const items = specs.map((spec, index): OrchestrationV2TurnItem => {
    const model = modelOf(spec);
    return {
      id: TurnItemId.make(`${name}-${spec.id}`),
      threadId: thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 2,
      status: spec.status,
      title: spec.title,
      startedAt: minutesAgo(spec.startedMinutesAgo),
      completedAt: spec.endedMinutesAgo === undefined ? null : minutesAgo(spec.endedMinutesAgo),
      updatedAt: minutesAgo(spec.endedMinutesAgo ?? spec.startedMinutesAgo),
      type: "subagent",
      subagentId: NodeId.make(`${name}-${spec.id}`),
      origin: "provider_native",
      driver: ProviderDriverKind.make(model === CLAUDE_MODEL ? "claudeAgent" : "codex"),
      providerInstanceId: model.instanceId,
      childThreadId: null,
      prompt: spec.prompt,
      result: spec.result ?? null,
    };
  });
  const subagents = specs.map((spec) => {
    const model = modelOf(spec);
    return {
      id: NodeId.make(`${name}-${spec.id}`),
      threadId: thread.id,
      runId,
      parentNodeId: NodeId.make(`${name}-root`),
      origin: "provider_native" as const,
      createdBy: "agent" as const,
      driver: ProviderDriverKind.make(model === CLAUDE_MODEL ? "claudeAgent" : "codex"),
      providerInstanceId: model.instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: spec.prompt,
      title: spec.title,
      model: model.model,
      modelSelection: model,
      status: spec.status,
      ...(spec.progress === undefined ? {} : { progress: spec.progress }),
      result: spec.result ?? null,
      startedAt: minutesAgo(spec.startedMinutesAgo),
      completedAt: spec.endedMinutesAgo === undefined ? null : minutesAgo(spec.endedMinutesAgo),
      updatedAt: minutesAgo(spec.endedMinutesAgo ?? spec.startedMinutesAgo),
    };
  });
  return {
    ...thread,
    runs: thread.runs.map((run) => ({
      ...run,
      status: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
    })),
    subagents,
    items: [
      {
        ...user!,
        text: "Review the Tasks board polish and check both themes.",
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      } as OrchestrationV2TurnItem,
      {
        ...assistantItem(
          thread.id,
          runId,
          `${name}-intro`,
          1,
          "I'll hand this to delegated tasks and report back when they finish.",
        ),
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      },
      ...items,
    ],
  };
}

const threadWithSubagents = (name: string) =>
  threadWithSubagentSpecs(name, [
    {
      id: "lanes",
      title: "Review the Tasks board lanes",
      prompt:
        "Review the Tasks board lanes: spacing, lane titles and hidden scrollbars, in dark and light.",
      status: "completed",
      result:
        "Lanes look right: 8px around and between lanes, titles 8px from the top and the first card, no visible scrollbars.",
      startedMinutesAgo: 6,
      endedMinutesAgo: 2,
    },
    {
      id: "insights",
      title: "Check the insight cards",
      prompt:
        "Check the insight cards: corner radius toward neighbours, lit top border, chart tooltip.",
      status: "running",
      startedMinutesAgo: 63,
      model: CLAUDE_MODEL,
    },
  ]);

/** One delegated task on its own: the lone inline card. */
const threadWithOneSubagent = (name: string) =>
  threadWithSubagentSpecs(name, [
    {
      id: "icons",
      title: "Conn icons: superheroicons 16 solid",
      prompt: "Switch the Conn icon set to the superheroicons 16 solid family.",
      status: "running",
      startedMinutesAgo: 63,
      model: CLAUDE_MODEL,
    },
  ]);

/** Every state a delegated task card shows, in one group. */
const threadWithSubagentStates = (name: string) =>
  threadWithSubagentSpecs(name, [
    {
      id: "running",
      title: "Conn icons: superheroicons 16 solid",
      prompt: "Switch the icon set.",
      status: "running",
      startedMinutesAgo: 63,
      model: CLAUDE_MODEL,
    },
    {
      id: "done",
      title: "Review the Tasks board lanes",
      prompt: "Review the lanes.",
      status: "completed",
      result: "Lanes look right: 8px around and between lanes, no visible scrollbars.",
      startedMinutesAgo: 90,
      endedMinutesAgo: 47,
    },
    {
      id: "failed",
      title: "Run the web typecheck",
      prompt: "Typecheck apps/web.",
      status: "failed",
      result: "Typecheck stopped: 3 errors in TimelineTaskReceipt.tsx.",
      startedMinutesAgo: 30,
      endedMinutesAgo: 26,
      model: CLAUDE_MODEL,
    },
    {
      id: "stopped",
      title: "Capture the dark theme",
      prompt: "Capture the board in dark.",
      status: "cancelled",
      startedMinutesAgo: 12,
      endedMinutesAgo: 10,
    },
    {
      id: "waiting",
      title: "Pick the insight card radius",
      prompt: "Pick a radius.",
      status: "waiting",
      progress: "Waiting for your answer on the radius.",
      startedMinutesAgo: 5,
    },
  ]);

/**
 * A turn where the agent hands work to Orbit: each orbit `task-create` call shows as a task
 * receipt card, and the thread details list the tasks. The results are the Gateway's JSON at
 * creation (todo, nothing started); the cards then read the Tasks fixtures' live state.
 */
function threadWithOrbitTask(name: string): FakeThread {
  const thread = threadWithHistory(name, 1);
  const runId = thread.runs[0]!.id;
  const [user, assistant] = thread.items;
  const at = (minutesAgo: number) => DateTime.makeUnsafe(Date.now() - minutesAgo * 60_000);
  const stamp = (item: OrchestrationV2TurnItem, minutesAgo: number) =>
    ({
      ...item,
      startedAt: at(minutesAgo),
      completedAt: at(minutesAgo),
      updatedAt: at(minutesAgo),
    }) as OrchestrationV2TurnItem;
  const now = new Date().toISOString();
  const taskCreate = (
    ordinal: number,
    id: string,
    task: { id: number; title: string; subtasks: string[] },
  ) => {
    const subtasks = task.subtasks.map((title, index) => ({
      id: task.id + index + 1,
      position: index + 1,
      title,
      status: "todo",
    }));
    const result = {
      data: {
        id: task.id,
        title: task.title,
        status: "todo",
        attention: null,
        project: { id: 78, slug: "conn", name: "Conn", code: "CON" },
        workspace: null,
        pull_request: null,
        subtask_counts: {
          total: subtasks.length,
          todo: subtasks.length,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
        created_at: now,
        updated_at: now,
        last_activity_at: null,
        subtasks,
      },
      meta: { request_id: `req_${id}` },
    };
    return stamp(
      {
        ...assistant!,
        id: TurnItemId.make(`${name}-${id}`),
        ordinal,
        title: null,
        type: "dynamic_tool",
        toolName: "mcp__orbit__task-create",
        input: {
          project: 78,
          title: task.title,
          subtasks: task.subtasks.map((title) => ({ title })),
        },
        output: JSON.stringify(result),
      } as unknown as OrchestrationV2TurnItem,
      2,
    );
  };
  return {
    ...thread,
    items: [
      stamp(
        {
          ...user!,
          text: "Hand the image attachments and the thread search work to Orbit.",
        } as OrchestrationV2TurnItem,
        3,
      ),
      stamp(
        assistantItem(
          thread.id,
          runId,
          `${name}-intro`,
          1,
          "I'll create two Orbit tasks, one per feature.",
        ),
        3,
      ),
      taskCreate(2, "task-create-482", {
        id: 482,
        title: "Image attachments in the composer",
        subtasks: [
          "Upload limits per provider",
          "Attachment chips in the composer",
          "Paste and drop handling",
          "iOS photo picker",
        ],
      }),
      taskCreate(3, "task-create-470", {
        id: 470,
        title: "Thread search across environments",
        subtasks: [
          "Search index per environment",
          "Merge results in the sidebar",
          "Jump to a match",
        ],
      }),
      stamp(
        assistantItem(
          thread.id,
          runId,
          `${name}-outro`,
          4,
          "Both tasks are in Orbit. Open one to follow its subtasks.",
        ),
        2,
      ),
    ],
  };
}

/** An assistant reply with an inline markdown image (a tall phone screenshot). */
function threadWithInlineImage(name: string): FakeThread {
  const thread = threadWithHistory(name, 1);
  const runId = thread.runs[0]!.id;
  const [user] = thread.items;
  const at = minutesAgo(3);
  const stamp = (item: OrchestrationV2TurnItem) =>
    ({ ...item, startedAt: at, completedAt: at, updatedAt: at }) as OrchestrationV2TurnItem;
  return {
    ...thread,
    items: [
      stamp({ ...user!, text: "Show me the thread list on the phone." } as OrchestrationV2TurnItem),
      stamp(
        assistantItem(
          thread.id,
          runId,
          `${name}-reply`,
          1,
          `Code block lab:\n\n\`\`\`ts\nconst median = sorted[Math.floor(sorted.length / 2)];\nexport const releaseEvery = "hour";\n\`\`\`\n\nA long line:\n\n\`\`\`bash\ncurl -sS -X POST https://gateway.orbit.example/api/v1/instances/4812/deploy -H "Authorization: Bearer $ORBIT_TOKEN" -d '{"ref":"main","wait":true}'\n\`\`\`\n\nNo language:\n\n\`\`\`\nCI median: 24 min\nauto-release: hourly\n\`\`\`\n\nHere is the thread list as it looks on the phone now:\n\n![Thread list on iPhone](${LAB_PHONE_SCREENSHOT})\n\nThe stalled threads sit at the top.`,
        ),
      ),
    ],
  };
}

/** A pending three-question set after a long agent message, to review the question panel. */
function threadWithQuestionFlow(name: string): FakeThread {
  const thread = threadWithQuestion(name, "Which tests should I run?");
  const context = [
    "I found the flakiness. Two of the sync tests share one in-memory clock, so a slow CI runner lets the first test advance time under the second.",
    "",
    "- **Fix the clock only:** small and safe, but the other two shared-state tests stay flaky.",
    "- **Isolate each test:** removes the whole class of failure, with a slower suite as the trade-off.",
    "- Skip the three flaky tests: fastest, but it hides the real bug.",
    "",
    "Before I change anything I need to know how much of the suite to run afterwards, and where it has to pass.",
  ].join("\n");
  return {
    ...thread,
    items: thread.items.map((item) => {
      if (item.type === "assistant_message")
        return { ...item, text: context } as OrchestrationV2TurnItem;
      if (item.type !== "user_input_request") return item;
      return {
        ...item,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which tests should I run?",
            required: true,
            allowCustomAnswer: true,
            options: [
              {
                label: "The sync suite only (Recommended)",
                value: "sync",
                description: "About 40 seconds on CI.",
              },
              {
                label: "The full suite",
                value: "full",
                description: "Everything, about 9 minutes.",
              },
              {
                label: "Only the three flaky tests",
                value: "flaky",
                description: "Fast, but it can miss a neighbour.",
              },
            ],
          },
          {
            id: "platforms",
            header: "Platforms",
            question: "Where does it have to pass?",
            required: true,
            allowCustomAnswer: true,
            multiSelect: true,
            options: [
              { label: "Web", value: "web", description: "Chromium on the CI runner." },
              { label: "Desktop", value: "desktop", description: "Electron on macOS." },
              { label: "Mobile", value: "mobile", description: "The iOS simulator in nick-vm." },
            ],
          },
          {
            id: "docs",
            header: "Docs",
            question: "Should I also update the testing guide?",
            required: true,
            allowCustomAnswer: true,
            options: [
              { label: "Yes", value: "yes", description: "Add a note about the shared clock." },
              { label: "No", value: "no", description: "Leave the docs alone." },
            ],
          },
        ],
      } as OrchestrationV2TurnItem;
    }),
  };
}

// Projects the sidebar groups threads under. Icons follow the project icon setting: a lucide
// glyph with a colour, or a monogram.
const APPS = ProjectId.make("project-apps");
const APPS_MONOGRAM = ProjectId.make("project-apps-monogram");
const ORBIT = ProjectId.make("project-orbit");
const CONN = ProjectId.make("project-conn");

const CLAUDE: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
  options: [{ id: "effort", value: "medium" }],
};
const CODEX_ID = ProviderInstanceId.make("codex");

/** Every shell timestamp reads `minutes` ago, so the row shows "4m" or "1h" next to now. */
function recency(minutes: number): Partial<OrchestrationV2ThreadShell> {
  const at = DateTime.makeUnsafe(Date.now() - minutes * 60_000);
  return {
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    lastVisitedAt: DateTime.makeUnsafe(Date.now()),
  };
}

/** `count` linked pull requests on separate branches, so the row shows one "+count" badge. */
function linkedPullRequests(
  repository: string,
  count: number,
  state: "open" | "merged",
): ThreadPullRequestLink[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const number = 100 + index;
    return {
      host: "github.com",
      repository,
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      source: "agent",
      linkedAt: now,
      snapshot: {
        state: index === 0 ? state : "merged",
        title: `Lab pull request ${number}`,
        headBranch: `lab/pr-${number}`,
        baseBranch: "main",
        isDraft: false,
        updatedAt: now,
        syncedAt: now,
      },
      stack: null,
    } as ThreadPullRequestLink;
  });
}

/** A thread in one of Nick's projects: status, time, linked PRs and providers as the shell reports them. */
function lane(
  name: string,
  title: string,
  projectId: ProjectId,
  options: {
    readonly minutes: number;
    readonly waiting?: boolean;
    readonly branch?: string | null;
    readonly pullRequests?: ThreadPullRequestLink[];
    readonly model?: ModelSelection;
    readonly history?: ReadonlyArray<ProviderInstanceId>;
    readonly subagents?: number;
    readonly order: string;
  },
): FakeThread {
  const model = options.model ?? CLAUDE;
  const thread = titled(threadWithHistory(name, 2, model), title);
  return {
    ...thread,
    shell: {
      projectId,
      branch: options.branch ?? null,
      ...recency(options.minutes),
      ...(options.waiting ? { status: "idle" as const } : {}),
      ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
      ...(options.history ? { providerInstanceHistory: options.history } : {}),
      ...(options.subagents ? { subagentCount: options.subagents } : {}),
      activeOrderKey: options.order,
    },
  };
}

/** The shell's subagent count for a thread whose fixture carries subagent records, as the server reports it. */
function withSubagentCount(thread: FakeThread): FakeThread {
  const count = thread.subagents?.length ?? 0;
  return count === 0 ? thread : { ...thread, shell: { ...thread.shell, subagentCount: count } };
}

/** Existing lab threads keep their content; they sit in realistic projects with recent times. */
function inProject(
  thread: FakeThread,
  projectId: ProjectId,
  minutes: number,
  order: string,
): FakeThread {
  return {
    ...thread,
    shell: { projectId, branch: "main", ...recency(minutes), activeOrderKey: order },
  };
}

/** One finished turn with both cards: a delegated agent, then an Orbit task, so they can be compared. */
function threadWithAgentAndTask(name: string): FakeThread {
  const agent = threadWithOneSubagent(name);
  const orbit = threadWithOrbitTask(name);
  const runId = agent.runs[0]!.id;
  const at = (minutes: number) => minutesAgo(minutes);
  const stamp = (item: OrchestrationV2TurnItem, ordinal: number, minutes: number) =>
    ({
      ...item,
      threadId: agent.id,
      runId,
      ordinal,
      startedAt: at(minutes),
      completedAt: at(minutes),
      updatedAt: at(minutes),
    }) as OrchestrationV2TurnItem;
  const [user, , subagent] = agent.items;
  const task = orbit.items.find((item) => item.id === `${name}-task-create-482`)!;
  return {
    ...agent,
    runs: agent.runs.map((run) => ({
      ...run,
      status: "completed",
      requestedAt: at(12),
      startedAt: at(12),
      completedAt: at(2),
    })),
    items: [
      stamp(
        {
          ...user!,
          text: "Switch the icon set, and hand image attachments to Orbit.",
        } as OrchestrationV2TurnItem,
        0,
        12,
      ),
      stamp(
        {
          ...task,
          id: TurnItemId.make(`${name}-read`),
          toolName: "Read",
          input: { file_path: "apps/web/src/components/Icons.tsx" },
          output: "ok",
        } as OrchestrationV2TurnItem,
        1,
        11,
      ),
      stamp(subagent!, 2, 10),
      stamp(task, 3, 9),
      stamp(
        assistantItem(
          agent.id,
          runId,
          `${name}-outro`,
          4,
          "The agent is switching the icons, and the attachments task is in Orbit.",
        ),
        4,
        2,
      ),
    ],
  };
}

export const LAB_THREADS: ReadonlyArray<FakeThread> = [
  inProject(
    titled(threadWithOrbitTask("orbit-task-receipt"), "Hand two features to Orbit"),
    CONN,
    200,
    "b1",
  ),
  withSubagentCount(
    inProject(
      titled(threadWithAgentAndTask("agent-and-task"), "Agent card and task card"),
      CONN,
      190,
      "b0",
    ),
  ),
  withSubagentCount(
    inProject(
      titled(threadWithSubagents("subagent-review"), "Review the board with subagents"),
      CONN,
      230,
      "b2",
    ),
  ),
  withSubagentCount(
    inProject(
      titled(threadWithOneSubagent("subagent-single"), "Hand the icon switch to a subagent"),
      CONN,
      235,
      "b3",
    ),
  ),
  withSubagentCount(
    inProject(
      titled(threadWithSubagentStates("subagent-states"), "Every subagent card state"),
      CONN,
      240,
      "b4",
    ),
  ),
  // Nick's sidebar, top to bottom.
  lane("heroicons-lucide", "Expand Heroicons with Lucide Designs", APPS, {
    minutes: 4,
    waiting: true,
    branch: "heroicons-lucide",
    subagents: 3,
    order: "a1",
  }),
  lane("ingress-node", "Plan a dedicated ingress Node in front of the fleet", APPS_MONOGRAM, {
    minutes: 62,
    pullRequests: linkedPullRequests("nckrtl/apps", 4, "merged"),
    order: "a2",
  }),
  lane("orbit-task-delivery", "Improve Orbit Task Delivery Speed", APPS, {
    minutes: 13,
    waiting: true,
    pullRequests: linkedPullRequests("nckrtl/apps", 11, "merged"),
    order: "a3",
  }),
  lane("orbit-workers", "Move Orbit Workers to Target Nodes", APPS, {
    minutes: 125,
    pullRequests: linkedPullRequests("nckrtl/apps", 6, "merged"),
    subagents: 12,
    order: "a4",
  }),
  lane("stalled-threads", "Map Stalled Orbit Threads and PRs", APPS_MONOGRAM, {
    minutes: 1,
    waiting: true,
    pullRequests: linkedPullRequests("nckrtl/apps", 3, "merged"),
    history: [CODEX_ID],
    order: "a5",
  }),
  lane("dlf-backlog", "dlf-leden backlog: one Orbit task per item", ORBIT, {
    minutes: 33,
    pullRequests: linkedPullRequests("hardimpactdev/orbit", 19, "open"),
    order: "a6",
  }),
  inProject(
    titled(threadWithHistory("image-attachments", 6), "Plan image attachments in the composer"),
    CONN,
    300,
    "b3",
  ),
  inProject(
    titled(threadWithHistory("tasks-board-polish", 4), "Tasks board polish, round 2"),
    CONN,
    420,
    "b4",
  ),
  inProject(
    titled(threadWithQuestionFlow("question-flow"), "Choose how to fix the clock"),
    CONN,
    650,
    "b5a",
  ),
  inProject(
    titled(
      threadWithQuestion("flaky-sync-tests", "Which tests should I run?"),
      "Fix the flaky sync tests",
    ),
    CONN,
    600,
    "b5",
  ),
  inProject(
    titled(threadWithHistory("insights-memory", 3), "Gateway task insights runs out of memory"),
    CONN,
    800,
    "b6",
  ),
  inProject(
    titled(threadWithInlineImage("inline-image"), "Inline image in a reply"),
    CONN,
    900,
    "b7",
  ),
];

/** Both providers, so rows can show the Claude and OpenAI logos. */
/** Claude with a reasoning-effort option, so the thread hover card shows "Opus 4.6 · Medium". */
const LAB_CLAUDE_PROVIDER = {
  ...CLAUDE_PROVIDER,
  models: CLAUDE_PROVIDER.models.map((model) => ({
    ...model,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ],
    },
  })),
};
export const LAB_PROVIDERS = [CODEX_PROVIDER, LAB_CLAUDE_PROVIDER];

const repository = (owner: string, name: string) => ({
  canonicalKey: `github.com/${owner}/${name}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/${owner}/${name}.git`,
  },
  webUrl: `https://github.com/${owner}/${name}`,
  provider: "github",
  owner,
  name,
  displayName: `${owner}/${name}`,
});

/** Conn itself, so task PRs (github.com/nckrtl/conn) open in the PR panel; plus Nick's own projects. */
export const LAB_PROJECTS = [
  { id: CONN, title: "conn", repositoryIdentity: repository("nckrtl", "conn") },
  {
    id: APPS,
    title: "apps",
    workspaceRoot: "/workspace/apps",
    projectIcon: { kind: "lucide", name: "lightbulb", color: "yellow" },
  },
  {
    id: APPS_MONOGRAM,
    title: "apps",
    workspaceRoot: "/workspace/apps-monogram",
    projectIcon: { kind: "monogram", text: "AS", color: "amber" },
  },
  {
    id: ORBIT,
    title: "hardimpactdev/orbit",
    repositoryIdentity: repository("hardimpactdev", "orbit"),
    projectIcon: { kind: "monogram", text: "DT", color: "purple" },
  },
] as never;
