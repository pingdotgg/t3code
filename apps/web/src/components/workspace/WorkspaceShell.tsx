import { scopedThreadKey } from "@t3tools/client-runtime";
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { renderMainSurface, renderSecondarySurface } from "~/workspace/registry";
import {
  sameMainSurface,
  sameSecondarySurface,
  type MainSurface,
  type SecondarySurface,
} from "~/workspace/types";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "../ui/sidebar";
import { Sheet, SheetPopup } from "../ui/sheet";
import { useWorkspaceActions, useWorkspaceState } from "./WorkspaceProvider";

const SECONDARY_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const SECONDARY_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const SECONDARY_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const SECONDARY_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

function shouldAcceptSecondarySidebarWidth({
  nextWidth,
  wrapper,
}: {
  nextWidth: number;
  wrapper: HTMLElement;
}) {
  const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
  if (!composerForm) return true;

  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;

  const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
  wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  if (previousSidebarWidth.length > 0) {
    wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
  } else {
    wrapper.style.removeProperty("--sidebar-width");
  }

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

export function WorkspaceShell() {
  const shouldUseSecondarySheet = useMediaQuery(SECONDARY_LAYOUT_MEDIA_QUERY);
  const state = useWorkspaceState();
  const { closeSurface } = useWorkspaceActions();
  const secondarySurface = state.surfaces.secondary;
  const targetThreadKey =
    state.target.kind === "server"
      ? scopedThreadKey(state.target.threadRef)
      : `draft:${state.target.draftId}`;
  const secondarySurfaceRef = useRef(secondarySurface);
  const [mountedSecondarySurface, setMountedSecondarySurface] = useState<SecondarySurface | null>(
    secondarySurface,
  );

  useEffect(() => {
    secondarySurfaceRef.current = secondarySurface;
  }, [secondarySurface]);

  useEffect(() => {
    setMountedSecondarySurface(secondarySurfaceRef.current);
  }, [targetThreadKey]);

  useEffect(() => {
    if (secondarySurface) {
      setMountedSecondarySurface(secondarySurface);
    }
  }, [secondarySurface]);

  const renderedSecondarySurface = secondarySurface ?? mountedSecondarySurface;
  const secondaryOpen = secondarySurface !== null;
  const closeSecondarySurface = useCallback(() => {
    closeSurface("secondary", { replace: true });
  }, [closeSurface]);

  const mainContent = (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <MainSurfaceSlot surface={state.surfaces.main} />
    </SidebarInset>
  );

  if (shouldUseSecondarySheet) {
    return (
      <>
        {mainContent}
        <Sheet
          open={secondaryOpen}
          onOpenChange={(open) => {
            if (!open && secondaryOpen) {
              closeSecondarySurface();
            }
          }}
        >
          <SheetPopup
            side="right"
            showCloseButton={false}
            keepMounted
            className="w-[min(88vw,820px)] max-w-[820px] p-0"
          >
            {renderedSecondarySurface ? (
              <SecondarySurfaceSlot surface={renderedSecondarySurface} renderMode="sheet" />
            ) : null}
          </SheetPopup>
        </Sheet>
      </>
    );
  }

  return (
    <>
      {mainContent}
      <SidebarProvider
        defaultOpen={false}
        open={secondaryOpen}
        onOpenChange={(open) => {
          if (!open && secondaryOpen) {
            closeSecondarySurface();
          }
        }}
        className="w-auto min-h-0 flex-none bg-transparent"
        style={{ "--sidebar-width": SECONDARY_DEFAULT_WIDTH } as CSSProperties}
      >
        <Sidebar
          side="right"
          collapsible="offcanvas"
          className="border-l border-border bg-card text-foreground"
          resizable={{
            minWidth: SECONDARY_SIDEBAR_MIN_WIDTH,
            shouldAcceptWidth: shouldAcceptSecondarySidebarWidth,
            storageKey: SECONDARY_SIDEBAR_WIDTH_STORAGE_KEY,
          }}
        >
          {renderedSecondarySurface ? (
            <SecondarySurfaceSlot surface={renderedSecondarySurface} renderMode="sidebar" />
          ) : null}
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    </>
  );
}

const MainSurfaceSlot = memo(
  function MainSurfaceSlot(props: { surface: MainSurface }) {
    return renderMainSurface(props.surface);
  },
  (previousProps, nextProps) => sameMainSurface(previousProps.surface, nextProps.surface),
);

const SecondarySurfaceSlot = memo(
  function SecondarySurfaceSlot(props: {
    surface: SecondarySurface;
    renderMode: "sidebar" | "sheet";
  }) {
    return renderSecondarySurface(props.surface, props.renderMode);
  },
  (previousProps, nextProps) =>
    previousProps.renderMode === nextProps.renderMode &&
    sameSecondarySurface(previousProps.surface, nextProps.surface),
);
