import type { PreviewFeedbackAnnotation } from "../types.ts";
import styles from "./feedbackMarker.module.scss";

interface FeedbackMarkerProps {
  annotation: PreviewFeedbackAnnotation;
  index: number;
  hovered: boolean;
  onHoverChange: (hovered: boolean) => void;
}

function MarkerIcon({ pending = false }: { pending?: boolean }) {
  if (pending) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M6 2.25v7.5M2.25 6h7.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  return null;
}

export function FeedbackMarker({ annotation, index, hovered, onHoverChange }: FeedbackMarkerProps) {
  return (
    <button
      className={styles.marker}
      data-annotation-marker
      data-forma-preview-feedback-ui
      type="button"
      style={{
        left: `${annotation.target.marker.xPercent}%`,
        top: annotation.target.marker.yDocument,
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <span>{index + 1}</span>
      {hovered ? (
        <div className={styles.tooltip} data-preview-feedback-marker-tooltip>
          <span className={styles.tooltipTarget}>{annotation.target.element}</span>
          <span className={styles.tooltipComment}>{annotation.comment}</span>
        </div>
      ) : null}
    </button>
  );
}

export function PendingFeedbackMarker({ xPercent, y }: { xPercent: number; y: number }) {
  return (
    <div
      className={[styles.marker, styles.pending].join(" ")}
      data-forma-preview-feedback-ui
      data-preview-feedback-pending-marker
      style={{
        left: `${xPercent}%`,
        top: y,
      }}
    >
      <MarkerIcon pending />
    </div>
  );
}
