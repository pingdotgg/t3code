import {
  sameMainSurface,
  sameSecondarySurface,
  sameWorkspaceTarget,
  sameThreadRef,
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

export function reduceWorkspaceState(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "openSurface":
      if (action.placement === "main") {
        if (
          !sameWorkspaceTarget(action.surface.input, state.target) ||
          sameMainSurface(state.surfaces.main, action.surface)
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
        sameSecondarySurface(state.surfaces.secondary, action.surface)
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
          sameMainSurface(state.surfaces.main, nextMain)
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
        sameSecondarySurface(state.surfaces.secondary, nextSecondary)
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
