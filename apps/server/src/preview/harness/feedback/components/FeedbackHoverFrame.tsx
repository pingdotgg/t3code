import type { PreviewFeedbackElementTarget } from "../types.ts";
import styles from "./feedbackOverlay.module.scss";

interface FeedbackHoverFrameProps {
  target: PreviewFeedbackElementTarget;
  className?: string;
}

export function FeedbackHoverFrame({ target, className }: FeedbackHoverFrameProps) {
  const tooltipLeft = Math.min(target.boundingBox.x, window.innerWidth - 320);
  const tooltipTop = Math.max(target.boundingBox.y - 38, 8);

  return (
    <>
      <div
        className={[styles.hoverFrame, styles.enter, className].filter(Boolean).join(" ")}
        data-forma-preview-feedback-ui
        data-preview-feedback-hover-frame
        style={{
          left: target.boundingBox.x,
          top: target.boundingBox.y,
          width: target.boundingBox.width,
          height: target.boundingBox.height,
        }}
      />
      <div
        className={[styles.hoverTooltip, styles.enter, className].filter(Boolean).join(" ")}
        data-forma-preview-feedback-ui
        data-preview-feedback-hover-label
        style={{ left: tooltipLeft, top: tooltipTop }}
      >
        {target.reactComponents ? (
          <div className={styles.hoverPath}>{target.reactComponents}</div>
        ) : null}
        <div className={styles.hoverLabel}>{target.element}</div>
      </div>
    </>
  );
}
