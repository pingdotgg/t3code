import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PanelAnimationDurationMs } from "@t3tools/contracts/settings";
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { observeResize } from "~/lib/observeResize";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useSidebarGeometry } from "./ui/sidebar";
import {
  getPreviewPanelMaxWidth,
  getPreviewPanelLiveWidth,
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { cn } from "~/lib/utils";
import { usePanelPresence } from "~/panelAnimations";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

export interface RightPanelView {
  readonly open: boolean;
  readonly present: boolean;
  readonly maximized: boolean;
  readonly ownsTitleBar: boolean;
  readonly activeSurface: RightPanelSurface | null;
  readonly renderedSurface: RightPanelSurface | null;
  readonly renderedSurfaces: readonly RightPanelSurface[];
}

export const ChatWorkspaceGeometryContext = createContext<{
  width: number;
  dockingWidth: number;
  moving: boolean;
  onMeasured: (width: number) => void;
} | null>(null);

const RightPanelViewContext = createContext<RightPanelView | null>(null);
const RightPanelInlineSizeContext = createContext<PreviewPanelInlineSize | null>(null);

const EMPTY_SURFACES: readonly RightPanelSurface[] = [];

export function ChatWorkspace(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadKey: string | null;
  readonly sheet: boolean;
  readonly maximizeRequestThreadRef: ScopedThreadRef;
  readonly animationsActive: boolean;
  readonly animationDurationMs: PanelAnimationDurationMs;
  readonly explicitDiffOpenRef: RefObject<ScopedThreadRef | null>;
  readonly children: ReactNode;
}) {
  const { threadRef, threadKey, sheet, explicitDiffOpenRef } = props;
  const sidebar = useSidebarGeometry();
  const viewportWidth = typeof window === "undefined" ? sidebar.width : window.innerWidth;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const rowWidthRef = useRef(0);
  const completionRef = useRef<(() => void) | null>(null);
  const canvasWidthRef = useRef(0);
  const [measuredRowWidth, setMeasuredRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = (width: number) => {
      rowWidthRef.current = width;
      if (completionRef.current) {
        completionRef.current?.();
        return;
      }
      setMeasuredRowWidth(row.clientWidth);
    };
    measure(row.getBoundingClientRect().width);
    return observeResize(row, ([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
  }, []);
  const rowWidth = Math.max(0, sidebar.width - sidebar.occupiedWidth);
  const inlineSize = usePreviewPanelInlineSize(undefined, {
    containerWidth: measuredRowWidth || undefined,
    container: rowRef.current,
    widthStorageKey: `t3code:preview-panel-width:${threadKey}`,
  });
  const anticipatedPanelWidth = Math.min(
    inlineSize.requestedWidth ?? inlineSize.width,
    getPreviewPanelMaxWidth(viewportWidth, rowWidth ? Math.round(rowWidth) : undefined),
  );
  const panelTargetRef = useRef<HTMLDivElement | null>(null);
  const [panelTargetWidth, setPanelTargetWidth] = useState(anticipatedPanelWidth);
  useLayoutEffect(() => {
    const target = panelTargetRef.current;
    if (target) setPanelTargetWidth(target.getBoundingClientRect().width);
  }, [anticipatedPanelWidth]);
  const open = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const diffOpen = activeSurface?.kind === "diff";
  useLayoutEffect(() => {
    const explicitThreadRef = explicitDiffOpenRef.current;
    explicitDiffOpenRef.current = null;
    // Generic openings always show Changes, including tab fallbacks and thread changes.
    // A timeline click instead opens the specific turn/file the user requested.
    if (diffOpen && threadRef && explicitThreadRef !== threadRef) {
      useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
    }
  }, [diffOpen, explicitDiffOpenRef, threadRef]);
  const presenceValue = useMemo(() => ({ activeSurface, surfaces }), [activeSurface, surfaces]);
  const presence = usePanelPresence(
    open && threadRef !== null,
    presenceValue,
    props.animationsActive,
    threadKey,
    props.animationDurationMs,
  );
  const inline = open && !sheet;
  const maximized = useRightPanelStore(
    (state) =>
      inline && selectThreadRightPanelState(state.byThreadKey, threadRef).maximized === true,
  );
  useEffect(() => {
    if (!inline) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(props.maximizeRequestThreadRef)) {
      useRightPanelStore.getState().setMaximized(props.maximizeRequestThreadRef, true);
    }
  }, [inline, props.maximizeRequestThreadRef]);
  const renderedSurface = presence.value?.activeSurface ?? null;
  const renderedSurfaces = presence.value?.surfaces ?? EMPTY_SURFACES;
  const view = useMemo<RightPanelView>(
    () => ({
      open,
      present: presence.present,
      maximized,
      ownsTitleBar: inline,
      activeSurface,
      renderedSurface,
      renderedSurfaces,
    }),
    [activeSurface, inline, maximized, open, presence.present, renderedSurface, renderedSurfaces],
  );

  const width = maximized ? 0 : rowWidth - (inline ? panelTargetWidth : 0);
  const [motion, setMotion] = useState({
    width,
    open,
    sidebarOpen: sidebar.open,
    threadKey,
    dockingWidth: Math.round(width),
    moving: false,
  });
  if (
    motion.width !== width ||
    motion.open !== open ||
    motion.sidebarOpen !== sidebar.open ||
    motion.threadKey !== threadKey ||
    (motion.moving && !props.animationsActive)
  ) {
    const moving =
      props.animationsActive &&
      motion.threadKey === threadKey &&
      (motion.open !== open || motion.sidebarOpen !== sidebar.open || motion.moving);
    setMotion({
      width,
      open,
      sidebarOpen: sidebar.open,
      threadKey,
      dockingWidth: moving ? Math.min(motion.dockingWidth, Math.round(width)) : Math.round(width),
      moving,
    });
  }
  const finish = useCallback(() => {
    setMeasuredRowWidth(rowRef.current?.clientWidth ?? rowWidthRef.current);
    setMotion((current) => (current === motion ? { ...current, moving: false } : current));
  }, [motion]);
  useLayoutEffect(() => {
    if (!motion.moving) return;
    const deadline = performance.now() + props.animationDurationMs;
    completionRef.current = () => {
      if (
        performance.now() >= deadline &&
        Math.abs(rowWidthRef.current - rowWidth) < 0.1 &&
        canvasWidthRef.current === Math.round(motion.width)
      )
        finish();
    };
    const timeout = window.setTimeout(finish, props.animationDurationMs + 50);
    return () => {
      window.clearTimeout(timeout);
      completionRef.current = null;
    };
  }, [motion, rowWidth, finish, props.animationDurationMs]);
  const onMeasured = useCallback((width: number) => {
    canvasWidthRef.current = width;
    setMotion((current) =>
      current.moving || current.dockingWidth === width
        ? current
        : { ...current, dockingWidth: width },
    );
    completionRef.current?.();
  }, []);
  const liveInlineSize = useMemo(
    () =>
      motion.moving
        ? {
            ...inlineSize,
            width: Math.max(
              inlineSize.width,
              panelTargetWidth,
              Math.min(
                inlineSize.requestedWidth ?? inlineSize.width,
                getPreviewPanelMaxWidth(viewportWidth, Math.round(rowWidthRef.current)),
              ),
            ),
            liveWidth: getPreviewPanelLiveWidth(
              inlineSize.requestedWidth ?? inlineSize.width,
              viewportWidth,
            ),
          }
        : inlineSize,
    [motion.moving, inlineSize, panelTargetWidth, viewportWidth],
  );
  const geometry = useMemo(
    () => ({
      width: motion.width,
      dockingWidth: motion.dockingWidth,
      moving: motion.moving,
      onMeasured,
    }),
    [motion.width, motion.dockingWidth, motion.moving, onMeasured],
  );

  return (
    <div
      ref={rowRef}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background [container-type:inline-size]"
    >
      <div
        ref={panelTargetRef}
        aria-hidden
        className="pointer-events-none invisible absolute h-0"
        style={{ width: anticipatedPanelWidth }}
      />
      <ChatWorkspaceGeometryContext value={geometry}>
        <RightPanelViewContext value={view}>
          <RightPanelInlineSizeContext value={liveInlineSize}>
            {props.children}
          </RightPanelInlineSizeContext>
        </RightPanelViewContext>
      </ChatWorkspaceGeometryContext>
    </div>
  );
}

function useRightPanelView(): RightPanelView {
  const view = use(RightPanelViewContext);
  if (!view) throw new Error("Right panel slots must render inside ChatWorkspace.");
  return view;
}

export function RightPanelViewSlot(props: {
  readonly children: (view: RightPanelView) => ReactNode;
}) {
  const view = useRightPanelView();
  return props.children(view);
}

export function RightPanelSlot(props: {
  readonly children: (view: RightPanelView, inlineSize: PreviewPanelInlineSize) => ReactNode;
}) {
  const view = useRightPanelView();
  const inlineSize = use(RightPanelInlineSizeContext);
  if (!inlineSize) throw new Error("Right panel slots must render inside ChatWorkspace.");
  return props.children(view, inlineSize);
}

export function RightPanelControlClip(props: {
  readonly width: number | string | undefined;
  readonly children: ReactNode;
}) {
  const [transition, setTransition] = useState({ initialWidth: props.width, resized: false });
  if (!transition.resized && transition.initialWidth !== props.width) {
    setTransition({ ...transition, resized: true });
  }
  return (
    <div
      className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-0 h-[var(--workspace-topbar-height)] [clip-path:inset(0)] [[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out [[data-panel-animations=true]_&]:starting:w-0!"
      style={{ width: props.width, transitionDuration: transition.resized ? "0ms" : undefined }}
    >
      {props.children}
    </div>
  );
}

export function ChatWorkspaceColumn(props: {
  readonly renderHeader: (view: RightPanelView) => ReactNode;
  readonly children: ReactNode;
}) {
  const view = useRightPanelView();
  return (
    <div
      className={cn(
        // Clipping rather than scrolling leaves the workspace row as the scrollport the header's
        // sticky card toggle measures against.
        "flex min-h-0 min-w-0 flex-col overflow-x-clip",
        view.maximized ? "w-0 flex-none" : "flex-1",
      )}
      data-chat-column-maximized-away={view.maximized ? "true" : "false"}
    >
      {props.renderHeader(view)}
      {props.children}
    </div>
  );
}
