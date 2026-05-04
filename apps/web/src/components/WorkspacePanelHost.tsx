import type { CSSProperties, ReactNode } from "react";
import { useCallback } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { RightPanelSheet } from "./RightPanelSheet";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const WORKSPACE_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_workspace_panel_width";
const WORKSPACE_PANEL_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const WORKSPACE_PANEL_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

export function WorkspacePanelHost(props: {
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  renderPanelContent: boolean;
  children: (mode: "sheet" | "sidebar") => ReactNode;
}) {
  const shouldUseSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
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
    },
    [],
  );

  if (shouldUseSheet) {
    return (
      <RightPanelSheet open={props.open} onClose={props.onClose}>
        {props.renderPanelContent ? props.children("sheet") : null}
      </RightPanelSheet>
    );
  }

  return (
    <SidebarProvider
      defaultOpen={false}
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          props.onOpen();
          return;
        }
        props.onClose();
      }}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": WORKSPACE_PANEL_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: WORKSPACE_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: WORKSPACE_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {props.renderPanelContent ? props.children("sidebar") : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}
