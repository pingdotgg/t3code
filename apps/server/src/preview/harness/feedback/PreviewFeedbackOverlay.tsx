import * as React from "react";

import { FeedbackComposer } from "./components/FeedbackComposer.tsx";
import { FeedbackHoverFrame } from "./components/FeedbackHoverFrame.tsx";
import { FeedbackMarker, PendingFeedbackMarker } from "./components/FeedbackMarker.tsx";
import overlayStyles from "./components/feedbackOverlay.module.scss";
import { buildFeedbackTarget } from "./utils/buildFeedbackTarget.ts";
import { getPopupPosition } from "./utils/positioning.ts";
import type {
  PreviewFeedbackAnnotation,
  PreviewFeedbackElementTarget,
  PreviewFeedbackScope,
} from "./types.ts";

const FEEDBACK_UI_SELECTOR = "[data-forma-preview-feedback-ui]";
const DEFAULT_ACCENT_COLOR = "var(--primary, var(--preview-feedback-color-accent))";

interface PendingTarget {
  target: PreviewFeedbackElementTarget;
  selectedText: string | null;
  popup: {
    left: number;
    top: number;
  };
}

export interface PreviewFeedbackOverlayProps {
  children: React.ReactNode;
  runtimeInstanceId: string;
  previewFileRelativePath: string;
  componentRelativePath: string | null;
  scope: PreviewFeedbackScope;
  annotations: readonly PreviewFeedbackAnnotation[];
  accentColor?: string;
  showMarkers: boolean;
  enabled: boolean;
  onAnnotationCreate: (annotation: PreviewFeedbackAnnotation) => void;
}

function createAnnotationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `preview-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function findSelectionElement(selection: Selection): HTMLElement | null {
  if (selection.rangeCount === 0) {
    return null;
  }
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  return element instanceof HTMLElement ? element : null;
}

function isFeedbackUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FEEDBACK_UI_SELECTOR) !== null;
}

export function PreviewFeedbackOverlay(props: PreviewFeedbackOverlayProps) {
  const [hoverTarget, setHoverTarget] = React.useState<PreviewFeedbackElementTarget | null>(null);
  const [pendingTarget, setPendingTarget] = React.useState<PendingTarget | null>(null);
  const [hoveredAnnotationId, setHoveredAnnotationId] = React.useState<string | null>(null);
  const accentColor = props.accentColor?.trim() || DEFAULT_ACCENT_COLOR;

  React.useEffect(() => {
    document.documentElement.style.setProperty("--preview-feedback-color-accent", accentColor);
    return () => {
      document.documentElement.style.removeProperty("--preview-feedback-color-accent");
    };
  }, [accentColor]);

  React.useEffect(() => {
    if (!props.enabled) {
      setHoverTarget(null);
      setPendingTarget(null);
    }
  }, [props.enabled]);

  React.useEffect(() => {
    if (!props.enabled) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (pendingTarget || isFeedbackUiTarget(event.target)) {
        setHoverTarget(null);
        return;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!(target instanceof HTMLElement) || isFeedbackUiTarget(target)) {
        setHoverTarget(null);
        return;
      }
      setHoverTarget(buildFeedbackTarget(target));
    };

    const handleClick = (event: MouseEvent) => {
      if (pendingTarget || isFeedbackUiTarget(event.target)) {
        return;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!(target instanceof HTMLElement) || isFeedbackUiTarget(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = target.getBoundingClientRect();
      setPendingTarget({
        target: buildFeedbackTarget(target, rect),
        selectedText: null,
        popup: getPopupPosition(rect),
      });
      setHoverTarget(null);
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (pendingTarget || isFeedbackUiTarget(event.target)) {
        return;
      }
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selection || !selectedText || selectedText.length < 2 || selection.rangeCount === 0) {
        return;
      }
      const element = findSelectionElement(selection);
      if (!element || isFeedbackUiTarget(element)) {
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPendingTarget({
        target: buildFeedbackTarget(element, rect),
        selectedText,
        popup: getPopupPosition(rect),
      });
      setHoverTarget(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingTarget(null);
        window.getSelection()?.removeAllRanges();
      }
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [pendingTarget, props.enabled]);

  const submitPendingAnnotation = React.useCallback(
    (comment: string) => {
      if (!pendingTarget) {
        return;
      }
      const now = new Date().toISOString();
      props.onAnnotationCreate({
        id: createAnnotationId(),
        previewFileRelativePath: props.previewFileRelativePath,
        componentRelativePath: props.componentRelativePath,
        runtimeInstanceId: props.runtimeInstanceId,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        status: "unsent",
        comment,
        scope: props.scope,
        target: pendingTarget.selectedText
          ? {
              ...pendingTarget.target,
              kind: "text",
              selectedText: pendingTarget.selectedText,
            }
          : pendingTarget.target,
      });
      setPendingTarget(null);
      window.getSelection()?.removeAllRanges();
    },
    [pendingTarget, props],
  );

  const scrollAnnotations = props.annotations.filter(
    (annotation) => !annotation.target.marker.isFixed,
  );
  const fixedAnnotations = props.annotations.filter(
    (annotation) => annotation.target.marker.isFixed,
  );

  return (
    <>
      {props.children}

      {hoverTarget && props.enabled ? (
        <FeedbackHoverFrame target={hoverTarget} className={overlayStyles.themeScope} />
      ) : null}

      {props.showMarkers ? (
        <>
          <div
            className={`${overlayStyles.markerLayer} ${overlayStyles.scrollLayer} ${overlayStyles.themeScope}`}
            data-forma-preview-feedback-ui
            data-preview-feedback-layer="scroll"
          >
            {scrollAnnotations.map((annotation, index) => (
              <FeedbackMarker
                key={annotation.id}
                annotation={annotation}
                index={index}
                hovered={hoveredAnnotationId === annotation.id}
                onHoverChange={(hovered) => setHoveredAnnotationId(hovered ? annotation.id : null)}
              />
            ))}
          </div>
          <div
            className={`${overlayStyles.markerLayer} ${overlayStyles.fixedLayer} ${overlayStyles.themeScope}`}
            data-forma-preview-feedback-ui
            data-preview-feedback-layer="fixed"
          >
            {fixedAnnotations.map((annotation, index) => (
              <FeedbackMarker
                key={annotation.id}
                annotation={annotation}
                index={scrollAnnotations.length + index}
                hovered={hoveredAnnotationId === annotation.id}
                onHoverChange={(hovered) => setHoveredAnnotationId(hovered ? annotation.id : null)}
              />
            ))}
          </div>
        </>
      ) : null}

      {pendingTarget ? (
        <>
          <div
            className={`${overlayStyles.markerLayer} ${overlayStyles.fixedLayer} ${overlayStyles.themeScope}`}
            data-forma-preview-feedback-ui
            data-preview-feedback-layer="pending"
          >
            <PendingFeedbackMarker
              xPercent={pendingTarget.target.marker.xPercent}
              y={
                pendingTarget.target.marker.isFixed
                  ? pendingTarget.target.marker.yDocument
                  : pendingTarget.target.marker.yDocument - window.scrollY
              }
            />
          </div>
          <FeedbackComposer
            accentColor={accentColor}
            computedStyles={pendingTarget.target.computedStyleMap}
            element={pendingTarget.target.element}
            selectedText={pendingTarget.selectedText ?? undefined}
            style={pendingTarget.popup}
            onCancel={() => {
              setPendingTarget(null);
              window.getSelection()?.removeAllRanges();
            }}
            onSubmit={submitPendingAnnotation}
          />
        </>
      ) : null}
    </>
  );
}
