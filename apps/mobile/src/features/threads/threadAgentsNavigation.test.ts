import { describe, expect, it, vi } from "vite-plus/test";

import {
  agentDetailColdStartRosterAction,
  agentDetailUnavailablePresentation,
  agentsColdStartHomeAction,
} from "./threadAgentsNavigation";

describe("Agents cold-start navigation", () => {
  it("offers Home from a cold-start roster root", () => {
    const replaceWithHome = vi.fn();
    const coldStartAction = agentsColdStartHomeAction({
      canGoBack: false,
      replaceWithHome,
    });

    expect(coldStartAction?.accessibilityLabel).toBe("Go to threads list");
    coldStartAction?.onPress();
    expect(replaceWithHome).toHaveBeenCalledOnce();
    expect(agentsColdStartHomeAction({ canGoBack: true, replaceWithHome })).toBeNull();
  });

  it("routes a cold-start agent detail back to its Agents roster", () => {
    const replaceWithRoster = vi.fn();
    const coldStartAction = agentDetailColdStartRosterAction({
      canGoBack: false,
      environmentId: "environment-1",
      threadId: "thread-1",
      replaceWithRoster,
    });

    expect(coldStartAction?.accessibilityLabel).toBe("Go to Agents roster");
    coldStartAction?.onPress();
    expect(replaceWithRoster).toHaveBeenCalledWith({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(
      agentDetailColdStartRosterAction({
        canGoBack: true,
        environmentId: "environment-1",
        threadId: "thread-1",
        replaceWithRoster,
      }),
    ).toBeNull();
  });

  it("offers earlier turns for a paginated miss instead of calling the agent unavailable", () => {
    expect(
      agentDetailUnavailablePresentation({ hasOlderTurns: true, loadingOlder: false }),
    ).toEqual({
      title: "Agent not loaded",
      detail: "Load earlier turns to view this agent.",
      loadEarlierLabel: "Load earlier turns",
    });
    expect(
      agentDetailUnavailablePresentation({ hasOlderTurns: true, loadingOlder: true }),
    ).toMatchObject({ loadEarlierLabel: "Loading earlier turns…" });
    expect(
      agentDetailUnavailablePresentation({ hasOlderTurns: false, loadingOlder: false }),
    ).toEqual({
      title: "Agent unavailable",
      detail: "This agent is no longer present in the retained thread activity.",
      loadEarlierLabel: null,
    });
  });
});
