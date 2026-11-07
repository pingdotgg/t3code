import type { ScopedThreadRef } from "@t3tools/contracts";
import { createStore } from "zustand";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import type { DetailsCardMeasurement } from "./ChatCanvasContext";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

interface CanvasEdges {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ChatCanvasMeasurements {
  readonly width: number;
  /** The width once running panel width transitions end. */
  readonly settledWidth: number;
  readonly height: number;
  readonly padding: number;
  readonly maxChatWidth: number;
  readonly minChatWidth: number;
  readonly composerHeight: number;
  readonly timelineGutter: number;
  /** The find bar's box in canvas coordinates while it is shown. */
  readonly findBar: CanvasEdges | null;
}

interface ChatCanvasStoreState {
  readonly measurements: ChatCanvasMeasurements;
  readonly detailsCardMeasurement: DetailsCardMeasurement | null;
  readonly setMeasurements: (next: ChatCanvasMeasurements) => void;
  readonly measureDetailsCard: (next: DetailsCardMeasurement) => void;
}

const INITIAL_MEASUREMENTS: ChatCanvasMeasurements = {
  width: 0,
  settledWidth: 0,
  height: 0,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 0,
  timelineGutter: 0,
  findBar: null,
};

const sameEdges = (a: CanvasEdges | null, b: CanvasEdges | null) =>
  a === b ||
  (a !== null && b !== null && a.left === b.left && a.right === b.right && a.bottom === b.bottom);

const sameMeasurements = (a: ChatCanvasMeasurements, b: ChatCanvasMeasurements) =>
  a.width === b.width &&
  a.settledWidth === b.settledWidth &&
  a.height === b.height &&
  a.padding === b.padding &&
  a.maxChatWidth === b.maxChatWidth &&
  a.minChatWidth === b.minChatWidth &&
  a.composerHeight === b.composerHeight &&
  a.timelineGutter === b.timelineGutter &&
  sameEdges(a.findBar, b.findBar);

/**
 * One store per chat view: the canvas measures into it, and the chat view's
 * header controls derive the details card presentation from the same inputs.
 */
export const createChatCanvasStore = () =>
  createStore<ChatCanvasStoreState>()((set) => ({
    measurements: INITIAL_MEASUREMENTS,
    detailsCardMeasurement: null,
    setMeasurements: (next) =>
      set((state) => (sameMeasurements(state.measurements, next) ? state : { measurements: next })),
    measureDetailsCard: (next) =>
      set((state) => {
        const current = state.detailsCardMeasurement;
        return current?.threadRef.environmentId === next.threadRef.environmentId &&
          current.threadRef.threadId === next.threadRef.threadId &&
          current.width === next.width &&
          current.fullContentHeight === next.fullContentHeight
          ? state
          : { detailsCardMeasurement: next };
      }),
  }));

export type ChatCanvasStore = ReturnType<typeof createChatCanvasStore>;

export function resolveChatCanvasModel({
  measurements,
  detailsCardMeasurement,
  threadRef,
  preview,
  detailsCardInlineOpen,
}: {
  measurements: ChatCanvasMeasurements;
  detailsCardMeasurement: DetailsCardMeasurement | null;
  /** The thread whose details card sits on the canvas; other threads' measurements are stale. */
  threadRef: ScopedThreadRef | null;
  preview: ChatCanvasPreview | null;
  detailsCardInlineOpen: boolean;
}) {
  const container = { width: measurements.width, height: measurements.height };
  // The card decides whether it fits, and where the lane leaves room for it, from
  // the width the canvas settles at, so a panel animation never squeezes the lane.
  const settled = { width: measurements.settledWidth, height: measurements.height };
  const { findBar } = measurements;
  const detailsCardTopInset = findBar?.bottom ?? 0;
  const lane = { padding: measurements.padding, minChatWidth: measurements.minChatWidth };
  // The preview avoids where an open inline card would sit, whether or not a
  // preview overlap has pushed the card itself into popover mode.
  const preferredDetailsCard = resolveThreadDetailsCardLayout({
    container: settled,
    lane,
    frame: null,
    topInset: detailsCardTopInset,
  });
  // The canvas outlives thread switches, so a measurement only counts for the
  // thread whose card is shown now.
  const detailsCardMeasured =
    threadRef !== null &&
    detailsCardMeasurement !== null &&
    detailsCardMeasurement.threadRef.environmentId === threadRef.environmentId &&
    detailsCardMeasurement.threadRef.threadId === threadRef.threadId
      ? detailsCardMeasurement
      : null;
  const claimableDetailsCard =
    preferredDetailsCard &&
    detailsCardMeasured?.width === preferredDetailsCard.width &&
    detailsCardMeasured.fullContentHeight > 0
      ? {
          left: preferredDetailsCard.x,
          right: preferredDetailsCard.x + preferredDetailsCard.width,
          bottom:
            preferredDetailsCard.y +
            Math.min(detailsCardMeasured.fullContentHeight, preferredDetailsCard.height),
        }
      : null;
  const detailsCard = detailsCardInlineOpen ? claimableDetailsCard : null;
  const resolveLayout = (card: typeof detailsCard) =>
    resolveChatCanvasLayout({
      container,
      preview,
      padding: measurements.padding,
      maxChatWidth: measurements.maxChatWidth,
      minChatWidth: measurements.minChatWidth,
      composerHeight: measurements.composerHeight,
      detailsCard: card,
      findBar,
    });
  const layout = resolveLayout(detailsCard);
  // How far the lane's right edge moves when the card claims or frees space.
  const toggled = claimableDetailsCard
    ? resolveLayout(detailsCard ? null : claimableDetailsCard)
    : layout;
  const detailsCardLaneShift = Math.abs(
    layout.chat.left + layout.chat.width - toggled.chat.left - toggled.chat.width,
  );
  const detailsCardPlacement = resolveThreadDetailsCardLayout({
    container: settled,
    lane,
    frame: layout.frame,
    overlapsDetailsCard: layout.overlapsDetailsCard,
    topInset: detailsCardTopInset,
  });
  const detailsCardMode: ThreadPanelPresentation = detailsCardPlacement ? "inline" : "popover";
  return {
    container,
    lane,
    layout,
    detailsCardTopInset,
    preferredDetailsCard,
    detailsCardPlacement,
    detailsCardMode,
    laneAvoidsDetailsCard: detailsCard !== null,
    detailsCardLaneShift,
    /** A panel is animating the canvas width toward settledWidth. */
    canvasSettling: measurements.settledWidth !== measurements.width,
  };
}
