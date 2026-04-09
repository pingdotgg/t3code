import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceStore,
  selectResolvedWorkspaceState,
  type WorkspaceNavigationOptions,
} from "./workspace/store";
import {
  createDefaultWorkspaceState,
  type WorkspaceState,
  type WorkspaceTarget,
} from "./workspace/types";
import { buildWorkspaceRouteSearch, resolveWorkspaceState } from "./workspace/urlState";

const TEST_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("workspace-env");
const TEST_THREAD_ID = ThreadId.makeUnsafe("workspace-thread");
const TEST_TURN_ID = TurnId.makeUnsafe("turn-1");

function createServerTarget(): Extract<WorkspaceTarget, { kind: "server" }> {
  return {
    kind: "server",
    threadRef: scopeThreadRef(TEST_ENVIRONMENT_ID, TEST_THREAD_ID),
  };
}

describe("workspace url state", () => {
  it("round-trips conversation diff state through search", () => {
    const target = createServerTarget();
    const initialState = createDefaultWorkspaceState(target);
    const diffState: WorkspaceState = {
      ...initialState,
      surfaces: {
        ...initialState.surfaces,
        secondary: {
          id: "diff",
          input: {
            threadRef: target.threadRef,
            focus: { scope: "conversation" },
          },
        },
      },
    };

    const search = buildWorkspaceRouteSearch(diffState, { unrelated: "keep-me" });

    expect(search).toEqual({
      unrelated: "keep-me",
      diff: "1",
    });
    expect(resolveWorkspaceState(target, search)).toEqual(diffState);
  });

  it("round-trips focused turn diff state through search", () => {
    const target = createServerTarget();
    const initialState = createDefaultWorkspaceState(target);
    const diffState: WorkspaceState = {
      ...initialState,
      surfaces: {
        ...initialState.surfaces,
        secondary: {
          id: "diff",
          input: {
            threadRef: target.threadRef,
            focus: {
              scope: "turn",
              turnId: TEST_TURN_ID,
              filePath: "src/app.ts",
            },
          },
        },
      },
    };

    const search = buildWorkspaceRouteSearch(diffState, {});

    expect(search).toEqual({
      diff: "1",
      diffTurnId: TEST_TURN_ID,
      diffFilePath: "src/app.ts",
    });
    expect(resolveWorkspaceState(target, search)).toEqual(diffState);
  });
});

describe("workspace store optimistic sync", () => {
  it("clears the optimistic transition once the router catches up", () => {
    const target = createServerTarget();
    const initialState = createDefaultWorkspaceState(target);
    let latestRoute = { target, resolvedState: initialState };
    const navigateToState = vi.fn(
      (nextState: WorkspaceState, _options?: WorkspaceNavigationOptions) => {
        latestRoute = { target, resolvedState: nextState };
      },
    );
    const store = createWorkspaceStore(initialState, {
      getRouteState: () => latestRoute,
      navigateToState,
    });

    store.getState().openSurface(
      "secondary",
      {
        id: "diff",
        input: {
          threadRef: target.threadRef,
          focus: { scope: "conversation" },
        },
      },
      { replace: true },
    );

    const navigatedState = navigateToState.mock.calls[0]?.[0] as WorkspaceState | undefined;

    expect(navigatedState?.surfaces.secondary?.id).toBe("diff");
    expect(selectResolvedWorkspaceState(store.getState()).surfaces.secondary?.id).toBe("diff");

    store.getState().syncRouteState(navigatedState ?? initialState);

    expect(store.getState().optimisticTransition).toBeNull();
    expect(selectResolvedWorkspaceState(store.getState())).toEqual(navigatedState);
  });
});
