import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

export function useEscapeToGoBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBack = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== "Escape" ||
        event.repeat
      )
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
