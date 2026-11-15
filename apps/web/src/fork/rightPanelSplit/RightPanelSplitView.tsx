import { useDroppable } from "@dnd-kit/core";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
} from "react";

import { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { RightPanelResizeHandle } from "~/components/preview/RightPanelResizeHandle";
import { RightPanelTabs, type RightPanelTabsProps } from "~/components/RightPanelTabs";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import { cn } from "~/lib/utils";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import { setActivePreviewTab } from "~/previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import type { ContentDropData } from "./dropTarget.logic";
import { useReportSplitRendered } from "./renderedSplit";
import { NotePressContext, RightPanelDragScope } from "./RightPanelDragScope";
import {
  clampSplitRatio,
  PANE_MIN_WIDTH,
  type PaneSide,
  paneLayout,
  type RightPanelSplit,
  SPLIT_MIN_PANEL_WIDTH,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  type SplitChange,
  splitMenuChange,
  splitMenuItems,
  SPLITTER_WIDTH,
  splitWidenTarget,
  widthToGiveBack,
} from "./splitLayout.logic";
import { RightPanelPaneContext, type RightPanelTabMenu } from "./tabStrip";

type RenderPanelSurface = (surface: RightPanelSurface, visible: boolean) => ReactNode;

export type RightPanelSplitViewProps = Omit<RightPanelTabsProps, "children"> & {
  readonly threadRef: ScopedThreadRef;
  readonly split: RightPanelSplit | undefined;
  readonly renderSurface: RenderPanelSurface;
};

const RATIO_PROPERTY = "--right-panel-split-ratio";
const KEYBOARD_STEP = 16;
/** What a split widened, by thread, so the unsplit can give the width back. */
const widenedPanels = new Map<string, { readonly before: number; readonly set: number }>();
// The unfocused pane's shown tab reads as selected but not active.
const UNFOCUSED_PANE_CLASS =
  "[&_[data-right-panel-tabbar]_[data-active-tab=true]]:text-muted-foreground";

/**
 * ChatView's right panel: one shell around one pane, or two side by side. The left pane keeps
 * its React identity across split and unsplit, so the surface the user reads does not remount.
 */
export function RightPanelSplitView(props: RightPanelSplitViewProps) {
  const { threadRef, split, renderSurface, layoutControls, ...tabs } = props;
  const sheetQuery = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const splitAllowed =
    props.mode === "inline" &&
    !sheetQuery &&
    (props.maximized === true || (props.inlineSize?.width ?? 0) >= SPLIT_MIN_PANEL_WIDTH);
  const arrangement = { surfaces: props.surfaces, activeSurfaceId: props.activeSurfaceId, split };
  const layout = paneLayout(arrangement);
  const panes = splitAllowed && layout.kind === "split" ? layout : null;
  const threadKey = scopedThreadKey(threadRef);
  useReportSplitRendered(threadKey, panes !== null);
  useHostedBrowserPaneFocus(threadRef, panes !== null);
  const inlineSize = props.inlineSize;
  const widenTarget =
    props.maximized || !inlineSize ? null : splitWidenTarget(inlineSize.width, inlineSize.maxWidth);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives back the panel width a split took; any path that ends the split (close, move, menu) lands here
  useEffect(() => {
    if (split !== undefined || !inlineSize) return;
    const widened = widenedPanels.get(threadKey);
    if (widened === undefined) return;
    widenedPanels.delete(threadKey);
    const width = widthToGiveBack(inlineSize.width, widened);
    if (width !== null) inlineSize.setWidth(width);
  }, [split, threadKey, inlineSize]);

  const readThread = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const updateSplit = (change: SplitChange) => {
    const wasSplit = readThread().split !== undefined;
    useRightPanelStore.getState().updateSplit(threadRef, change);
    if (!wasSplit && readThread().split !== undefined && inlineSize && widenTarget !== null) {
      widenedPanels.set(threadKey, { before: inlineSize.width, set: widenTarget });
      inlineSize.setWidth(widenTarget);
    }
    // As a tab press does, keep the preview's selected browser on the newly focused tab.
    const focusedSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (focusedSurface?.kind === "preview" && focusedSurface.resourceId) {
      setActivePreviewTab(threadRef, focusedSurface.resourceId);
    }
    // The moved tab's pane is now focused; keyboard focus follows it out of the other pane.
    if (change.type === "split" || change.type === "move") requestWorkspaceFocus({ area: "panel" });
  };
  const tabMenu: RightPanelTabMenu = {
    items: (surface) =>
      splitMenuItems(arrangement, surface.id, { splitAllowed, splitRendered: panes !== null }),
    select: (action, surface) => updateSplit(splitMenuChange(action, readThread(), surface.id)),
  };
  const visible = props.open !== false;
  const single = props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ?? null;
  const leftShown = panes ? panes.left.shown : single;
  return (
    <RightPanelDragScope
      threadRef={threadRef}
      splitAllowed={splitAllowed}
      splitRendered={panes !== null}
      splitGrowth={widenTarget === null || !inlineSize ? 0 : widenTarget - inlineSize.width}
      applyChange={updateSplit}
    >
      <PreviewPanelShell
        mode={props.mode}
        {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
        {...(props.open !== undefined ? { open: props.open } : {})}
        {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
      >
        <div
          data-right-panel-split-row
          className="flex h-full min-h-0 min-w-0 flex-1"
          style={{ [RATIO_PROPERTY]: panes?.ratio ?? SPLIT_RATIO_DEFAULT } as CSSProperties}
        >
          <PaneSection
            key="left"
            side={panes ? "left" : null}
            focused={panes ? panes.focused === "left" : true}
            shown={leftShown}
            tabs={{ ...tabs, surfaces: panes ? panes.left.surfaces : props.surfaces }}
            tabMenu={tabMenu}
            layoutControls={panes ? undefined : layoutControls}
            content={leftShown ? renderSurface(leftShown, visible) : null}
            onFocus={() => updateSplit({ type: "focus", pane: "left" })}
          />
          {panes ? (
            <SplitDivider
              key="divider"
              ratio={panes.ratio}
              onCommit={(ratio) => updateSplit({ type: "ratio", ratio })}
            />
          ) : null}
          {panes ? (
            <PaneSection
              key="right"
              side="right"
              focused={panes.focused === "right"}
              shown={panes.right.shown}
              tabs={{ ...tabs, surfaces: panes.right.surfaces }}
              tabMenu={tabMenu}
              layoutControls={layoutControls}
              content={renderSurface(panes.right.shown, visible)}
              onFocus={() => updateSplit({ type: "focus", pane: "right" })}
            />
          ) : null}
        </div>
      </PreviewPanelShell>
    </RightPanelDragScope>
  );
}

function PaneSection(props: {
  readonly side: PaneSide | null;
  readonly focused: boolean;
  readonly shown: RightPanelSurface | null;
  readonly tabs: Omit<RightPanelTabsProps, "children" | "activeSurfaceId">;
  readonly tabMenu: RightPanelTabMenu;
  readonly layoutControls: ReactNode;
  readonly content: ReactNode;
  readonly onFocus: () => void;
}) {
  const { side, focused, shown } = props;
  const paneSide = side ?? "left";
  const notePress = useContext(NotePressContext);
  const { setNodeRef } = useDroppable({
    id: `content:${paneSide}`,
    data: { kind: "content", pane: paneSide } satisfies ContentDropData,
  });
  const attachContent = (section: HTMLElement | null) => {
    setNodeRef(section?.querySelector<HTMLElement>("[data-right-panel-surface-content]") ?? null);
  };
  return (
    <div
      ref={attachContent}
      onPointerDownCapture={(event) => {
        // A tab press activates its tab, which focuses the pane and moves keyboard focus with it.
        if (focused || (event.target as Element).closest("[data-active-tab]")) return;
        // The primary button, and thumb buttons so back and forward reach this pane's browser.
        if (event.button === 0 || event.button === 3 || event.button === 4) props.onFocus();
      }}
      onFocusCapture={() => {
        if (!focused) props.onFocus();
      }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        side === "left" ? "shrink-0" : "flex-1",
        !focused && UNFOCUSED_PANE_CLASS,
      )}
      style={
        side === "left"
          ? {
              width: `clamp(${PANE_MIN_WIDTH}px, calc(var(${RATIO_PROPERTY}) * 100%), calc(100% - ${PANE_MIN_WIDTH + SPLITTER_WIDTH}px))`,
            }
          : undefined
      }
    >
      <RightPanelPaneContext value={{ side, focused, tabMenu: props.tabMenu, notePress }}>
        <RightPanelTabs
          {...props.tabs}
          activeSurfaceId={shown?.id ?? null}
          layoutControls={props.layoutControls}
        >
          {props.content}
        </RightPanelTabs>
      </RightPanelPaneContext>
    </div>
  );
}

/** The pane splitter: a drag writes the row's ratio variable each frame and commits on release. */
function SplitDivider(props: {
  readonly ratio: number;
  readonly onCommit: (ratio: number) => void;
}) {
  const bounds = (row: HTMLElement) => {
    const width = row.getBoundingClientRect().width;
    return {
      width,
      min: Math.max(PANE_MIN_WIDTH, width * SPLIT_RATIO_MIN),
      max: Math.min(width - PANE_MIN_WIDTH - SPLITTER_WIDTH, width * SPLIT_RATIO_MAX),
    };
  };
  const rowOf = (element: Element) => element.closest<HTMLElement>("[data-right-panel-split-row]");
  const drag = useResizeDrag<HTMLElement>((event) => {
    const row = rowOf(event.currentTarget);
    if (!row) return null;
    const { width, min, max } = bounds(row);
    if (width <= 0 || max < min) return null;
    return {
      width: Math.min(max, Math.max(min, props.ratio * width)),
      edge: "right",
      bounds: { min, max },
      resize(next) {
        row.style.setProperty(RATIO_PROPERTY, String(next / width));
        return next;
      },
      finish(final, moved) {
        if (moved) props.onCommit(final / width);
        else row.style.setProperty(RATIO_PROPERTY, String(props.ratio));
      },
      cleanup(committed) {
        if (!committed) row.style.setProperty(RATIO_PROPERTY, String(props.ratio));
      },
    };
  });
  const { cancel: _cancel, refresh: _refresh, ...handlers } = drag;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const row = rowOf(event.currentTarget);
    if (!row) return;
    const { width, min, max } = bounds(row);
    if (width <= 0) return;
    // Start from the divider as drawn: CSS may hold a pane at its minimum against the ratio.
    const current = Math.min(max, Math.max(min, clampSplitRatio(props.ratio) * width));
    const next =
      event.key === "ArrowLeft"
        ? current - KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? current + KEYBOARD_STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : event.key === "Enter"
                ? SPLIT_RATIO_DEFAULT * width
                : null;
    if (next === null) return;
    event.preventDefault();
    props.onCommit(Math.min(max, Math.max(min, next)) / width);
  };
  return (
    <div
      className="relative w-px shrink-0 bg-border"
      onDoubleClick={() => props.onCommit(SPLIT_RATIO_DEFAULT)}
    >
      <RightPanelResizeHandle
        handlers={handlers}
        label="Resize split panes"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-valuenow={Math.round(clampSplitRatio(props.ratio) * 100)}
        aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
        aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
        className="[-webkit-app-region:no-drag]"
      />
    </div>
  );
}

/**
 * Desktop browser views render outside the panel, and the desktop replays a press in one as a
 * pointerdown on its `<webview>`. That press focuses the pane showing the browser.
 */
function useHostedBrowserPaneFocus(threadRef: ScopedThreadRef, enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for presses replayed from hosted browser views, which live outside the panel's DOM
  useEffect(() => {
    if (!enabled) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.localName !== "webview") return;
      const tabId = target.dataset.previewServerTab;
      if (!tabId) return;
      const store = useRightPanelStore.getState();
      const thread = selectThreadRightPanelState(store.byThreadKey, threadRef);
      const layout = paneLayout(thread);
      if (layout.kind !== "split") return;
      // The mini player shows a browser no pane shows; a press there is not a pane press.
      const side = (["left", "right"] as const).find(
        (pane) => layout[pane].shown.id === `browser:${tabId}`,
      );
      const surface = side ? layout[side].shown : undefined;
      if (!side || surface?.kind !== "preview" || !surface.resourceId) return;
      store.updateSplit(threadRef, { type: "focus", pane: side });
      setActivePreviewTab(threadRef, surface.resourceId);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [enabled, threadRef]);
}
