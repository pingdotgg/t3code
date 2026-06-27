import type { PlanningSpaceGrouping } from "./t3work-planningSpaceViewConstants";
import type {
  PlanningSpaceController,
  PlanningSpaceCtx,
  PlanningSpaceProps,
} from "./t3work-planningSpaceControllerTypes";
import type { PlanningItemRef } from "./t3work-planningSpaceInteractions";
import type { PlanningSpaceViewModel } from "./t3work-planningSpaceViewModel";
import type { PlanningSpaceControllerRefs } from "./t3work-usePlanningSpaceControllerRefs";

export function buildPlanningSpaceControllerReturn(
  input: {
    readonly ctx: PlanningSpaceCtx;
    readonly vm: PlanningSpaceViewModel;
    readonly handleSetSubtaskHours: (subtaskId: string, seconds: number) => void;
    readonly ownerRoles: PlanningSpaceProps["ownerRoles"];
    readonly ownerCapacities: PlanningSpaceProps["ownerCapacities"];
    readonly onTicketContextMenu: PlanningSpaceProps["onTicketContextMenu"];
  } & Pick<
    PlanningSpaceControllerRefs,
    | "textFilter"
    | "setTextFilter"
    | "stateFilters"
    | "setStateFilters"
    | "solo"
    | "setSolo"
    | "showFilters"
    | "setShowFilters"
    | "spotlight"
    | "epicDetailId"
    | "contextMenu"
    | "toast"
    | "setRailUserOpen"
    | "grouping"
    | "atFullBand"
    | "assignTarget"
    | "dragActive"
    | "railUserOpen"
    | "detailItem"
  >,
): PlanningSpaceController {
  const railDefaultOpen = input.grouping !== "owner" && !input.atFullBand;
  const railOpen =
    input.assignTarget !== null || input.dragActive
      ? true
      : (input.railUserOpen ?? railDefaultOpen);

  const detailStory = input.detailItem
    ? (input.vm.storyById.get(input.detailItem.storyId) ?? null)
    : null;
  const detailItem = input.detailItem;
  const detailSubtask =
    detailItem?.kind === "subtask"
      ? (detailStory?.subtasks.find((s) => s.id === detailItem.subtaskId) ?? null)
      : null;

  return {
    ...input.ctx,
    textFilter: input.textFilter,
    setTextFilter: input.setTextFilter,
    stateFilters: input.stateFilters,
    setStateFilters: input.setStateFilters,
    solo: input.solo,
    setSolo: input.setSolo,
    showFilters: input.showFilters,
    setShowFilters: input.setShowFilters,
    spotlight: input.spotlight,
    epicDetailId: input.epicDetailId,
    contextMenu: input.contextMenu,
    toast: input.toast,
    setRailUserOpen: input.setRailUserOpen,
    railOpen,
    detailStory,
    detailSubtask,
    handleSetSubtaskHours: input.handleSetSubtaskHours,
    ownerRoles: input.ownerRoles,
    ownerCapacities: input.ownerCapacities,
    onTicketContextMenu: input.onTicketContextMenu,
  };
}
