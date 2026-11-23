import type { ScopedThreadRef } from "@t3tools/contracts";
import { createStore } from "zustand";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import type { DetailsCardMeasurement } from "./ChatCanvasContext";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import { resolvePreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
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
  readonly minChatWidth: number;
  readonly composerHeight: number;
  readonly timelineGutter: number;
  /** The find bar's box in canvas coordinates while it is shown. */
  readonly findBar: CanvasEdges | null;
  readonly rtl?: boolean;
}

interface ChatCanvasStoreState {
  readonly measurements: ChatCanvasMeasurements;
  readonly detailsCardMeasurement: DetailsCardMeasurement | null;
  readonly setMeasurements: (next: ChatCanvasMeasurements) => void;
  readonly measureDetailsCard: (next: DetailsCardMeasurement) => void;
}

const INITIAL_MEASUREMENTS: ChatCanvasMeasurements = {
  width: 0,
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
  a.narrowestWidth === b.narrowestWidth &&
  a.height === b.height &&
  a.padding === b.padding &&
  a.maxChatWidth === b.maxChatWidth &&
  a.minChatWidth === b.minChatWidth &&
  a.composerHeight === b.composerHeight &&
  a.timelineGutter === b.timelineGutter &&
  sameEdges(a.findBar, b.findBar) &&
  Boolean(a.rtl) === Boolean(b.rtl);

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
  const rtl = measurements.rtl === true;
  const mirrorX = (x: number, width: number) => container.width - width - x;
  const { findBar } = measurements;
  const logicalFindBar =
    rtl && findBar
      ? {
          left: container.width - findBar.right,
          right: container.width - findBar.left,
          bottom: findBar.bottom,
        }
      : findBar;
  const initialPreviewWidth =
    rtl && preview && preview.position !== null && container.width > 0 && container.height > 0
      ? resolvePreviewMiniPlayerFrame({ ...preview, container }).width
      : null;
  const mirrorPreview = (width: number, lockWidth = false) =>
    preview && preview.position !== null
      ? {
          ...preview,
          ...(lockWidth ? { width } : {}),
          position: {
            x: mirrorX(preview.position.x, width),
            y: preview.position.y,
          },
        }
      : preview;
  const logicalPreview =
    initialPreviewWidth !== null ? mirrorPreview(initialPreviewWidth) : preview;
  const detailsCardTopInset = findBar?.bottom ?? 0;
  const lane = { padding: measurements.padding, minChatWidth: measurements.minChatWidth };
  // The preview avoids where an open inline card would sit, whether or not a
  // preview overlap has pushed the card itself into popover mode.
  const logicalPreferredDetailsCard = resolveThreadDetailsCardLayout({
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
    logicalPreferredDetailsCard &&
    detailsCardMeasured?.width === logicalPreferredDetailsCard.width &&
    detailsCardMeasured.fullContentHeight > 0
      ? {
          left: logicalPreferredDetailsCard.x,
          right: logicalPreferredDetailsCard.x + logicalPreferredDetailsCard.width,
          bottom:
            logicalPreferredDetailsCard.y +
            Math.min(detailsCardMeasured.fullContentHeight, logicalPreferredDetailsCard.height),
        }
      : null;
  let logicalLayout = resolveChatCanvasLayout({
    container,
    preview: logicalPreview,
    padding: measurements.padding,
    maxChatWidth: measurements.maxChatWidth,
    minChatWidth: measurements.minChatWidth,
    composerHeight: measurements.composerHeight,
    detailsCard,
    findBar: logicalFindBar,
  });
  if (
    initialPreviewWidth !== null &&
    logicalLayout.frame !== null &&
    logicalLayout.frame.width !== initialPreviewWidth
  ) {
    logicalLayout = resolveChatCanvasLayout({
      container,
      preview: mirrorPreview(logicalLayout.frame.width, true),
      padding: measurements.padding,
      maxChatWidth: measurements.maxChatWidth,
      minChatWidth: measurements.minChatWidth,
      composerHeight: measurements.composerHeight,
      detailsCard,
      findBar: logicalFindBar,
    });
  }
  const logicalDetailsCardPlacement = resolveThreadDetailsCardLayout({
    container,
    narrowestWidth: measurements.narrowestWidth ?? measurements.width,
    lane,
    frame: logicalLayout.frame,
    overlapsDetailsCard: logicalLayout.overlapsDetailsCard,
    topInset: detailsCardTopInset,
  });
  const layout =
    rtl && logicalLayout.frame
      ? {
          ...logicalLayout,
          frame: {
            ...logicalLayout.frame,
            x: mirrorX(logicalLayout.frame.x, logicalLayout.frame.width),
          },
        }
      : logicalLayout;
  const preferredDetailsCard =
    rtl && logicalPreferredDetailsCard
      ? {
          ...logicalPreferredDetailsCard,
          x: mirrorX(logicalPreferredDetailsCard.x, logicalPreferredDetailsCard.width),
        }
      : logicalPreferredDetailsCard;
  const detailsCardPlacement =
    rtl && logicalDetailsCardPlacement
      ? {
          ...logicalDetailsCardPlacement,
          x: mirrorX(logicalDetailsCardPlacement.x, logicalDetailsCardPlacement.width),
        }
      : logicalDetailsCardPlacement;
  const detailsCardMode: ThreadPanelPresentation = detailsCardPlacement ? "inline" : "popover";
  return {
    container,
    lane,
    layout,
    detailsCardTopInset,
    preferredDetailsCard,
    detailsCardPlacement,
    detailsCardMode,
  };
}
