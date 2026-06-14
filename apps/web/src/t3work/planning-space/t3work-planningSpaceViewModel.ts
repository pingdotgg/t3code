/**
 * Derived planning-space scene data — the pure useMemo layer of the view:
 * scene build, story index, §5 filter matching, the active grouping layout, and
 * the lookup maps the JSX/engine consume. Extracted verbatim from
 * t3work-PlanningSpaceView.tsx.
 */

import { useMemo } from "react";

import type { ProjectTicket } from "~/t3work/t3work-types";

import {
  type PlanningCurrentUserIdentity,
  type PlanningSceneData,
  type PlanningState,
  type PlanningStory,
  buildPlanningSceneData,
} from "./t3work-planningSpaceData";
import {
  type GroupingLayout,
  layoutAllGrid,
  layoutByEpic,
  layoutByOwner,
  layoutBySprint,
} from "./t3work-planningSpaceLayout";
import type { InteractionState } from "./t3work-planningSpaceInteractions";
import type { PlanningSpaceGrouping } from "./t3work-planningSpaceViewConstants";

export interface PlanningSpaceViewModelInput {
  tickets: readonly ProjectTicket[];
  sprintId: string | undefined;
  currentUser: PlanningCurrentUserIdentity | undefined;
  grouping: PlanningSpaceGrouping;
  solo: boolean;
  textFilter: string;
  stateFilters: ReadonlySet<PlanningState>;
  spotlight: InteractionState["spotlight"];
  stageSize: { width: number; height: number };
}

export interface PlanningSpaceViewModel {
  data: PlanningSceneData;
  storyById: ReadonlyMap<string, PlanningStory>;
  storyMatches: ReadonlySet<string>;
  filtersActive: boolean;
  layout: GroupingLayout;
  navigationClusterOrder: ReadonlyArray<string>;
  allTiles: ReturnType<typeof layoutAllGrid>;
  ownerNames: ReadonlyMap<string, string>;
  epicById: ReadonlyMap<string, PlanningSceneData["epics"][number]>;
}

export function usePlanningSpaceViewModel(
  input: PlanningSpaceViewModelInput,
): PlanningSpaceViewModel {
  const {
    tickets,
    sprintId,
    currentUser,
    grouping,
    solo,
    textFilter,
    stateFilters,
    spotlight,
    stageSize,
  } = input;
  const currentUserAccountId = currentUser?.accountId;
  const currentUserDisplayName = currentUser?.displayName;
  const data: PlanningSceneData = useMemo(
    () =>
      buildPlanningSceneData(tickets, {
        ...(sprintId ? { sprintId } : {}),
        ...(currentUserAccountId || currentUserDisplayName
          ? {
              currentUser: {
                ...(currentUserAccountId ? { accountId: currentUserAccountId } : {}),
                ...(currentUserDisplayName ? { displayName: currentUserDisplayName } : {}),
              },
            }
          : {}),
      }),
    [tickets, sprintId, currentUserAccountId, currentUserDisplayName],
  );

  const storyById = useMemo(
    () => new Map(data.stories.map((story) => [story.id, story])),
    [data.stories],
  );

  // §5 filtering: text + planning-state chips compose (AND) with the group
  // spotlight; "spotlight" strength dims, "solo" strength re-packs the layout.
  const storyMatches = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    const matches = new Set<string>();
    for (const story of data.stories) {
      if (query) {
        // Subtasks are the planning unit (§3.3) — search reaches them too.
        const haystack = [
          story.key,
          story.title,
          story.ownerName ?? "",
          ...story.subtasks.flatMap((subtask) => [
            subtask.key,
            subtask.title,
            subtask.ownerName ?? "",
          ]),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      if (stateFilters.size > 0 && !stateFilters.has(story.planningState)) {
        continue;
      }
      if (spotlight?.kind === "owner") {
        const ownerId = spotlight.ownerId;
        const hit =
          ownerId === null
            ? story.ownerId === null || story.subtasks.some((s) => s.ownerId === null)
            : story.ownerId === ownerId || story.subtasks.some((s) => s.ownerId === ownerId);
        if (!hit) continue;
      }
      if (spotlight?.kind === "epic" && story.epicId !== spotlight.epicId) {
        continue;
      }
      matches.add(story.id);
    }
    return matches;
  }, [data.stories, textFilter, stateFilters, spotlight]);

  const filtersActive =
    textFilter.trim().length > 0 || stateFilters.size > 0 || spotlight !== null;

  const layout: GroupingLayout = useMemo(() => {
    const layoutStories = data.stories
      .filter((story) => !solo || !filtersActive || storyMatches.has(story.id))
      .map((story) => ({
        id: story.id,
        epicId: story.epicId,
        ownerId: story.ownerId,
        inSprint: story.inSprint,
        subtaskCount: story.subtasks.length,
      }));
    const hideEmptyGroups = solo && filtersActive;
    if (grouping === "sprint") return layoutBySprint(layoutStories);
    if (grouping === "owner") {
      const ownerIds = data.owners.map((owner) => owner.id);
      return layoutByOwner(
        layoutStories,
        hideEmptyGroups
          ? ownerIds.filter((id) => layoutStories.some((story) => story.ownerId === id))
          : ownerIds,
      );
    }
    return layoutByEpic(
      layoutStories,
      hideEmptyGroups
        ? data.epicOrder.filter((id) => layoutStories.some((story) => story.epicId === id))
        : data.epicOrder,
    );
  }, [data, grouping, solo, filtersActive, storyMatches]);

  const navigationClusterOrder = useMemo((): ReadonlyArray<string> => {
    if (grouping === "sprint") return ["true", "false"];
    return [...layout.anchors.keys()];
  }, [grouping, layout.anchors]);

  const allTiles = useMemo(
    () => (stageSize.width > 0 ? layoutAllGrid(data.epicOrder, stageSize) : []),
    [data.epicOrder, stageSize],
  );

  const ownerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const owner of data.owners) names.set(owner.id, owner.name);
    return names;
  }, [data.owners]);

  const epicById = useMemo(
    () => new Map(data.epics.map((epic) => [epic.id, epic])),
    [data.epics],
  );

  return {
    data,
    storyById,
    storyMatches,
    filtersActive,
    layout,
    navigationClusterOrder,
    allTiles,
    ownerNames,
    epicById,
  };
}
