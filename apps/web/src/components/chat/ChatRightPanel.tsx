import { useStore } from "zustand";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { useClientSettings } from "../../hooks/useSettings";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";
import type { ChatCanvasStore } from "./canvasStore";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";
import { THREAD_DETAILS_CARD_GAP, THREAD_DETAILS_CARD_WIDTH } from "./threadDetailsCardLayout";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly canvasStore: ChatCanvasStore;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    canvasStore,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const autoSize = !sheet && !maximized && chatWidth !== "full";
  // Keep the card's slot when closed so reopening it does not switch to a popover.
  const preferredSiblingWidth = useStore(canvasStore, ({ measurements }) => {
    if (!autoSize) return undefined;
    const { padding, maxChatWidth } = measurements;
    return (
      maxChatWidth +
      padding +
      DETAILS_CARD_CLEARANCE +
      THREAD_DETAILS_CARD_WIDTH +
      THREAD_DETAILS_CARD_GAP
    );
  });
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
    preferredSiblingWidth,
  });
  if (!sheet) {
    return <RightPanelTabs {...tabs} mode="inline" maximized={maximized} inlineSize={inlineSize} />;
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      />
    </RightPanelSheet>
  );
}
