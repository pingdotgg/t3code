import { useEffect, useLayoutEffect, useRef } from "react";
import {
  isWorkspaceElementVisible,
  requestWorkspaceContentFocus,
  requestWorkspaceFocus,
} from "../lib/workspaceFocus";

/** Recover a focused control when a responsive layout removes or hides its area. */
export function useWorkspaceFocusRecovery(
  selector: string,
  layout: string | boolean,
  fallbackArea?: string,
) {
  const ownedFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        ownedFocus.current = active.closest(selector) ? active : null;
      }
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [selector]);
  useLayoutEffect(() => {
    const previous = ownedFocus.current;
    if (!previous || isWorkspaceElementVisible(previous)) return;
    if (document.activeElement !== document.body && document.activeElement !== previous) return;
    ownedFocus.current = null;
    if (fallbackArea) requestWorkspaceFocus({ area: fallbackArea });
    else requestWorkspaceContentFocus();
  }, [layout, fallbackArea]);
}
