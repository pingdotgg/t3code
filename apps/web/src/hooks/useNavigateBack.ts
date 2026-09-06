import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

/** Returns to the previous app page, or home when opened without app history. */
export function useNavigateBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);
}

/** Enables page-level Escape navigation, letting controls consume Escape first. */
export function useEscapeToGoBack() {
  const navigateBack = useNavigateBack();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key !== "Escape")
        return;
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      navigateBack();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBack]);
}
