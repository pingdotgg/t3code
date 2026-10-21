import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  filterSpaceEntities,
  isThreadInSpace,
  selectSpace,
} from "@t3tools/client-runtime/state/spaces";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { readThreadShells, useProjects, useThreadShells } from "../state/entities";
import { getClientSettings, useClientSettings } from "./useSettings";
import { resolveSpaceThread } from "./spaces.logic";
import { captureActiveSpace, updateSpaces } from "./spacesPersistence";
export {
  assignCreatedProjectSpace,
  assignCreatedThreadSpace,
  captureActiveSpace,
  updateSpaces,
  reportSpaceError,
  threadSpaceMenu,
  isSpaceMenuAction,
  runThreadSpaceAction,
} from "./spacesPersistence";

/** Filter physical members before project grouping, including parents of draft overrides. */
export function useSpaceEntities() {
  const spaces = useClientSettings((settings) => settings.spaces);
  const projects = useProjects();
  const threads = useThreadShells();
  const drafts = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  return useMemo(() => {
    const entities = [
      ...threads,
      ...Object.values(drafts)
        .filter((draft) => draft.promotedTo == null)
        .map((draft) => ({
          environmentId: draft.environmentId,
          id: draft.threadId,
          projectId: draft.projectId,
        })),
    ];
    return {
      spaces,
      projects: filterSpaceEntities(spaces, projects, entities).projects,
      threads: threads.filter((thread) => isThreadInSpace(spaces, thread)),
    };
  }, [drafts, projects, spaces, threads]);
}

let spaceSwitchGeneration = 0;
let spaceSwitching = false;
export const isSpaceSwitching = () => spaceSwitching;

export function useSelectSpace() {
  const navigate = useNavigate();
  const onOverview = useLocation({ select: (location) => location.pathname === "/spaces" });
  return useCallback(
    async (spaceId: string | null) => {
      if (captureActiveSpace() === spaceId && !spaceSwitching && !onOverview) return;
      const generation = ++spaceSwitchGeneration;
      spaceSwitching = true;
      try {
        const settings = await updateSpaces((state) => selectSpace(state, spaceId));
        if (generation !== spaceSwitchGeneration) return;
        const thread = resolveSpaceThread(settings.spaces, readThreadShells());
        if (thread)
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(thread),
          });
        else await navigate({ to: "/" });
      } finally {
        if (generation === spaceSwitchGeneration) spaceSwitching = false;
      }
    },
    [navigate, onOverview],
  );
}

export function useCycleSpace() {
  const selectSpace = useSelectSpace();
  return useCallback(
    (direction: 1 | -1) => {
      const state = getClientSettings().spaces;
      const ids = [null, ...state.spaces.map((space) => space.id)];
      const index = Math.max(0, ids.indexOf(state.activeSpaceId));
      return selectSpace(ids[(index + direction + ids.length) % ids.length] ?? null);
    },
    [selectSpace],
  );
}
