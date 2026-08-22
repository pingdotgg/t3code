export interface AgentsColdStartHomeAction {
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}

export interface AgentDetailUnavailablePresentation {
  readonly title: string;
  readonly detail: string;
  readonly loadEarlierLabel: string | null;
}

export function agentsColdStartHomeAction(input: {
  readonly canGoBack: boolean;
  readonly replaceWithHome: () => void;
}): AgentsColdStartHomeAction | null {
  if (input.canGoBack) {
    return null;
  }
  return {
    accessibilityLabel: "Go to threads list",
    onPress: input.replaceWithHome,
  };
}

export function agentDetailColdStartRosterAction(input: {
  readonly canGoBack: boolean;
  readonly environmentId: string;
  readonly threadId: string;
  readonly replaceWithRoster: (params: {
    readonly environmentId: string;
    readonly threadId: string;
  }) => void;
}): AgentsColdStartHomeAction | null {
  if (input.canGoBack) {
    return null;
  }
  return {
    accessibilityLabel: "Go to Agents roster",
    onPress: () =>
      input.replaceWithRoster({
        environmentId: input.environmentId,
        threadId: input.threadId,
      }),
  };
}

export function agentDetailUnavailablePresentation(input: {
  readonly hasOlderTurns: boolean;
  readonly loadingOlder: boolean;
}): AgentDetailUnavailablePresentation {
  if (input.hasOlderTurns) {
    return {
      title: "Agent not loaded",
      detail: "Load earlier turns to view this agent.",
      loadEarlierLabel: input.loadingOlder ? "Loading earlier turns…" : "Load earlier turns",
    };
  }
  return {
    title: "Agent unavailable",
    detail: "This agent is no longer present in the retained thread activity.",
    loadEarlierLabel: null,
  };
}
