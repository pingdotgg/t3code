import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import {
  isTerminalAgentAwarenessPhase,
  projectThreadAwareness,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";

const MAX_ACTIVITY_ROWS = 3;

function statusForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: AgentAwarenessState): RelayAgentActivityAggregateRow {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

export function buildLocalAgentActivityAggregate(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): RelayAgentActivityAggregateState | null {
  const projectsByKey = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const activeStates: AgentAwarenessState[] = [];

  for (const thread of input.threads) {
    const project = projectsByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (!project) {
      continue;
    }
    const awareness = projectThreadAwareness({
      environmentId: thread.environmentId,
      project,
      thread,
    });
    if (awareness && !isTerminalAgentAwarenessPhase(awareness.phase)) {
      activeStates.push(awareness);
    }
  }

  if (activeStates.length === 0) {
    return null;
  }

  activeStates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt: activeStates[0]!.updatedAt,
    activities: activeStates.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
  };
}
