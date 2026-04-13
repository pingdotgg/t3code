import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

export type PerfSeedScenarioId = "large_threads" | "burst_base";
export type PerfProviderScenarioId = "dense_assistant_stream" | "parallel_assistant_stream";
export type PerfScenarioId = PerfSeedScenarioId | PerfProviderScenarioId;

export interface PerfProjectScenario {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceDirectoryName: string;
  readonly defaultModelSelection: ModelSelection;
}

export interface PerfSeedThreadScenario {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly category: "heavy" | "burst" | "light";
  readonly turnCount: number;
  readonly messageCount: number;
  readonly anchorMessageId: MessageId;
  readonly terminalMessageId: MessageId;
  readonly planStride: number | null;
  readonly activityStride: number | null;
  readonly diffStride: number | null;
}

export interface PerfSeedScenario {
  readonly id: PerfSeedScenarioId;
  readonly projects: ReadonlyArray<PerfProjectScenario>;
  readonly threads: ReadonlyArray<PerfSeedThreadScenario>;
}

export interface TimedFixtureProviderRuntimeEvent {
  readonly delayMs?: number;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
  readonly type: ProviderRuntimeEvent["type"];
  readonly itemId?: string;
  readonly requestId?: string;
  readonly payload: unknown;
}

export interface PerfProviderScenario {
  readonly id: PerfProviderScenarioId;
  readonly provider: ProviderKind;
  readonly sentinelText: string;
  readonly totalDurationMs: number;
  readonly events: ReadonlyArray<TimedFixtureProviderRuntimeEvent>;
}

const PERF_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};

const makeProjectId = (slug: string) => ProjectId.makeUnsafe(`perf-project-${slug}`);
const makeProject = (slug: string, title: string): PerfProjectScenario => ({
  id: makeProjectId(slug),
  title,
  workspaceDirectoryName: `perf-workspace-${slug}`,
  defaultModelSelection: PERF_MODEL_SELECTION,
});

const makeThreadId = (slug: string) => ThreadId.makeUnsafe(`perf-thread-${slug}`);
const makeTurnId = (threadSlug: string, index: number) =>
  TurnId.makeUnsafe(`perf-turn-${threadSlug}-${index.toString().padStart(4, "0")}`);
const makeMessageId = (
  threadSlug: string,
  role: "user" | "assistant",
  turnIndex: number,
  messageIndex = 1,
) =>
  MessageId.makeUnsafe(
    `perf-message-${threadSlug}-${role}-${turnIndex.toString().padStart(4, "0")}-${messageIndex.toString().padStart(2, "0")}`,
  );
const makeLiveTurnId = (slug: string) => TurnId.makeUnsafe(`perf-live-turn-${slug}`);
const makeLiveAssistantItemId = (
  laneKey: string,
  cycleIndex: number,
  segment: "intro" | "followup",
) => `perf-assistant-${laneKey}-${cycleIndex.toString().padStart(2, "0")}-${segment}`;
const makeLiveAssistantMessageId = (itemId: string) => MessageId.makeUnsafe(`assistant:${itemId}`);
const threadSlugFromId = (threadId: ThreadId) => threadId.replace("perf-thread-", "");

function threadSeedValue(threadSlug: string): number {
  return Array.from(threadSlug).reduce(
    (sum, character, index) => sum + character.charCodeAt(0) * (index + 1),
    0,
  );
}

function buildAssistantMessageCountPlan(
  input: Pick<PerfSeedThreadScenario, "category" | "turnCount" | "messageCount"> & {
    readonly threadSlug: string;
  },
): ReadonlyArray<number> {
  const assistantMessageCount = input.messageCount - input.turnCount;
  if (assistantMessageCount < input.turnCount) {
    throw new Error(
      `Perf thread '${input.threadSlug}' must retain at least one assistant message per turn.`,
    );
  }

  const averageAssistantMessages = Math.floor(assistantMessageCount / input.turnCount);
  const minPerTurn = Math.max(
    1,
    averageAssistantMessages -
      (input.category === "heavy" ? 4 : input.category === "burst" ? 2 : 1),
  );
  const residualAssistantMessages = assistantMessageCount - minPerTurn * input.turnCount;
  const threadSeed = threadSeedValue(input.threadSlug);
  const weights = Array.from({ length: input.turnCount }, (_, index) => {
    const burstBias = input.category === "heavy" && index % 9 === 0 ? 3 : index % 6 === 0 ? 1 : 0;
    return 1 + ((threadSeed + (index + 1) * 11) % 7) + burstBias;
  });
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const quotas = weights.map((weight) => (residualAssistantMessages * weight) / weightTotal);
  const counts = quotas.map((quota) => minPerTurn + Math.floor(quota));
  let remainingMessages = assistantMessageCount - counts.reduce((sum, count) => sum + count, 0);

  if (remainingMessages > 0) {
    const residualOrder = quotas
      .map((quota, index) => ({
        index,
        remainder: quota - Math.floor(quota),
      }))
      .toSorted((left, right) => right.remainder - left.remainder || right.index - left.index);

    for (let index = 0; index < residualOrder.length && remainingMessages > 0; index += 1) {
      const targetIndex = residualOrder[index]?.index;
      if (targetIndex === undefined) {
        break;
      }
      counts[targetIndex] = (counts[targetIndex] ?? minPerTurn) + 1;
      remainingMessages -= 1;
    }
  }

  return counts;
}

