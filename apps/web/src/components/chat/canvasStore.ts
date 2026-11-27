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
  readonly narrowestWidth?: number;
  readonly height: number;
  readonly padding: number;
  readonly maxChatWidth: number;
  readonly maxHtmlPreviewWidth: number;
  readonly minChatWidth: number;
  readonly composerHeight: number;
  readonly timelineGutter: number;
  /** The find bar's box in canvas coordinates while it is shown. */
  readonly findBar: CanvasEdges | null;
}

interface ChatCanvasStoreState {
  readonly measurements: ChatCanvasMeasurements;
  /**
   * The last measurement taken with the right panel open and with it closed. A thread switch can
   * open or close the panel, and laying out with the other state's width costs a second layout
   * pass before the first paint.
   */
  readonly measurementsByRightPanel: {
    readonly open?: ChatCanvasMeasurements;
    readonly closed?: ChatCanvasMeasurements;
  };
  readonly detailsCardMeasurement: DetailsCardMeasurement | null;
  readonly setMeasurements: (next: ChatCanvasMeasurements, rightPanelOpen: boolean) => void;
  readonly measureDetailsCard: (next: DetailsCardMeasurement) => void;
}

const INITIAL_MEASUREMENTS: ChatCanvasMeasurements = {
  width: 0,
  height: 0,
  padding: 48,
  maxChatWidth: 768,
  maxHtmlPreviewWidth: 768,
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
  a.narrowestWidth === b.narrowestWidth &&
  a.height === b.height &&
  a.padding === b.padding &&
  a.maxChatWidth === b.maxChatWidth &&
  a.maxHtmlPreviewWidth === b.maxHtmlPreviewWidth &&
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
    measurementsByRightPanel: {},
    detailsCardMeasurement: null,
    setMeasurements: (next, rightPanelOpen) =>
      set((state) => {
        const key = rightPanelOpen ? "open" : "closed";
        const known = state.measurementsByRightPanel[key];
        const measurements = known && sameMeasurements(known, next) ? known : next;
        if (measurements === known && measurements === state.measurements) return state;
        return {
          measurements,
          measurementsByRightPanel: { ...state.measurementsByRightPanel, [key]: measurements },
        };
      }),
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

export const selectCanvasMeasurements = (state: ChatCanvasStoreState, rightPanelOpen: boolean) =>
  state.measurementsByRightPanel[rightPanelOpen ? "open" : "closed"] ?? state.measurements;

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
  const { findBar } = measurements;
  const detailsCardTopInset = findBar?.bottom ?? 0;
  const lane = { padding: measurements.padding, minChatWidth: measurements.minChatWidth };
  // The preview avoids where an open inline card would sit, whether or not a
  // preview overlap has pushed the card itself into popover mode.
  const preferredDetailsCard = resolveThreadDetailsCardLayout({
    container,
    narrowestWidth: measurements.narrowestWidth ?? measurements.width,
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
  const detailsCard =
    detailsCardInlineOpen &&
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
  const layout = resolveChatCanvasLayout({
    container,
    preview,
    padding: measurements.padding,
    maxChatWidth: measurements.maxChatWidth,
    maxHtmlPreviewWidth: measurements.maxHtmlPreviewWidth,
    minChatWidth: measurements.minChatWidth,
    composerHeight: measurements.composerHeight,
    detailsCard,
    findBar,
  });
  const detailsCardPlacement = resolveThreadDetailsCardLayout({
    container,
    narrowestWidth: measurements.narrowestWidth ?? measurements.width,
    lane,
    frame: layout.frame,
    overlapsDetailsCard: layout.overlapsDetailsCard,
    topInset: detailsCardTopInset,
  });
  const detailsCardMode: ThreadPanelPresentation = detailsCardPlacement ? "inline" : "popover";
  return {
    measurements,
    container,
    lane,
    layout,
    detailsCardTopInset,
    preferredDetailsCard,
    detailsCardPlacement,
    detailsCardMode,
  };
}

type ChatCanvasModel = ReturnType<typeof resolveChatCanvasModel>;
type DetailsCardBox = ChatCanvasModel["detailsCardPlacement"];

const cardKey = (card: DetailsCardBox) =>
  card ? `${card.right},${card.y},${card.width},${card.height}` : "-";

/**
 * Everything the canvas and its consumers draw from a model. The card is placed from the
 * right and the player only reads the width with it, so most resizes change none of it.
 */
export function chatCanvasDrawnKey({
  measurements,
  container,
  lane,
  layout,
  detailsCardTopInset,
  preferredDetailsCard,
  detailsCardPlacement,
}: ChatCanvasModel): string {
  const { frame, chat, htmlPreview } = layout;
  return [
    measurements.timelineGutter,
    chat.insetStart,
    chat.insetEnd,
    htmlPreview.width > chat.width ? `${htmlPreview.left - chat.left},${htmlPreview.width}` : "-",
    layout.overlapsChat,
    layout.overlapsDetailsCard,
    frame ? `${frame.x},${frame.y},${frame.width},${frame.height},${container.width}` : "-",
    container.height,
    lane.padding,
    lane.minChatWidth,
    detailsCardTopInset,
    cardKey(preferredDetailsCard),
    cardKey(detailsCardPlacement),
  ].join("|");
}
