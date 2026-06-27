import { useEffect, useRef, useState } from "react";

import { type PlanningState } from "./t3work-planningSpaceData";
import type { GroupingLayout } from "./t3work-planningSpaceLayout";
import {
  type InteractionState,
  type PlanningItemRef,
  initialInteractionState,
} from "./t3work-planningSpaceInteractions";
import type { PlanningSpaceEngine } from "./t3work-planningSpaceRenderer";
import type { PlanningNodeKind } from "./t3work-planningSpaceControllerTypes";
import type {
  PlanningSpaceGrouping,
  PlanningSpaceMutations,
} from "./t3work-planningSpaceViewConstants";

export function usePlanningSpaceControllerRefs(mutations: PlanningSpaceMutations | undefined) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PlanningSpaceEngine | null>(null);
  const edgeRefs = useRef(new Map<string, SVGLineElement>());
  const nodeEls = useRef(new Map<string, { kind: PlanningNodeKind; el: HTMLElement }>());
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

  useEffect(() => {
    snapTargetRef.current = null;
  }, [grouping]);
  useEffect(() => {
    initialFitDoneRef.current = false;
  }, [grouping]);

  epicDetailRef.current = epicDetailId;
  detailItemRef.current = detailItem;
  contextMenuRef.current = contextMenu !== null;

  return {
    stageRef,
    engineRef,
    edgeRefs,
    nodeEls,
    engineReady,
    setEngineReady,
    grouping,
    setGrouping,
    allMode,
    setAllMode,
    atFullBand,
    setAtFullBand,
    stageSize,
    setStageSize,
    toast,
    setToast,
    dragActive,
    setDragActive,
    railUserOpen,
    setRailUserOpen,
    pendingFrameOwner,
    setPendingFrameOwner,
    assignTarget,
    setAssignTarget,
    detailItem,
    setDetailItem,
    detailItemRef,
    epicDetailId,
    setEpicDetailId,
    textFilter,
    setTextFilter,
    stateFilters,
    setStateFilters,
    solo,
    setSolo,
    showFilters,
    setShowFilters,
    contextMenu,
    setContextMenu,
    spotlight,
    setSpotlight,
    machineState,
    ghostRef,
    leaderRef,
    epicDetailRef,
    contextMenuRef,
    zoomToggleRef,
    gaugeMarkerRef,
    setAllModeRef,
    allModeRef,
    cameraBeforeAll,
    activeBandRef,
    atFullBandRef,
    gaugeButtonRefs,
    navPrevRef,
    navNextRef,
    snapTargetRef,
    lastInputAt,
    layoutRef,
    toastTimer,
    refCache,
    applyLayoutTargetsRef,
    frameGroupRef,
    userNavigated,
    initialFitDoneRef,
    lastAutoFitStageSizeRef,
    mutationsRef,
  };
}

export type PlanningSpaceControllerRefs = ReturnType<typeof usePlanningSpaceControllerRefs>;