export function buildPerfAssistantMessageCountPlan(
  thread: Pick<PerfSeedThreadScenario, "id" | "category" | "turnCount" | "messageCount">,
): ReadonlyArray<number> {
  return buildAssistantMessageCountPlan({
    threadSlug: threadSlugFromId(thread.id),
    category: thread.category,
    turnCount: thread.turnCount,
    messageCount: thread.messageCount,
  });
}

function makeSeedThreadScenario(input: {
  readonly slug: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly category: PerfSeedThreadScenario["category"];
  readonly turnCount: number;
  readonly messageCount: number;
  readonly planStride: number | null;
  readonly activityStride: number | null;
  readonly diffStride: number | null;
}): PerfSeedThreadScenario {
  const assistantMessageCountPlan = buildAssistantMessageCountPlan({
    threadSlug: input.slug,
    category: input.category,
    turnCount: input.turnCount,
    messageCount: input.messageCount,
  });

  return {
    id: makeThreadId(input.slug),
    projectId: input.projectId,
    title: input.title,
    category: input.category,
    turnCount: input.turnCount,
    messageCount: input.messageCount,
    anchorMessageId: makeMessageId(input.slug, "user", 1, 1),
    terminalMessageId: makeMessageId(
      input.slug,
      "assistant",
      input.turnCount,
      assistantMessageCountPlan.at(-1) ?? 1,
    ),
    planStride: input.planStride,
    activityStride: input.activityStride,
    diffStride: input.diffStride,
  };
}

const PERF_PROJECTS = {
  inbox: makeProject("inbox", "Inbox Refactor Workspace"),
  desktop: makeProject("desktop", "Desktop Release Workspace"),
  runtime: makeProject("runtime", "Runtime Orchestration Workspace"),
  marketing: makeProject("marketing", "Marketing Site Workspace"),
  ops: makeProject("ops", "Ops Automation Workspace"),
  burstBase: makeProject("burst-base", "Burst Harness Workspace"),
} as const;

const PERF_PROVIDER_LIVE_TURNS = {
  navigation: makeLiveTurnId("navigation"),
  filler: makeLiveTurnId("filler"),
} as const;

const LARGE_THREAD_DEFINITIONS = {
  heavyA: makeSeedThreadScenario({
    slug: "heavy-a",
    projectId: PERF_PROJECTS.inbox.id,
    title: "Inbox Search Regression",
    category: "heavy",
    turnCount: 84,
    messageCount: 2_000,
    planStride: 11,
    activityStride: 4,
    diffStride: 3,
  }),
  heavyB: makeSeedThreadScenario({
    slug: "heavy-b",
    projectId: PERF_PROJECTS.desktop.id,
    title: "Desktop Update Rollout",
    category: "heavy",
    turnCount: 96,
    messageCount: 2_000,
    planStride: 12,
    activityStride: 5,
    diffStride: 4,
  }),
  burst: makeSeedThreadScenario({
    slug: "large-burst",
    projectId: PERF_PROJECTS.runtime.id,
    title: "Runtime Burst Coordination",
    category: "burst",
    turnCount: 48,
    messageCount: 640,
    planStride: 12,
    activityStride: 4,
    diffStride: 5,
  }),
} as const satisfies Record<string, PerfSeedThreadScenario>;

const LARGE_THREAD_LIGHT_LAYOUT = [
  {
    project: PERF_PROJECTS.inbox,
    label: "Inbox",
    count: 5,
  },
  {
    project: PERF_PROJECTS.desktop,
    label: "Desktop",
    count: 6,
  },
  {
    project: PERF_PROJECTS.runtime,
    label: "Runtime",
    count: 5,
  },
  {
    project: PERF_PROJECTS.marketing,
    label: "Marketing",
    count: 6,
  },
  {
    project: PERF_PROJECTS.ops,
    label: "Ops",
    count: 5,
  },
] as const;

const LARGE_THREAD_LIGHT_THREADS: ReadonlyArray<PerfSeedThreadScenario> =
  LARGE_THREAD_LIGHT_LAYOUT.flatMap((layout, projectIndex) =>
    Array.from({ length: layout.count }, (_, localIndex) => {
      const globalIndex =
        LARGE_THREAD_LIGHT_LAYOUT.slice(0, projectIndex).reduce(
          (sum, entry) => sum + entry.count,
          0,
        ) + localIndex;
      const threadNumber = localIndex + 1;
      const turnCount = 18 + ((globalIndex * 7 + projectIndex * 5 + localIndex * 3) % 8) * 7;
      const messageDensity = 4 + ((globalIndex + projectIndex + localIndex) % 5);
      const messageCount = Math.min(
        900,
        turnCount * messageDensity + 48 + ((globalIndex + projectIndex) % 5) * 18,
      );

      return makeSeedThreadScenario({
        slug: `${layout.label.toLowerCase()}-light-${threadNumber.toString().padStart(2, "0")}`,
        projectId: layout.project.id,
        title: `${layout.label} Thread ${threadNumber}`,
        category: "light",
        turnCount,
        messageCount,
        planStride: globalIndex % 4 === 0 ? 14 + ((globalIndex + localIndex) % 5) : null,
        activityStride: 5 + ((globalIndex + localIndex) % 4),
        diffStride: globalIndex % 3 === 0 ? 6 + ((projectIndex + localIndex) % 4) : null,
      });
    }),
  );

