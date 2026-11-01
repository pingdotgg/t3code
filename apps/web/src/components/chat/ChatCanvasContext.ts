import { createContext, useContext } from "react";
import type { resolveChatCanvasLayout } from "./chatCanvasLayout";
import type { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** The inline details card's measured full-density height at a card width. */
export interface DetailsCardMeasurement {
  readonly threadRef: ScopedThreadRef;
  readonly width: number;
  readonly fullContentHeight: number;
}

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  registerTimeline: (element: HTMLElement | null) => void;
  measureDetailsCard: (measurement: DetailsCardMeasurement) => void;
  detailsCardTopInset: number;
  /** Where an inline card sits when nothing overlaps it; null when the canvas is too narrow. */
  preferredDetailsCard: ReturnType<typeof resolveThreadDetailsCardLayout>;
  /** Where the inline card sits now; null when it shows as a popover. */
  detailsCardPlacement: ReturnType<typeof resolveThreadDetailsCardLayout>;
  /** How far the chat lane moves when the card claims or frees its space. */
  detailsCardLaneShift: number;
  /** True while a panel animates the canvas width; the card sits where the canvas settles. */
  canvasSettling: boolean;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
