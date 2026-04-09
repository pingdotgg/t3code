import {
  sameWorkspaceTarget,
  sameThreadRef,
  type DiffSurfaceFocus,
  type MainSurface,
  type SecondarySurface,
  type WorkspaceState,
} from "./types";

export type WorkspaceAction =
  | {
      type: "openSurface";
      placement: "main";
      surface: MainSurface;
    }
  | {
      type: "openSurface";
      placement: "secondary";
      surface: SecondarySurface;
    }
  | {
      type: "closeSurface";
      placement: "secondary";
    }
  | {
      type: "updateSurface";
      placement: "main";
      surfaceId: "chat";
      input: MainSurface["input"];
    }
  | {
      type: "updateSurface";
      placement: "secondary";
      surfaceId: "diff";
      input: SecondarySurface["input"];
    };

function diffSurfaceFocusEquals(
  left: DiffSurfaceFocus | null | undefined,
  right: DiffSurfaceFocus | null | undefined,
): boolean {
  if (!left || !right || left.scope !== right.scope) {
    return false;
  }

  if (left.scope === "conversation") {
    return true;
  }

  if (right.scope !== "turn") {
    return false;
  }

  return left.turnId === right.turnId && left.filePath === right.filePath;
}

function mainSurfaceEquals(left: MainSurface, right: MainSurface): boolean {
  return left.id === right.id && sameWorkspaceTarget(left.input, right.input);
}

function secondarySurfaceEquals(
  left: SecondarySurface | null | undefined,
  right: SecondarySurface | null | undefined,
): boolean {
  if (!left || !right || left.id !== right.id) {
    return false;
  }

  return (
    sameThreadRef(left.input.threadRef, right.input.threadRef) &&
    diffSurfaceFocusEquals(left.input.focus, right.input.focus)
  );
}

export function reduceWorkspaceState(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "openSurface":
      if (action.placement === "main") {
        if (
          !sameWorkspaceTarget(action.surface.input, state.target) ||
          mainSurfaceEquals(state.surfaces.main, action.surface)
        ) {
          return state;
        }

        return {
          ...state,
          surfaces: {
            ...state.surfaces,
            main: action.surface,
          },
        };
      }

      if (
        !sameThreadRef(
          action.surface.input.threadRef,
          state.target.kind === "server" ? state.target.threadRef : null,
        ) ||
        secondarySurfaceEquals(state.surfaces.secondary, action.surface)
      ) {
        return state;
      }

      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          secondary: action.surface,
        },
      };
    case "closeSurface":
      if (state.surfaces.secondary === null) {
        return state;
      }

      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          secondary: null,
        },
      };
    case "updateSurface":
      if (action.placement === "main") {
        const nextMain: MainSurface = {
          id: action.surfaceId,
          input: action.input,
        };
        if (
          !sameWorkspaceTarget(nextMain.input, state.target) ||
          mainSurfaceEquals(state.surfaces.main, nextMain)
        ) {
          return state;
        }

        return {
          ...state,
          surfaces: {
            ...state.surfaces,
            main: nextMain,
          },
        };
      }

      const nextSecondary: SecondarySurface = {
        id: action.surfaceId,
        input: action.input,
      };
      if (
        !sameThreadRef(
          nextSecondary.input.threadRef,
          state.target.kind === "server" ? state.target.threadRef : null,
        ) ||
        secondarySurfaceEquals(state.surfaces.secondary, nextSecondary)
      ) {
        return state;
      }

      return {
        ...state,
        surfaces: {
          ...state.surfaces,
          secondary: nextSecondary,
        },
      };
  }
}
