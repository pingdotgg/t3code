import { IconEdit, IconPlus, IconXmark } from "../../icons";
import type { PreviewFeedbackAnnotation } from "../../../../types";
import styles from "./styles.module.scss";

type MarkerClickBehavior = "edit" | "delete";

// =============================================================================
// AnnotationMarker
// =============================================================================

type AnnotationMarkerProps = {
  annotation: PreviewFeedbackAnnotation;
  globalIndex: number;
  /** Display index within this layer (for staggered animation delays) */
  layerIndex: number;
  layerSize: number;
  isExiting: boolean;
  isClearing: boolean;
  isAnimated: boolean;
  isHovered: boolean;
  isDeleting: boolean;
  isEditingAny: boolean;
  renumberFrom: number | null;
  markerClickBehavior: MarkerClickBehavior;
  tooltipStyle?: React.CSSProperties;
  onHoverEnter: (annotation: PreviewFeedbackAnnotation) => void;
  onHoverLeave: () => void;
  onClick: (annotation: PreviewFeedbackAnnotation) => void;
  onContextMenu?: (annotation: PreviewFeedbackAnnotation) => void;
};

export function AnnotationMarker({
  annotation,
  globalIndex,
  layerIndex,
  layerSize,
  isExiting,
  isClearing,
  isAnimated,
  isHovered,
  isDeleting,
  isEditingAny,
  renumberFrom,
  markerClickBehavior,
  tooltipStyle,
  onHoverEnter,
  onHoverLeave,
  onClick,
  onContextMenu,
}: AnnotationMarkerProps) {
  const showDeleteState = (isHovered || isDeleting) && !isEditingAny;
  const showDeleteHover = showDeleteState && markerClickBehavior === "delete";
  const isMulti = false;

  const markerColor = isMulti
    ? "var(--preview-feedback-color-green)"
    : "var(--preview-feedback-color-accent)";

  const animClass = isExiting
    ? styles.exit
    : isClearing
      ? styles.clearing
      : !isAnimated
        ? styles.enter
        : "";

  const animationDelay = isExiting
    ? `${(layerSize - 1 - layerIndex) * 20}ms`
    : `${layerIndex * 20}ms`;

  return (
    <div
      className={`${styles.marker} ${isMulti ? styles.multiSelect : ""} ${animClass} ${showDeleteHover ? styles.hovered : ""}`}
      data-annotation-marker
      style={{
        left: `${annotation.target.marker.xPercent}%`,
        top: annotation.target.marker.yDocument,
        backgroundColor: showDeleteHover ? undefined : markerColor,
        animationDelay,
      }}
      onMouseEnter={() => onHoverEnter(annotation)}
      onMouseLeave={onHoverLeave}
      onClick={(e) => {
        e.stopPropagation();
        if (!isExiting) onClick(annotation);
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              if (markerClickBehavior === "delete") {
                e.preventDefault();
                e.stopPropagation();
                if (!isExiting) onContextMenu(annotation);
              }
            }
          : undefined
      }
    >
      {showDeleteState ? (
        showDeleteHover ? (
          <IconXmark size={isMulti ? 18 : 16} />
        ) : (
          <IconEdit size={16} />
        )
      ) : (
        <span
          className={
            renumberFrom !== null && globalIndex >= renumberFrom ? styles.renumber : undefined
          }
        >
          {globalIndex + 1}
        </span>
      )}

      {isHovered && !isEditingAny && (
        <div className={`${styles.markerTooltip} ${styles.enter}`} style={tooltipStyle}>
          <span className={styles.markerQuote}>
            {annotation.target.element}
            {annotation.target.kind === "text" &&
              ` "${annotation.target.selectedText.slice(0, 30)}${annotation.target.selectedText.length > 30 ? "..." : ""}"`}
          </span>
          <span className={styles.markerNote}>{annotation.comment}</span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PendingMarker
// =============================================================================

type PendingMarkerProps = {
  x: number;
  y: number;
  isMultiSelect?: boolean;
  isExiting: boolean;
};

export function PendingMarker({ x, y, isMultiSelect, isExiting }: PendingMarkerProps) {
  return (
    <div
      className={`${styles.marker} ${styles.pending} ${isMultiSelect ? styles.multiSelect : ""} ${isExiting ? styles.exit : styles.enter}`}
      style={{
        left: `${x}%`,
        top: y,
        backgroundColor: isMultiSelect
          ? "var(--preview-feedback-color-green)"
          : "var(--preview-feedback-color-accent)",
      }}
    >
      <IconPlus size={12} />
    </div>
  );
}

// =============================================================================
// ExitingMarker
// =============================================================================

type ExitingMarkerProps = {
  annotation: PreviewFeedbackAnnotation;
  fixed?: boolean;
};

export function ExitingMarker({ annotation, fixed }: ExitingMarkerProps) {
  const isMulti = false;
  return (
    <div
      className={`${styles.marker} ${fixed ? styles.fixed : ""} ${styles.hovered} ${isMulti ? styles.multiSelect : ""} ${styles.exit}`}
      data-annotation-marker
      style={{
        left: `${annotation.target.marker.xPercent}%`,
        top: annotation.target.marker.yDocument,
      }}
    >
      <IconXmark size={isMulti ? 12 : 10} />
    </div>
  );
}
