import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WorkflowEditorFullscreen(props: {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Override the dialog's accessible name. Defaults to "Workflow editor". */
  readonly ariaLabel?: string | undefined;
}) {
  const { ariaLabel = "Workflow editor", children, onClose, open } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Apply `inert` to the app root so screen-reader virtual/browse-mode cursors
  // cannot reach background content while the dialog is open. This complements
  // aria-modal="true" for assistive technologies (NVDA, JAWS, older VoiceOver)
  // that do not honour aria-modal for inert-ing siblings automatically.
  useEffect(() => {
    if (!open) {
      return;
    }
    const appRoot = document.getElementById("root");
    if (appRoot === null) {
      return;
    }
    appRoot.setAttribute("inert", "");
    return () => {
      appRoot.removeAttribute("inert");
    };
  }, [open]);

  // Focus management for the modal dialog: move focus into the dialog on open,
  // trap Tab within it (so keyboard/AT users can't reach background UI), and
  // restore focus to the previously-focused element on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    container?.focus();

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || container === null) {
        return;
      }
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === container) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleTab, true);
    return () => {
      window.removeEventListener("keydown", handleTab, true);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const dialog = (
    <div
      aria-label={ariaLabel}
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))]"
      data-workflow-editor-surface="fullscreen"
      ref={containerRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );

  // Portal the dialog to document.body so it is a sibling of (not nested
  // inside) the app root. Combined with the `inert` effect above, this ensures
  // screen readers cannot reach background content in browse/virtual mode.
  // Fallback: render inline when document is not available (SSR / test env).
  if (typeof document === "undefined") {
    return dialog;
  }
  return createPortal(dialog, document.body);
}
