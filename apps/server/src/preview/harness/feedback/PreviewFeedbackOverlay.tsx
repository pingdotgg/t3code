import * as React from "react";

import { AnnotationPopupCSS } from "./primitives/components/annotation-popup-css/index.tsx";
import {
  AnnotationMarker,
  PendingMarker,
} from "./primitives/components/page-toolbar-css/annotation-marker/index.tsx";
import toolbarStyles from "./primitives/components/page-toolbar-css/styles.module.scss";
import {
  getAccessibilityInfo,
  getDetailedComputedStyles,
  getElementClasses,
  getForensicComputedStyles,
  getFullElementPath,
  getNearbyElements,
  getNearbyText,
  identifyElement,
} from "./primitives/utils/element-identification.ts";
import { getReactComponentName } from "./primitives/utils/react-detection.ts";
import {
  findNearestComponentSource,
  formatSourceLocation,
  getSourceLocation,
} from "./primitives/utils/source-location.ts";
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

function isElementFixed(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const position = window.getComputedStyle(current).position;
    if (position === "fixed" || position === "sticky") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function getPopupPosition(rect: DOMRect): PendingTarget["popup"] {
  return {
    left: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
    top: Math.min(Math.max(rect.bottom + 12, 12), window.innerHeight - 220),
  };
}

function getSourceFile(element: HTMLElement): string | null {
  const exact = getSourceLocation(element);
  const nearest = exact.found ? exact : findNearestComponentSource(element);
  return nearest.found && nearest.source ? formatSourceLocation(nearest.source, "path") : null;
}

function normalizeComputedStyles(styles: Record<string, string>): string | null {
  const entries = Object.entries(styles);
  if (entries.length === 0) {
    return null;
  }
  return entries
    .slice(0, 8)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, "-$1").toLowerCase()}: ${value}`)
    .join("; ");
}

function buildElementTarget(
  element: HTMLElement,
  rectOverride?: DOMRect,
): PreviewFeedbackElementTarget {
  const rect = rectOverride ?? element.getBoundingClientRect();
  const identified = identifyElement(element);
  const detailedStyles = getDetailedComputedStyles(element);
  const reactInfo = getReactComponentName(element, { mode: "filtered" });
  const isFixed = isElementFixed(element);

  return {
    kind: "element",
    element: reactInfo.path ? `${reactInfo.path} ${identified.name}` : identified.name,
    elementPath: identified.path,
    fullPath: getFullElementPath(element) || null,
    cssClasses: getElementClasses(element) || null,
    computedStyles:
      normalizeComputedStyles(detailedStyles) ?? getForensicComputedStyles(element) ?? null,
    computedStyleMap: detailedStyles,
    accessibility: getAccessibilityInfo(element) || null,
    nearbyText: getNearbyText(element) || null,
    nearbyElements: getNearbyElements(element) || null,
    reactComponents: reactInfo.path || null,
    sourceFile: getSourceFile(element),
    boundingBox: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    marker: {
      xPercent: ((rect.left + rect.width / 2) / Math.max(window.innerWidth, 1)) * 100,
      yDocument: isFixed ? rect.top + rect.height / 2 : rect.top + window.scrollY + rect.height / 2,
      isFixed,
    },
  };
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
  return target instanceof Element && Boolean(target.closest(FEEDBACK_UI_SELECTOR));
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
      setHoverTarget(buildElementTarget(target));
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
      const feedbackTarget = buildElementTarget(target);
      const rect = target.getBoundingClientRect();
      setPendingTarget({
        target: feedbackTarget,
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
        target: buildElementTarget(element, rect),
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
        <>
          <div
            className={`${toolbarStyles.hoverHighlight} ${toolbarStyles.enter}`}
            data-forma-preview-feedback-ui
            style={{
              left: hoverTarget.boundingBox.x,
              top: hoverTarget.boundingBox.y,
              width: hoverTarget.boundingBox.width,
              height: hoverTarget.boundingBox.height,
              zIndex: 99997,
            }}
          />
          <div
            className={`${toolbarStyles.hoverTooltip} ${toolbarStyles.enter}`}
            data-forma-preview-feedback-ui
            style={{
              left: Math.min(hoverTarget.boundingBox.x, window.innerWidth - 300),
              top: Math.max(hoverTarget.boundingBox.y - 34, 8),
              zIndex: 100000,
            }}
          >
            {hoverTarget.reactComponents ? (
              <div className={toolbarStyles.hoverReactPath}>{hoverTarget.reactComponents}</div>
            ) : null}
            <div className={toolbarStyles.hoverElementName}>{hoverTarget.element}</div>
          </div>
        </>
      ) : null}

      {props.showMarkers ? (
        <>
          <div className={toolbarStyles.markersLayer} data-forma-preview-feedback-ui>
            {scrollAnnotations.map((annotation, index) => (
              <AnnotationMarker
                key={annotation.id}
                annotation={annotation}
                globalIndex={index}
                layerIndex={index}
                layerSize={scrollAnnotations.length}
                isExiting={false}
                isClearing={false}
                isAnimated
                isHovered={hoveredAnnotationId === annotation.id}
                isDeleting={false}
                isEditingAny={false}
                renumberFrom={null}
                markerClickBehavior="edit"
                onHoverEnter={(next) => setHoveredAnnotationId(next.id)}
                onHoverLeave={() => setHoveredAnnotationId(null)}
                onClick={() => undefined}
              />
            ))}
          </div>
          <div className={toolbarStyles.fixedMarkersLayer} data-forma-preview-feedback-ui>
            {fixedAnnotations.map((annotation, index) => (
              <AnnotationMarker
                key={annotation.id}
                annotation={annotation}
                globalIndex={scrollAnnotations.length + index}
                layerIndex={index}
                layerSize={fixedAnnotations.length}
                isExiting={false}
                isClearing={false}
                isAnimated
                isHovered={hoveredAnnotationId === annotation.id}
                isDeleting={false}
                isEditingAny={false}
                renumberFrom={null}
                markerClickBehavior="edit"
                onHoverEnter={(next) => setHoveredAnnotationId(next.id)}
                onHoverLeave={() => setHoveredAnnotationId(null)}
                onClick={() => undefined}
              />
            ))}
          </div>
        </>
      ) : null}

      {pendingTarget ? (
        <>
          <div className={toolbarStyles.fixedMarkersLayer} data-forma-preview-feedback-ui>
            <PendingMarker
              x={pendingTarget.target.marker.xPercent}
              y={
                pendingTarget.target.marker.isFixed
                  ? pendingTarget.target.marker.yDocument
                  : pendingTarget.target.marker.yDocument - window.scrollY
              }
              isExiting={false}
            />
          </div>
          <div data-forma-preview-feedback-ui>
            <AnnotationPopupCSS
              element={pendingTarget.target.element}
              selectedText={pendingTarget.selectedText ?? undefined}
              computedStyles={pendingTarget.target.computedStyleMap}
              accentColor={accentColor}
              submitLabel="Add"
              style={pendingTarget.popup}
              onSubmit={submitPendingAnnotation}
              onCancel={() => {
                setPendingTarget(null);
                window.getSelection()?.removeAllRanges();
              }}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