const BURST_BASE_THREAD_DEFINITIONS = {
  burst: makeSeedThreadScenario({
    slug: "burst",
    projectId: PERF_PROJECTS.burstBase.id,
    title: "Burst Target Thread",
    category: "burst",
    turnCount: 36,
    messageCount: 220,
    planStride: 12,
    activityStride: 4,
    diffStride: 6,
  }),
  navigation: makeSeedThreadScenario({
    slug: "burst-navigation",
    projectId: PERF_PROJECTS.burstBase.id,
    title: "Burst Navigation Thread",
    category: "light",
    turnCount: 28,
    messageCount: 112,
    planStride: null,
    activityStride: 5,
    diffStride: null,
  }),
  filler: makeSeedThreadScenario({
    slug: "burst-filler",
    projectId: PERF_PROJECTS.burstBase.id,
    title: "Burst Filler Thread",
    category: "light",
    turnCount: 24,
    messageCount: 96,
    planStride: null,
    activityStride: 6,
    diffStride: null,
  }),
} as const satisfies Record<string, PerfSeedThreadScenario>;

const BURST_NAVIGATION_THREAD = BURST_BASE_THREAD_DEFINITIONS.navigation;
const BURST_FILLER_THREAD = BURST_BASE_THREAD_DEFINITIONS.filler;

export const PERF_SEED_SCENARIOS = {
  large_threads: {
    id: "large_threads",
    projects: [
      PERF_PROJECTS.inbox,
      PERF_PROJECTS.desktop,
      PERF_PROJECTS.runtime,
      PERF_PROJECTS.marketing,
      PERF_PROJECTS.ops,
    ],
    threads: [
      LARGE_THREAD_DEFINITIONS.heavyA,
      LARGE_THREAD_DEFINITIONS.heavyB,
      LARGE_THREAD_DEFINITIONS.burst,
      ...LARGE_THREAD_LIGHT_THREADS,
    ],
  },
  burst_base: {
    id: "burst_base",
    projects: [PERF_PROJECTS.burstBase],
    threads: [BURST_BASE_THREAD_DEFINITIONS.burst, BURST_NAVIGATION_THREAD, BURST_FILLER_THREAD],
  },
} as const satisfies Record<PerfSeedScenarioId, PerfSeedScenario>;

const DENSE_ASSISTANT_STREAM_SENTINEL = "PERF_STREAM_SENTINEL:dense_assistant_stream:completed";
const DENSE_ASSISTANT_STREAM_CYCLE_COUNT = 24;
const DENSE_ASSISTANT_STREAM_CYCLE_INTERVAL_MS = 520;
const DENSE_ASSISTANT_STREAM_LANE_STAGGER_MS = 12;
const DENSE_ASSISTANT_STREAM_TURN_COMPLETION_GAP_MS = 36;
const DENSE_ASSISTANT_STREAM_WORKLOG_ITEMS_PER_CYCLE = 3;
const DENSE_ASSISTANT_STREAM_MESSAGE_FRAGMENT_GAP_MS = 24;
const DENSE_ASSISTANT_STREAM_MESSAGE_COMPLETION_GAP_MS = 28;
const DENSE_ASSISTANT_STREAM_WORKLOG_STARTED_GAP_MS = 20;
const DENSE_ASSISTANT_STREAM_WORKLOG_UPDATED_GAP_MS = 24;
const DENSE_ASSISTANT_STREAM_WORKLOG_COMPLETED_GAP_MS = 28;
const DENSE_ASSISTANT_STREAM_WORKLOG_GROUP_GAP_MS = 12;
const PARALLEL_ASSISTANT_STREAM_SENTINEL =
  "PERF_STREAM_SENTINEL:parallel_assistant_stream:completed";
const PARALLEL_ASSISTANT_STREAM_FRAGMENT_COUNT = 240;
const PARALLEL_ASSISTANT_STREAM_FRAGMENT_GAP_MS = 24;
const PARALLEL_ASSISTANT_STREAM_COMPLETION_GAP_MS = 48;

type DenseAssistantStreamLaneKey = "burst" | "navigation" | "filler";

interface DenseAssistantStreamLane {
  readonly key: DenseAssistantStreamLaneKey;
  readonly title: string;
  readonly threadId?: ThreadId;
  readonly turnId?: TurnId;
}

const DENSE_ASSISTANT_STREAM_LANES: ReadonlyArray<DenseAssistantStreamLane> = [
  {
    key: "burst",
    title: "Burst thread",
  },
  {
    key: "navigation",
    title: "Navigation thread",
    threadId: BURST_NAVIGATION_THREAD.id,
    turnId: PERF_PROVIDER_LIVE_TURNS.navigation,
  },
  {
    key: "filler",
    title: "Filler thread",
    threadId: BURST_FILLER_THREAD.id,
    turnId: PERF_PROVIDER_LIVE_TURNS.filler,
  },
];

