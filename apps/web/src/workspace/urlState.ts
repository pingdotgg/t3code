import { type DiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { createDefaultWorkspaceState, type WorkspaceState, type WorkspaceTarget } from "./types";

export function resolveWorkspaceState(
  target: WorkspaceTarget,
  search: DiffRouteSearch,
): WorkspaceState {
  const state = createDefaultWorkspaceState(target);
  if (search.diff !== "1" || target.kind !== "server") {
    return state;
  }

  return {
    ...state,
    surfaces: {
      ...state.surfaces,
      secondary: {
        id: "diff",
        input: {
          threadRef: target.threadRef,
          focus: search.diffTurnId
            ? {
                scope: "turn",
                turnId: search.diffTurnId,
                ...(search.diffFilePath ? { filePath: search.diffFilePath } : {}),
              }
            : { scope: "conversation" },
        },
      },
    },
  };
}

export function buildWorkspaceRouteSearch<T extends Record<string, unknown>>(
  state: WorkspaceState,
  previous: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> & DiffRouteSearch {
  const rest = stripDiffSearchParams(previous);
  const secondarySurface = state.surfaces.secondary;

  if (!secondarySurface) {
    return { ...rest } as Omit<T, "diff" | "diffTurnId" | "diffFilePath"> & DiffRouteSearch;
  }

  switch (secondarySurface.id) {
    case "diff":
      return {
        ...rest,
        diff: "1",
        ...(secondarySurface.input.focus.scope === "turn"
          ? {
              diffTurnId: secondarySurface.input.focus.turnId,
              ...(secondarySurface.input.focus.filePath
                ? { diffFilePath: secondarySurface.input.focus.filePath }
                : {}),
            }
          : {}),
      } as Omit<T, "diff" | "diffTurnId" | "diffFilePath"> & DiffRouteSearch;
  }
}
