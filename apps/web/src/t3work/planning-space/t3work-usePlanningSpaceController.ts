/**
 * The planning-space controller hook — owns every ref/state, derives the scene
 * view-model, builds the interaction handlers, and runs the engine/pointer
 * effects, returning one controller object the pure-JSX View consumes. Handlers
 * and effects read live state through a single `ctxRef`. Extracted from
 * t3work-PlanningSpaceView.tsx.
 */

import { useCallback, useRef } from "react";

import { usePlanningSpaceViewModel } from "./t3work-planningSpaceViewModel";
import { createPlanningSpaceHandlers } from "./t3work-planningSpaceHandlers";
import { usePlanningSpaceEngineEffects } from "./t3work-planningSpaceEngineEffects";
import { usePlanningSpacePointerEffect } from "./t3work-planningSpacePointerEffect";
import type {
  PlanningSpaceController,
  PlanningSpaceCtx,
  PlanningSpaceProps,
} from "./t3work-planningSpaceControllerTypes";
import { buildPlanningSpaceControllerReturn } from "./t3work-planningSpaceControllerReturn";
import { buildPlanningSpaceControllerCtx } from "./t3work-planningSpaceControllerCtxBuild";
import { usePlanningSpaceControllerRefs } from "./t3work-usePlanningSpaceControllerRefs";

export type {
  PlanningSpaceController,
  PlanningSpaceCtx,
  PlanningSpaceProps,
} from "./t3work-planningSpaceControllerTypes";

export function usePlanningSpaceController(props: PlanningSpaceProps): PlanningSpaceController {
  const {
    tickets,
    sprintId,
    currentUser,
    mutations,
    ownerCapacities,
    ownerRoles,
    onTicketContextMenu,
  } = props;

  const refs = usePlanningSpaceControllerRefs(mutations);
  const vm = usePlanningSpaceViewModel({
    tickets,
    sprintId,
    currentUser,
    grouping: refs.grouping,
    solo: refs.solo,
    textFilter: refs.textFilter,
    stateFilters: refs.stateFilters,
    spotlight: refs.spotlight,
    stageSize: refs.stageSize,
  });
  refs.layoutRef.current = vm.layout;

  const ctxRef = useRef<PlanningSpaceCtx>(undefined as unknown as PlanningSpaceCtx);
  const ctx = buildPlanningSpaceControllerCtx({ refs, vm, mutations });
  ctxRef.current = ctx;
  ctx.handlers = createPlanningSpaceHandlers(ctxRef);

  usePlanningSpaceEngineEffects(ctxRef);
  usePlanningSpacePointerEffect(ctxRef);

  const handleSetSubtaskHours = useCallback(
    (subtaskId: string, seconds: number) => {
      refs.mutationsRef.current?.onSetSubtaskHours?.(subtaskId, seconds);
    },
    [refs.mutationsRef],
  );

  return buildPlanningSpaceControllerReturn({
    ctx,
    ...refs,
    vm,
    handleSetSubtaskHours,
    ownerRoles,
    ownerCapacities,
    onTicketContextMenu,
  });
}
