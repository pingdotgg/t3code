import { createContext, useContext } from "react";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

/** The card's docked box; during motion it pins to the canvas's right edge. */
export interface ThreadDetailsCardBox {
  x: number | undefined;
  y: number;
  width: number;
  height: number;
}

export const ChatCanvasContext = createContext<{
  /** The latest canvas size, for gestures; reading it does not re-render on every resize. */
  readContainer: () => { width: number; height: number };
  detailsCardTopInset: number;
  previewKey: string | null;
  previewFrame: PreviewMiniPlayerFrame | null;
  detailsCard: {
    /** Where the card docks with no preview in the way, or null when it cannot dock. */
    preferred: ThreadDetailsCardBox | null;
    placement: ThreadDetailsCardBox | null;
    containerHeight: number;
  };
  reportPreview: (preview: ChatCanvasPreview) => void;
  clearPreview: (key: string) => void;
  registerTimeline: (element: HTMLElement | null) => void;
  /** Reports whether the user keeps the card open where it can dock, and its content height. */
  reportDetailsCard: (inlineOpen: boolean, contentHeight: number) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
