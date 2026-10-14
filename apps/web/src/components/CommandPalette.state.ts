import { useCallback, useReducer, useRef } from "react";
import { reduceCommandPaletteUiState, type CommandPaletteUiAction } from "./CommandPalette.logic";
import { getWorkspaceFocusRequestVersion } from "../lib/workspaceFocus";

export function useCommandPaletteState() {
  const [state, dispatchAction] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousLocation = useRef("");
  const previousFocusRequest = useRef(0);
  const dispatch = useCallback(
    (action: CommandPaletteUiAction) => {
      if (!state.open && reduceCommandPaletteUiState(state, action).open) {
        // The workspace becomes inert before the popup mounts. Capture here because
        // Base UI's later layout effect can otherwise remember the body after a blur.
        previousFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        previousLocation.current = window.location.href;
        previousFocusRequest.current = getWorkspaceFocusRequestVersion();
      }
      dispatchAction(action);
    },
    [state],
  );
  const getReturnFocus = useCallback(() => {
    // A navigation action hands focus to the mounted destination, including when
    // that page appears before the palette's closing animation finishes.
    if (
      window.location.href !== previousLocation.current ||
      getWorkspaceFocusRequestVersion() !== previousFocusRequest.current
    )
      return false;
    const element = previousFocus.current;
    return element?.isConnected && !element.matches(":disabled") ? element : true;
  }, []);
  return { state, dispatch, getReturnFocus };
}
