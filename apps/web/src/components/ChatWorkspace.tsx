import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PanelAnimationDurationMs } from "@t3tools/contracts/settings";
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
} from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import {
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
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize(undefined, {
    container: row,
    widthStorageKey: `t3code:preview-panel-width:${threadKey}`,
  });
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

  return (
    <div
      ref={setRow}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <RightPanelViewContext value={view}>
        <RightPanelInlineSizeContext value={inlineSize}>
          {props.children}
        </RightPanelInlineSizeContext>
      </RightPanelViewContext>
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
