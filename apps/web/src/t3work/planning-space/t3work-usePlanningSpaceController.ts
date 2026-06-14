/**
 * The planning-space controller hook — owns every ref/state, derives the scene
 * view-model, builds the interaction handlers, and runs the engine/pointer
 * effects, returning one controller object the pure-JSX View consumes. Handlers
 * and effects read live state through a single `ctxRef`. Extracted from
 * t3work-PlanningSpaceView.tsx.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { type PlanningState } from "./t3work-planningSpaceData";
import type { GroupingLayout } from "./t3work-planningSpaceLayout";
import {
  type InteractionState,
  type PlanningItemRef,
  initialInteractionState,
} from "./t3work-planningSpaceInteractions";
import type { PlanningSpaceEngine } from "./t3work-planningSpaceRenderer";
import type { PlanningSpaceGrouping } from "./t3work-planningSpaceViewConstants";
import { usePlanningSpaceViewModel } from "./t3work-planningSpaceViewModel";
import {
  type PlanningSpaceHandlers,
  createPlanningSpaceHandlers,
} from "./t3work-planningSpaceHandlers";
import { usePlanningSpaceEngineEffects } from "./t3work-planningSpaceEngineEffects";
import { usePlanningSpacePointerEffect } from "./t3work-planningSpacePointerEffect";
import type {
  PlanningSpaceController,
  PlanningSpaceCtx,
  PlanningSpaceProps,
} from "./t3work-planningSpaceControllerTypes";

export type {
  PlanningSpaceController,
  PlanningSpaceCtx,
  PlanningSpaceProps,
} from "./t3work-planningSpaceControllerTypes";

type NodeKind = "frame" | "epic" | "owner";

export function usePlanningSpaceController(props: PlanningSpaceProps): PlanningSpaceController {
  const { tickets, sprintId, currentUser, mutations, ownerCapacities, ownerRoles, onTicketContextMenu } =
    props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PlanningSpaceEngine | null>(null);
  const edgeRefs = useRef(new Map<string, SVGLineElement>());
  const nodeEls = useRef(new Map<string, { kind: NodeKind; el: HTMLElement }>());
  const [engineReady, setEngineReady] = useState(false);
  const [grouping, setGrouping] = useState<PlanningSpaceGrouping>("epic");
  const [allMode, setAllMode] = useState(false);
  const [atFullBand, setAtFullBand] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [railUserOpen, setRailUserOpen] = useState<boolean | null>(null);
  const [pendingFrameOwner, setPendingFrameOwner] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<PlanningItemRef | null>(null);
  const [detailItem, setDetailItem] = useState<PlanningItemRef | null>(null);
  const detailItemRef = useRef<PlanningItemRef | null>(null);
  const [epicDetailId, setEpicDetailId] = useState<string | null>(null);
  const [textFilter, setTextFilter] = useState("");
  const [stateFilters, setStateFilters] = useState<ReadonlySet<PlanningState>>(new Set());
  const [solo, setSolo] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; epicId: string } | null>(
    null,
  );
  const [spotlight, setSpotlight] = useState<InteractionState["spotlight"]>(null);
  const machineState = useRef<InteractionState>(initialInteractionState);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const leaderRef = useRef<SVGLineElement | null>(null);
  const epicDetailRef = useRef<string | null>(null);
  const contextMenuRef = useRef(false);
  const zoomToggleRef = useRef<{ id: string; camera: { x: number; y: number; z: number } } | null>(
    null,
  );
  const gaugeMarkerRef = useRef<HTMLDivElement | null>(null);

  const setAllModeRef = useRef<(value: boolean) => void>(() => {});
  setAllModeRef.current = setAllMode;
  const allModeRef = useRef(false);
  allModeRef.current = allMode;
  const cameraBeforeAll = useRef<{ x: number; y: number; z: number } | null>(null);
  const activeBandRef = useRef(1);
  const atFullBandRef = useRef(false);
  const gaugeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const navPrevRef = useRef<HTMLButtonElement | null>(null);
  const navNextRef = useRef<HTMLButtonElement | null>(null);
  const snapTargetRef = useRef<string | null>(null);
  const lastInputAt = useRef(0);
  const layoutRef = useRef<GroupingLayout | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refCache = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const applyLayoutTargetsRef = useRef<() => void>(() => {});
  const frameGroupRef = useRef<
    (group: { kind: string; ownerId?: string | null; epicId?: string }) => void
  >(() => {});
  const userNavigated = useRef(false);
  const initialFitDoneRef = useRef(false);
  const lastAutoFitStageSizeRef = useRef({ width: 0, height: 0 });
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  // A new grouping is a new spatial neighborhood — drop the snap pin.
  useEffect(() => {
    snapTargetRef.current = null;
  }, [grouping]);
  useEffect(() => {
    initialFitDoneRef.current = false;
  }, [grouping]);

  epicDetailRef.current = epicDetailId;
  detailItemRef.current = detailItem;
  contextMenuRef.current = contextMenu !== null;

  const vm = usePlanningSpaceViewModel({
    tickets,
    sprintId,
    currentUser,
    grouping,
    solo,
    textFilter,
    stateFilters,
    spotlight,
    stageSize,
  });
  layoutRef.current = vm.layout;

  const ctxRef = useRef<PlanningSpaceCtx>(undefined as unknown as PlanningSpaceCtx);
  const ctx: PlanningSpaceCtx = {
    stageRef, engineRef, edgeRefs, nodeEls, detailItemRef, machineState, ghostRef, leaderRef,
    epicDetailRef, contextMenuRef, zoomToggleRef, gaugeMarkerRef, setAllModeRef, allModeRef,
    cameraBeforeAll, activeBandRef, atFullBandRef, gaugeButtonRefs, navPrevRef, navNextRef,
    snapTargetRef, lastInputAt, layoutRef, toastTimer, refCache, applyLayoutTargetsRef,
    frameGroupRef, userNavigated, initialFitDoneRef, lastAutoFitStageSizeRef, mutationsRef,
    engineReady, grouping, allMode, stageSize, pendingFrameOwner, assignTarget, detailItem,
    dragActive, setEngineReady, setGrouping, setAllMode, setAtFullBand, setStageSize, setToast,
    setDragActive, setPendingFrameOwner, setAssignTarget, setDetailItem, setEpicDetailId,
    setSpotlight, setContextMenu, vm, mutations,
    handlers: undefined as unknown as PlanningSpaceHandlers,
  };
  ctxRef.current = ctx;
  const handlers = createPlanningSpaceHandlers(ctxRef);
  ctx.handlers = handlers;

  usePlanningSpaceEngineEffects(ctxRef);
  usePlanningSpacePointerEffect(ctxRef);

  // Rail visibility (§6.6): expanded by default in epic/sprint groupings,
  // collapsed in by-owner and at the Full band; assign mode and drags force it
  // open; the user toggle overrides defaults until the next forcing state.
  const railDefaultOpen = grouping !== "owner" && !atFullBand;
  const railOpen = assignTarget !== null || dragActive ? true : (railUserOpen ?? railDefaultOpen);

  const handleSetSubtaskHours = useCallback((subtaskId: string, seconds: number) => {
    mutationsRef.current?.onSetSubtaskHours?.(subtaskId, seconds);
  }, []);

  const detailStory = detailItem ? (vm.storyById.get(detailItem.storyId) ?? null) : null;
  const detailSubtask =
    detailItem?.kind === "subtask"
      ? (detailStory?.subtasks.find((s) => s.id === detailItem.subtaskId) ?? null)
      : null;

  // Rebuilt every render (it closes over fresh state), matching the original
  // single-component behavior; handlers read live state via ctxRef regardless.
  return {
    ...ctx,
    textFilter,
    setTextFilter,
    stateFilters,
    setStateFilters,
    solo,
    setSolo,
    showFilters,
    setShowFilters,
    spotlight,
    epicDetailId,
    contextMenu,
    toast,
    setRailUserOpen,
    railOpen,
    detailStory,
    detailSubtask,
    handleSetSubtaskHours,
    ownerRoles,
    ownerCapacities,
    onTicketContextMenu,
  };
}
