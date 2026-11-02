import { useStore } from "zustand";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { useClientSettings } from "../../hooks/useSettings";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";
import type { ChatCanvasStore } from "./canvasStore";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";
import {
  resolveThreadDetailsCardLayout,
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "./threadDetailsCardLayout";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly canvasStore: ChatCanvasStore;
  readonly hasFloatingPreview: boolean;
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
    hasFloatingPreview,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    ...tabs
  } = props;
  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  const autoSize = !sheet && !maximized && !hasFloatingPreview && chatWidth !== "full";
  // Size for the card even when closed; current presentation depends on the panel's width.
  const preferredSiblingWidth = useStore(canvasStore, ({ measurements }) => {
    if (!autoSize) return undefined;
    const { padding, maxChatWidth, height, findBar } = measurements;
    const widthWithCard =
      maxChatWidth +
      padding +
      DETAILS_CARD_CLEARANCE +
      THREAD_DETAILS_CARD_WIDTH +
      THREAD_DETAILS_CARD_GAP;
    const card = resolveThreadDetailsCardLayout({
      container: { width: widthWithCard, height },
      lane: { padding, minChatWidth: maxChatWidth },
      frame: null,
      topInset: findBar?.bottom ?? 0,
    });
    return card ? widthWithCard : maxChatWidth + padding * 2;
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
