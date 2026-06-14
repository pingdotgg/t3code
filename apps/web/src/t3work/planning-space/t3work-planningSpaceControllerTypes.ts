/**
 * Shared types for the planning-space controller: the public props, the live
 * mutable context (`PlanningSpaceCtx`) that handlers/effects read through a
 * ctxRef, and the JSX-facing `PlanningSpaceController`. Split out of
 * t3work-usePlanningSpaceController.ts to keep each module focused.
 */

import type { MutableRefObject } from "react";

import type { ProjectTicket } from "~/t3work/t3work-types";

import type {
  PlanningCurrentUserIdentity,
  PlanningState,
  PlanningStory,
} from "./t3work-planningSpaceData";
import type { GroupingLayout } from "./t3work-planningSpaceLayout";
import type { InteractionState, PlanningItemRef } from "./t3work-planningSpaceInteractions";
import type { PlanningSpaceEngine } from "./t3work-planningSpaceRenderer";
import type { PlanningSpaceGrouping, PlanningSpaceMutations } from "./t3work-planningSpaceViewConstants";
import type { PlanningSpaceViewModel } from "./t3work-planningSpaceViewModel";
import type { PlanningSpaceHandlers } from "./t3work-planningSpaceHandlers";

export type SetState<T> = (value: T | ((prev: T) => T)) => void;
export type PlanningNodeKind = "frame" | "epic" | "owner";

export interface PlanningSpaceProps {
  tickets: readonly ProjectTicket[];
  sprintId?: string | undefined;
  currentUser?: PlanningCurrentUserIdentity | undefined;
  mutations?: PlanningSpaceMutations | undefined;
  ownerRoles?: ReadonlyMap<string, string> | undefined;
  ownerCapacities?: ReadonlyMap<string, number> | undefined;
  onTicketContextMenu?: ((event: React.MouseEvent, ticketId: string) => void) | undefined;
}

/** Live mutable context shared by handlers and effects; rebuilt every render. */
export interface PlanningSpaceCtx {
  // refs
  stageRef: MutableRefObject<HTMLDivElement | null>;
  engineRef: MutableRefObject<PlanningSpaceEngine | null>;
  edgeRefs: MutableRefObject<Map<string, SVGLineElement>>;
  nodeEls: MutableRefObject<Map<string, { kind: PlanningNodeKind; el: HTMLElement }>>;
  detailItemRef: MutableRefObject<PlanningItemRef | null>;
  machineState: MutableRefObject<InteractionState>;
  ghostRef: MutableRefObject<HTMLDivElement | null>;
  leaderRef: MutableRefObject<SVGLineElement | null>;
  epicDetailRef: MutableRefObject<string | null>;
  contextMenuRef: MutableRefObject<boolean>;
  zoomToggleRef: MutableRefObject<{ id: string; camera: { x: number; y: number; z: number } } | null>;
  gaugeMarkerRef: MutableRefObject<HTMLDivElement | null>;
  setAllModeRef: MutableRefObject<(value: boolean) => void>;
  allModeRef: MutableRefObject<boolean>;
  cameraBeforeAll: MutableRefObject<{ x: number; y: number; z: number } | null>;
  activeBandRef: MutableRefObject<number>;
  atFullBandRef: MutableRefObject<boolean>;
  gaugeButtonRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  navPrevRef: MutableRefObject<HTMLButtonElement | null>;
  navNextRef: MutableRefObject<HTMLButtonElement | null>;
  snapTargetRef: MutableRefObject<string | null>;
  lastInputAt: MutableRefObject<number>;
  layoutRef: MutableRefObject<GroupingLayout | null>;
  toastTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  refCache: MutableRefObject<Map<string, (el: HTMLDivElement | null) => void>>;
  applyLayoutTargetsRef: MutableRefObject<() => void>;
  frameGroupRef: MutableRefObject<
    (group: { kind: string; ownerId?: string | null; epicId?: string }) => void
  >;
  userNavigated: MutableRefObject<boolean>;
  initialFitDoneRef: MutableRefObject<boolean>;
  lastAutoFitStageSizeRef: MutableRefObject<{ width: number; height: number }>;
  mutationsRef: MutableRefObject<PlanningSpaceMutations | undefined>;
  // state values
  engineReady: boolean;
  grouping: PlanningSpaceGrouping;
  allMode: boolean;
  stageSize: { width: number; height: number };
  pendingFrameOwner: string | null;
  assignTarget: PlanningItemRef | null;
  detailItem: PlanningItemRef | null;
  dragActive: boolean;
  // setters
  setEngineReady: SetState<boolean>;
  setGrouping: SetState<PlanningSpaceGrouping>;
  setAllMode: SetState<boolean>;
  setAtFullBand: SetState<boolean>;
  setStageSize: SetState<{ width: number; height: number }>;
  setToast: SetState<string | null>;
  setDragActive: SetState<boolean>;
  setPendingFrameOwner: SetState<string | null>;
  setAssignTarget: SetState<PlanningItemRef | null>;
  setDetailItem: SetState<PlanningItemRef | null>;
  setEpicDetailId: SetState<string | null>;
  setSpotlight: SetState<InteractionState["spotlight"]>;
  setContextMenu: SetState<{ x: number; y: number; epicId: string } | null>;
  // view-model + props
  vm: PlanningSpaceViewModel;
  mutations: PlanningSpaceMutations | undefined;
  // handlers (assigned after creation)
  handlers: PlanningSpaceHandlers;
}

export interface PlanningSpaceController extends PlanningSpaceCtx {
  textFilter: string;
  setTextFilter: SetState<string>;
  stateFilters: ReadonlySet<PlanningState>;
  setStateFilters: SetState<ReadonlySet<PlanningState>>;
  solo: boolean;
  setSolo: SetState<boolean>;
  showFilters: boolean;
  setShowFilters: SetState<boolean>;
  spotlight: InteractionState["spotlight"];
  epicDetailId: string | null;
  contextMenu: { x: number; y: number; epicId: string } | null;
  toast: string | null;
  setRailUserOpen: SetState<boolean | null>;
  railOpen: boolean;
  detailStory: PlanningStory | null;
  detailSubtask: PlanningStory["subtasks"][number] | null;
  handleSetSubtaskHours: (subtaskId: string, seconds: number) => void;
  ownerRoles: ReadonlyMap<string, string> | undefined;
  ownerCapacities: ReadonlyMap<string, number> | undefined;
  onTicketContextMenu: ((event: React.MouseEvent, ticketId: string) => void) | undefined;
}