type DenseAssistantSegment = ReadonlyArray<string>;

interface DenseAssistantToolSpec {
  readonly title: string;
  readonly detail: string;
  readonly command: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

type DenseAssistantSegmentStage = "intro" | "followup";

function denseAssistantLaneSeed(laneKey: DenseAssistantStreamLaneKey): number {
  switch (laneKey) {
    case "burst":
      return 3;
    case "navigation":
      return 7;
    case "filler":
      return 11;
  }
}

function buildDenseAssistantSegmentVariation(
  laneKey: DenseAssistantStreamLaneKey,
  cycleIndex: number,
  stage: DenseAssistantSegmentStage,
  baseSegment: readonly [string, string],
): DenseAssistantSegment {
  const seed = denseAssistantLaneSeed(laneKey) + cycleIndex * 5 + (stage === "followup" ? 2 : 0);
  const fragments: string[] = [baseSegment[0]];

  if (laneKey === "burst") {
    if (seed % 2 === 0) {
      fragments.push(
        "I am keeping the reducer hot path narrow so the live burst still feels incremental. ",
      );
    }
    if (seed % 5 === 0) {
      fragments.push(
        "The queue still has enough buffered work to show whether the main thread starts to fan out. ",
      );
    }
  } else if (laneKey === "navigation") {
    if (seed % 2 !== 0) {
      fragments.push(
        "This pass is deliberately touching selection state, unread counts, and sidebar summaries at the same time. ",
      );
    }
    if (seed % 4 === 0) {
      fragments.push(
        "I want route updates to land while the burst thread keeps painting without forcing a reset. ",
      );
    }
  } else {
    if (seed % 3 !== 0) {
      fragments.push(
        "Hidden threads are still taking background work here so the test is not accidentally single-threaded. ",
      );
    }
    if (seed % 5 === 1) {
      fragments.push(
        "The background file tree is large enough that badge and projection churn should stay visible in the worklog. ",
      );
    }
  }

  if (stage === "followup" && seed % 3 === 0) {
    fragments.push(
      "I am holding the rest of the queue steady until this narrower update settles cleanly. ",
    );
  }

  fragments.push(baseSegment[1]);
  return fragments;
}

function joinDenseAssistantSegment(segment: DenseAssistantSegment): string {
  return segment.join("").trim();
}

function mutateDenseAssistantFilePath(filePath: string, salt: number): string {
  return filePath.replace(/\.(tsx?)$/, `.${(salt % 4) + 1}.$1`);
}

function selectDenseAssistantFiles(
  baseFiles: ReadonlyArray<string>,
  cycleIndex: number,
  toolIndex: number,
  baseCount: number,
): ReadonlyArray<string> {
  const count = Math.min(baseFiles.length, baseCount + ((cycleIndex + toolIndex) % 3));
  const startIndex = (cycleIndex * 2 + toolIndex * 3) % baseFiles.length;
  return Array.from({ length: count }, (_, index) => {
    const baseFile = baseFiles[(startIndex + index) % baseFiles.length]!;
    return index % 2 === 0
      ? baseFile
      : mutateDenseAssistantFilePath(baseFile, cycleIndex + toolIndex + index);
  });
}

function buildDenseAssistantIntroSegment(
  laneKey: DenseAssistantStreamLaneKey,
  cycleIndex: number,
): DenseAssistantSegment {
  const pass = cycleIndex + 1;

  if (laneKey === "burst") {
    switch (cycleIndex % 4) {
      case 0:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Reviewing websocket burst slice ${pass} and checking the render queue. `,
          "I am about to patch the hottest reducer path before the next flush. ",
        ]);
      case 1:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Re-reading the active thread around viewport checkpoint ${pass}. `,
          "I want the next command to touch the rows that are actually visible. ",
        ]);
      case 2:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Inspecting the event fan-out for burst batch ${pass}. `,
          "The next command should trim duplicate projections before they hit React. ",
        ]);
      default:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Checking the optimistic state that landed after websocket batch ${pass}. `,
          "I am lining up another targeted update instead of doing a full recompute. ",
        ]);
    }
  }

  if (laneKey === "navigation") {
    switch (cycleIndex % 3) {
      case 0:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Navigation lane is reconciling sidebar counts for pass ${pass}. `,
          "I am checking whether the selected thread can stay interactive during the burst. ",
        ]);
      case 1:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Navigation lane is refreshing route state for pass ${pass}. `,
          "The next command is scoped to sidebar metadata and unread markers. ",
        ]);
      default:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
          `Navigation lane is merging background thread summaries for pass ${pass}. `,
          "I am verifying that thread switches stay cheap while other turns keep moving. ",
        ]);
    }
  }

  switch (cycleIndex % 3) {
    case 0:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
        `Filler lane is compacting idle thread state for pass ${pass}. `,
        "I am keeping background reconciliation active so the burst is not single-threaded. ",
      ]);
    case 1:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
        `Filler lane is reconciling file tree badges for pass ${pass}. `,
        "The next command updates background state without stealing focus from the active lane. ",
      ]);
    default:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "intro", [
        `Filler lane is sweeping deferred projections for pass ${pass}. `,
        "I am checking that hidden threads can absorb more websocket traffic without stalling. ",
      ]);
  }
}

