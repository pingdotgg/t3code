import * as React from "react";

import styles from "./feedbackComposer.module.scss";

interface FeedbackComposerProps {
  element: string;
  selectedText?: string;
  computedStyles?: Record<string, string>;
  accentColor: string;
  style?: React.CSSProperties;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

export function FeedbackComposer({
  element,
  selectedText,
  computedStyles,
  accentColor,
  style,
  onSubmit,
  onCancel,
}: FeedbackComposerProps) {
  const [text, setText] = React.useState("");
  const [stylesExpanded, setStylesExpanded] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const hasComputedStyles = Boolean(computedStyles && Object.keys(computedStyles).length > 0);

  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }, []);

  const handleSubmit = React.useCallback(() => {
    const next = text.trim();
    if (!next) {
      return;
    }
    onSubmit(next);
  }, [onSubmit, text]);

  return (
    <div
      className={styles.panel}
      data-annotation-popup
      data-forma-preview-feedback-ui
      data-preview-feedback-composer
      style={style}
      onClick={(event) => event.stopPropagation()}
    >
      <div className={styles.header}>
        {hasComputedStyles ? (
          <button
            className={styles.headerButton}
            data-forma-preview-feedback-ui
            type="button"
            onClick={() => setStylesExpanded((current) => !current)}
          >
            <svg
              className={[styles.chevron, stylesExpanded ? styles.chevronExpanded : ""]
                .filter(Boolean)
                .join(" ")}
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 2.5 7.5 6 4 9.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
            <span className={styles.elementLabel}>{element}</span>
          </button>
        ) : (
          <div className={styles.elementLabel}>{element}</div>
        )}
      </div>

      {hasComputedStyles ? (
        <div
          className={[styles.stylesSection, stylesExpanded ? styles.stylesSectionExpanded : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <div className={styles.stylesBody}>
            {Object.entries(computedStyles ?? {}).map(([key, value]) => (
              <div key={key} className={styles.styleLine}>
                <span className={styles.styleKey}>
                  {key.replace(/([A-Z])/g, "-$1").toLowerCase()}
                </span>
                : <span className={styles.styleValue}>{value}</span>;
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {selectedText ? (
        <div className={styles.quote}>
          &ldquo;{selectedText.slice(0, 80)}
          {selectedText.length > 80 ? "..." : ""}&rdquo;
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        className={styles.textarea}
        placeholder="What should change?"
        rows={2}
        style={{ borderColor: text.trim().length > 0 ? accentColor : undefined }}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSubmit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />

      <div className={styles.actions}>
        <button
          className={styles.secondaryAction}
          data-forma-preview-feedback-ui
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className={styles.primaryAction}
          data-forma-preview-feedback-ui
          type="button"
          style={{
            backgroundColor: accentColor,
            opacity: text.trim().length > 0 ? 1 : 0.45,
          }}
          disabled={text.trim().length === 0}
          onClick={handleSubmit}
        >
          Add
        </button>
      </div>
    </div>
  );
}
