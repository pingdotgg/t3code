import {
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  fyiShownState,
} from "@t3tools/contracts";

export interface FyiMarker {
  readonly label: "FYI · waiting" | "FYI · sent" | "FYI";
  readonly description: string;
}

const FYI_MARKERS: Record<ReturnType<typeof fyiShownState>, FyiMarker> = {
  waiting: {
    label: "FYI · waiting",
    description:
      "An agent's note for this thread. It started no turn. The agent gets it with its next turn; a running Claude Code thread gets it at its next tool call.",
  },
  sent: {
    label: "FYI · sent",
    description:
      "An agent's note for this thread. It went to the agent with the running turn. If that turn does not finish, the note waits for the next one.",
  },
  delivered: {
    label: "FYI",
    description: "An agent's note for this thread. The agent got it with a turn that finished.",
  },
  unknown: { label: "FYI", description: "An agent's note for this thread." },
};

export type FyiCarrierRun = Pick<OrchestrationV2Run, "status" | "rootNodeId">;

/** The marker on an agent's FYI message, in place of the steer marker. `run` is the run it names. */
export function resolveFyiMarker(
  item: OrchestrationV2TurnItem | undefined,
  run: FyiCarrierRun | undefined,
): FyiMarker | null {
  if (item?.type !== "user_message" || item.fyi !== true) return null;
  return FYI_MARKERS[fyiShownState(item, run)];
}

/** The runs that FYI items name. */
export function fyiRunIds(
  items: Iterable<OrchestrationV2TurnItem | undefined>,
): ReadonlySet<RunId> {
  const named = new Set<RunId>();
  for (const item of items) {
    if (item?.type === "user_message" && item.fyi === true && item.runId !== null) {
      named.add(item.runId);
    }
  }
  return named;
}

interface FyiCarrierRuns {
  readonly key: string;
  readonly runs: ReadonlyMap<RunId, FyiCarrierRun>;
}

const NO_FYI_CARRIERS: FyiCarrierRuns = { key: "", runs: new Map() };

/** The runs `fyiRunIds` named, and a key that changes only when one of them does. */
export function fyiCarrierRuns(
  runIds: ReadonlySet<RunId>,
  runs: ReadonlyArray<FyiCarrierRun & Pick<OrchestrationV2Run, "id">>,
): FyiCarrierRuns {
  if (runIds.size === 0) return NO_FYI_CARRIERS;
  const carriers = runs.filter((run) => runIds.has(run.id));
  return {
    key: carriers.map((run) => `${run.id}\0${run.status}\0${run.rootNodeId}`).join("\n"),
    runs: new Map(
      carriers.map((run) => [run.id, { status: run.status, rootNodeId: run.rootNodeId }]),
    ),
  };
}