function buildDenseAssistantFollowupSegment(
  laneKey: DenseAssistantStreamLaneKey,
  cycleIndex: number,
  cycleCount: number,
): DenseAssistantSegment {
  const pass = cycleIndex + 1;
  const isLastCycle = cycleIndex === cycleCount - 1;

  if (laneKey === "burst") {
    if (isLastCycle) {
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
        "Applied the last reducer update and finished the visible-thread verification pass. ",
        `Streaming workload drained cleanly. ${DENSE_ASSISTANT_STREAM_SENTINEL}`,
      ]);
    }
    switch (cycleIndex % 4) {
      case 0:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Queued the reducer patch for burst slice ${pass}. `,
          "The viewport stayed responsive, so I am moving straight to the next live diff. ",
        ]);
      case 1:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Patched the visible rows touched by burst slice ${pass}. `,
          "I can keep streaming without forcing a full timeline rebuild. ",
        ]);
      case 2:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Folded the duplicate projection work produced by burst slice ${pass}. `,
          "The next command will keep pressure on the event path instead of idling. ",
        ]);
      default:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Settled the optimistic state from burst slice ${pass}. `,
          "I am continuing with another narrow update while background threads keep progressing. ",
        ]);
    }
  }

  if (laneKey === "navigation") {
    if (isLastCycle) {
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
        "Navigation lane finished its background reconciliation pass. ",
        "Thread switching stayed live while the burst completed. ",
      ]);
    }
    switch (cycleIndex % 3) {
      case 0:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Navigation lane merged sidebar counters for pass ${pass}. `,
          "Selection state still looks stable under concurrent updates. ",
        ]);
      case 1:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Navigation lane applied the route metadata refresh for pass ${pass}. `,
          "Unread state is still moving without forcing a navigation reset. ",
        ]);
      default:
        return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
          `Navigation lane committed background thread summaries for pass ${pass}. `,
          "The sidebar stayed interactive while the active turn kept streaming. ",
        ]);
    }
  }

  if (isLastCycle) {
    return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
      "Filler lane finished compacting deferred background work. ",
      "Hidden threads stayed caught up through the end of the websocket burst. ",
    ]);
  }
  switch (cycleIndex % 3) {
    case 0:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
        `Filler lane compacted idle thread state for pass ${pass}. `,
        "Background threads are still accepting updates without starving the visible thread. ",
      ]);
    case 1:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
        `Filler lane refreshed file tree badges for pass ${pass}. `,
        "The background projection load stayed incremental instead of spiking. ",
      ]);
    default:
      return buildDenseAssistantSegmentVariation(laneKey, cycleIndex, "followup", [
        `Filler lane drained deferred projections for pass ${pass}. `,
        "There is still enough background traffic here to catch cross-thread regressions. ",
      ]);
  }
}

function buildDenseAssistantToolSpec(
  laneKey: DenseAssistantStreamLaneKey,
  cycleIndex: number,
  toolIndex: number,
): DenseAssistantToolSpec {
  const pass = cycleIndex + 1;

  if (laneKey === "burst") {
    const files = selectDenseAssistantFiles(
      [
        "apps/web/src/store.ts",
        "apps/web/src/session-logic.ts",
        "apps/web/src/components/chat/MessagesTimeline.tsx",
        "apps/web/src/components/ChatView.tsx",
        "apps/web/src/lib/providerReactQuery.ts",
        "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
        "apps/server/src/wsServer.ts",
        "packages/shared/src/perf/scenarioCatalog.ts",
        "apps/web/src/components/sidebar/ThreadList.tsx",
        "apps/server/src/orchestration/Layers/ProjectionPipeline.ts",
      ],
      cycleIndex,
      toolIndex,
      5,
    );

    switch (toolIndex) {
      case 0:
        return {
          title: `Burst thread scan ${pass}`,
          detail: `Scanned reducer fan-out and live queue pressure for websocket batch ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=burst",
            `--batch=${pass}`,
            "--step=scan",
            "--touch=queue,projection",
          ],
          files,
        };
      case 1:
        return {
          title: `Burst thread patch ${pass}`,
          detail: `Patched the visible reducer path and timeline projection for websocket batch ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=burst",
            `--batch=${pass}`,
            "--step=patch",
            "--touch=render,store",
          ],
          files,
        };
      default:
        return {
          title: `Burst thread verify ${pass}`,
          detail: `Verified viewport stability and render cadence after websocket batch ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=burst",
            `--batch=${pass}`,
            "--step=verify",
            "--touch=viewport,metrics",
          ],
          files,
        };
    }
  }

  if (laneKey === "navigation") {
    const files = selectDenseAssistantFiles(
      [
        "apps/web/src/components/sidebar/ThreadList.tsx",
        "apps/web/src/components/sidebar/ProjectSidebar.tsx",
        "apps/web/src/routes/threadRoute.ts",
        "apps/web/src/store.ts",
        "apps/web/src/session-logic.ts",
        "apps/server/src/wsServer.ts",
        "apps/web/src/components/ChatView.tsx",
        "apps/web/src/lib/providerReactQuery.ts",
      ],
      cycleIndex,
      toolIndex,
      4,
    );

    switch (toolIndex) {
      case 0:
        return {
          title: `Navigation thread sync ${pass}`,
          detail: `Synced route metadata and selected-thread state for navigation pass ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=navigation",
            `--batch=${pass}`,
            "--step=sync",
            "--touch=route,selection",
          ],
          files,
        };
      case 1:
        return {
          title: `Navigation thread merge ${pass}`,
          detail: `Merged sidebar counters, unread markers, and project summaries for pass ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=navigation",
            `--batch=${pass}`,
            "--step=merge",
            "--touch=sidebar,unread",
          ],
          files,
        };
      default:
        return {
          title: `Navigation thread settle ${pass}`,
          detail: `Settled thread-list focus state and background summaries for navigation pass ${pass}.`,
          command: [
            "bun",
            "x",
            "perf-loop",
            "--lane=navigation",
            `--batch=${pass}`,
            "--step=settle",
            "--touch=focus,summary",
          ],
          files,
        };
    }
  }

  const files = selectDenseAssistantFiles(
    [
      "apps/web/src/store.ts",
      "apps/web/src/components/chat/MessagesTimeline.tsx",
      "apps/web/src/components/ChatView.tsx",
      "apps/server/src/orchestration/Layers/ProjectionPipeline.ts",
      "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts",
      "packages/shared/src/perf/scenarioCatalog.ts",
      "apps/web/src/components/sidebar/ThreadList.tsx",
      "apps/server/src/wsServer.ts",
    ],
    cycleIndex,
    toolIndex,
    4,
  );

  switch (toolIndex) {
    case 0:
      return {
        title: `Filler thread compact ${pass}`,
        detail: `Compacted deferred background projections and idle thread state for pass ${pass}.`,
        command: [
          "bun",
          "x",
          "perf-loop",
          "--lane=filler",
          `--batch=${pass}`,
          "--step=compact",
          "--touch=background,projection",
        ],
        files,
      };
    case 1:
      return {
        title: `Filler thread refresh ${pass}`,
        detail: `Refreshed background file tree badges and hidden-thread summaries for pass ${pass}.`,
        command: [
          "bun",
          "x",
          "perf-loop",
          "--lane=filler",
          `--batch=${pass}`,
          "--step=refresh",
          "--touch=file-tree,badges",
        ],
        files,
      };
    default:
      return {
        title: `Filler thread drain ${pass}`,
        detail: `Drained deferred background churn without stealing focus from the visible thread on pass ${pass}.`,
        command: [
          "bun",
          "x",
          "perf-loop",
          "--lane=filler",
          `--batch=${pass}`,
          "--step=drain",
          "--touch=background,queue",
        ],
        files,
      };
  }
}

function buildDenseAssistantToolPayload(
  toolSpec: DenseAssistantToolSpec,
  cycleIndex: number,
  toolIndex: number,
) {
  const files = toolSpec.files.map((filePath, fileIndex) => ({
    path: filePath,
    status:
      (fileIndex + cycleIndex + toolIndex) % 4 === 0
        ? "modified"
        : (fileIndex + cycleIndex + toolIndex) % 4 === 1
          ? "added"
          : (fileIndex + cycleIndex + toolIndex) % 4 === 2
            ? "deleted"
            : "renamed",
    additions: 8 + fileIndex * 3 + toolIndex * 2,
    deletions: 2 + fileIndex + (cycleIndex % 3),
  }));

  return {
    command: toolSpec.command,
    item: {
      command: toolSpec.command,
      input: {
        command: toolSpec.command,
      },
      result: {
        command: toolSpec.command,
        exitCode: 0,
        files,
      },
    },
    files,
    operations: files.map((file) => ({
      type: file.status,
      path: file.path,
    })),
  };
}

function buildLaneScope(lane: DenseAssistantStreamLane) {
  return {
    ...(lane.threadId ? { threadId: lane.threadId } : {}),
    ...(lane.turnId ? { turnId: lane.turnId } : {}),
  } as const;
}

function buildDenseAssistantStreamScenario(): PerfProviderScenario {
  const events: TimedFixtureProviderRuntimeEvent[] = [];
  const cycleCount = DENSE_ASSISTANT_STREAM_CYCLE_COUNT;
  const finalCycleStartMs = DENSE_ASSISTANT_STREAM_CYCLE_INTERVAL_MS * (cycleCount - 1);
  let maxCycleEventOffsetMs = 0;

  DENSE_ASSISTANT_STREAM_LANES.forEach((lane, laneIndex) => {
    events.push({
      delayMs: laneIndex,
      ...buildLaneScope(lane),
      type: "turn.started",
      payload: {
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
    });
  });

  for (let cycleIndex = 0; cycleIndex < cycleCount; cycleIndex += 1) {
    const cycleOffsetMs = cycleIndex * DENSE_ASSISTANT_STREAM_CYCLE_INTERVAL_MS;

    DENSE_ASSISTANT_STREAM_LANES.forEach((lane, laneIndex) => {
      const laneScope = buildLaneScope(lane);
      const laneOffsetMs = laneIndex * DENSE_ASSISTANT_STREAM_LANE_STAGGER_MS;
      const introItemId = makeLiveAssistantItemId(lane.key, cycleIndex, "intro");
      const followupItemId = makeLiveAssistantItemId(lane.key, cycleIndex, "followup");
      const introSegment = buildDenseAssistantIntroSegment(lane.key, cycleIndex);
      const followupSegment = buildDenseAssistantFollowupSegment(lane.key, cycleIndex, cycleCount);
      let laneEventOffsetMs = 4;

      for (const fragment of introSegment) {
        events.push({
          delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
          ...laneScope,
          type: "content.delta",
          itemId: introItemId,
          payload: {
            streamKind: "assistant_text",
            delta: fragment,
          },
        });
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_MESSAGE_FRAGMENT_GAP_MS;
      }

      events.push({
        delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
        ...laneScope,
        type: "item.completed",
        itemId: introItemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: joinDenseAssistantSegment(introSegment),
        },
      });
      laneEventOffsetMs += DENSE_ASSISTANT_STREAM_MESSAGE_COMPLETION_GAP_MS;

      for (
        let toolIndex = 0;
        toolIndex < DENSE_ASSISTANT_STREAM_WORKLOG_ITEMS_PER_CYCLE;
        toolIndex += 1
      ) {
        const toolItemId = `perf-command-${lane.key}-${cycleIndex.toString().padStart(3, "0")}-${toolIndex.toString().padStart(2, "0")}`;
        const toolSpec = buildDenseAssistantToolSpec(lane.key, cycleIndex, toolIndex);
        const toolPayload = buildDenseAssistantToolPayload(toolSpec, cycleIndex, toolIndex);

        events.push({
          delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
          ...laneScope,
          type: "item.started",
          itemId: toolItemId,
          payload: {
            itemType: "command_execution",
            title: toolSpec.title,
            detail: toolSpec.detail,
          },
        });
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_WORKLOG_STARTED_GAP_MS;

        events.push({
          delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
          ...laneScope,
          type: "item.updated",
          itemId: toolItemId,
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: toolSpec.title,
            detail: toolSpec.detail,
            data: toolPayload,
          },
        });
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_WORKLOG_UPDATED_GAP_MS;

        events.push({
          delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
          ...laneScope,
          type: "item.completed",
          itemId: toolItemId,
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: toolSpec.title,
            detail: toolSpec.detail,
            data: toolPayload,
          },
        });
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_WORKLOG_COMPLETED_GAP_MS;
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_WORKLOG_GROUP_GAP_MS;
      }

      for (const fragment of followupSegment) {
        events.push({
          delayMs: cycleOffsetMs + laneOffsetMs + laneEventOffsetMs,
          ...laneScope,
          type: "content.delta",
          itemId: followupItemId,
          payload: {
            streamKind: "assistant_text",
            delta: fragment,
          },
        });
        laneEventOffsetMs += DENSE_ASSISTANT_STREAM_MESSAGE_FRAGMENT_GAP_MS;
      }

      const followupCompletionDelayMs = cycleOffsetMs + laneOffsetMs + laneEventOffsetMs;
      events.push({
        delayMs: followupCompletionDelayMs,
        ...laneScope,
        type: "item.completed",
        itemId: followupItemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: joinDenseAssistantSegment(followupSegment),
        },
      });
      maxCycleEventOffsetMs = Math.max(maxCycleEventOffsetMs, laneOffsetMs + laneEventOffsetMs);
    });
  }

  const finalLaneRunStartMs = finalCycleStartMs + maxCycleEventOffsetMs;
  const totalDurationMs =
    finalLaneRunStartMs +
    (DENSE_ASSISTANT_STREAM_LANES.length - 1) * DENSE_ASSISTANT_STREAM_TURN_COMPLETION_GAP_MS;

  DENSE_ASSISTANT_STREAM_LANES.forEach((lane, laneIndex) => {
    events.push({
      delayMs: finalLaneRunStartMs + laneIndex * DENSE_ASSISTANT_STREAM_TURN_COMPLETION_GAP_MS,
      ...buildLaneScope(lane),
      type: "turn.completed",
      payload: {
        state: "completed",
      },
    });
  });

  return {
    id: "dense_assistant_stream",
    provider: "codex",
    sentinelText: DENSE_ASSISTANT_STREAM_SENTINEL,
    totalDurationMs,
    events,
  };
}

function buildParallelAssistantStreamScenario(): PerfProviderScenario {
  const events: Array<TimedFixtureProviderRuntimeEvent> = [
    {
      delayMs: 0,
      type: "turn.started",
      payload: {
        model: "gpt-5.4",
      },
    },
  ];

  let delayMs = 0;
  for (
    let fragmentIndex = 0;
    fragmentIndex < PARALLEL_ASSISTANT_STREAM_FRAGMENT_COUNT;
    fragmentIndex += 1
  ) {
    delayMs += PARALLEL_ASSISTANT_STREAM_FRAGMENT_GAP_MS;
    const isFinalFragment = fragmentIndex === PARALLEL_ASSISTANT_STREAM_FRAGMENT_COUNT - 1;
    const cycleLabel = fragmentIndex.toString().padStart(3, "0");
    const delta = isFinalFragment
      ? `parallel-cycle-${cycleLabel} ${PARALLEL_ASSISTANT_STREAM_SENTINEL}`
      : `parallel-cycle-${cycleLabel} keeping provider ingestion and projection busy. `;

    events.push({
      delayMs,
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta,
      },
    });
  }

  delayMs += PARALLEL_ASSISTANT_STREAM_COMPLETION_GAP_MS;
  events.push({
    delayMs,
    type: "turn.completed",
    payload: {
      state: "completed",
    },
  });

  return {
    id: "parallel_assistant_stream",
    provider: "codex",
    sentinelText: PARALLEL_ASSISTANT_STREAM_SENTINEL,
    totalDurationMs: delayMs,
    events,
  };
}

export const PERF_PROVIDER_SCENARIOS = {
  dense_assistant_stream: buildDenseAssistantStreamScenario(),
  parallel_assistant_stream: buildParallelAssistantStreamScenario(),
} as const satisfies Record<PerfProviderScenarioId, PerfProviderScenario>;

export const PERF_CATALOG_IDS = {
  projectId: PERF_PROJECTS.inbox.id,
  largeThreads: {
    heavyAThreadId: LARGE_THREAD_DEFINITIONS.heavyA.id,
    heavyBThreadId: LARGE_THREAD_DEFINITIONS.heavyB.id,
    heavyAProjectId: LARGE_THREAD_DEFINITIONS.heavyA.projectId,
    heavyBProjectId: LARGE_THREAD_DEFINITIONS.heavyB.projectId,
    heavyAProjectTitle: PERF_PROJECTS.inbox.title,
    heavyBProjectTitle: PERF_PROJECTS.desktop.title,
    heavyAAnchorMessageId: LARGE_THREAD_DEFINITIONS.heavyA.anchorMessageId,
    heavyBAnchorMessageId: LARGE_THREAD_DEFINITIONS.heavyB.anchorMessageId,
    heavyATerminalMessageId: LARGE_THREAD_DEFINITIONS.heavyA.terminalMessageId,
    heavyBTerminalMessageId: LARGE_THREAD_DEFINITIONS.heavyB.terminalMessageId,
  },
  burstBase: {
    burstProjectId: PERF_PROJECTS.burstBase.id,
    burstProjectTitle: PERF_PROJECTS.burstBase.title,
    burstThreadId: BURST_BASE_THREAD_DEFINITIONS.burst.id,
    burstAnchorMessageId: BURST_BASE_THREAD_DEFINITIONS.burst.anchorMessageId,
    burstTerminalMessageId: BURST_BASE_THREAD_DEFINITIONS.burst.terminalMessageId,
    navigationThreadId: BURST_NAVIGATION_THREAD.id,
    navigationAnchorMessageId: BURST_NAVIGATION_THREAD.anchorMessageId,
    navigationTerminalMessageId: BURST_NAVIGATION_THREAD.terminalMessageId,
    fillerThreadId: BURST_FILLER_THREAD.id,
  },
  provider: {
    denseAssistantStreamSentinel: DENSE_ASSISTANT_STREAM_SENTINEL,
    parallelAssistantStreamSentinel: PARALLEL_ASSISTANT_STREAM_SENTINEL,
    navigationLiveTurnId: PERF_PROVIDER_LIVE_TURNS.navigation,
    fillerLiveTurnId: PERF_PROVIDER_LIVE_TURNS.filler,
    navigationLiveAssistantMessageId: makeLiveAssistantMessageId(
      makeLiveAssistantItemId("navigation", 1, "followup"),
    ),
    burstLiveAssistantMessageId: makeLiveAssistantMessageId(
      makeLiveAssistantItemId("burst", 2, "intro"),
    ),
    fillerLiveAssistantMessageId: makeLiveAssistantMessageId(
      makeLiveAssistantItemId("filler", 1, "followup"),
    ),
  },
} as const;

export function getPerfSeedScenario(scenarioId: PerfSeedScenarioId): PerfSeedScenario {
  return PERF_SEED_SCENARIOS[scenarioId];
}

export function getPerfProviderScenario(scenarioId: PerfProviderScenarioId): PerfProviderScenario {
  return PERF_PROVIDER_SCENARIOS[scenarioId];
}

export function perfTurnIdForThread(thread: PerfSeedThreadScenario, turnIndex: number): TurnId {
  const threadSlug = threadSlugFromId(thread.id);
  return makeTurnId(threadSlug, turnIndex);
}

export function perfMessageIdForThread(
  thread: PerfSeedThreadScenario,
  role: "user" | "assistant",
  turnIndex: number,
  messageIndex = 1,
): MessageId {
  const threadSlug = threadSlugFromId(thread.id);
  return makeMessageId(threadSlug, role, turnIndex, messageIndex);
}

export function perfEventId(prefix: string, threadId: ThreadId, index: number) {
  return EventId.makeUnsafe(`${prefix}:${threadId}:${index.toString().padStart(4, "0")}`);
}
