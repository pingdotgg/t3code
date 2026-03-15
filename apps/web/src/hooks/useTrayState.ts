import { useState, useEffect, useCallback, useRef } from "react";
import { isElectron } from "~/env";
import type { DesktopTrayState } from "@t3tools/contracts";

const EMPTY_TRAY_STATE: DesktopTrayState = {
  threads: [],
  projects: [],
};
type SetTrayStateAction = DesktopTrayState | ((previous: DesktopTrayState) => DesktopTrayState);
type TrayState = [DesktopTrayState, (action: SetTrayStateAction) => void];

export function useTrayState(): TrayState {
  if (!isElectron) return [EMPTY_TRAY_STATE, () => {}];
  const bridge = window.desktopBridge;
  if (!bridge) return [EMPTY_TRAY_STATE, () => {}];

  const [localTrayState, setLocalTrayState] = useState<DesktopTrayState>(EMPTY_TRAY_STATE);
  const localTrayStateRef = useRef(localTrayState);

  const syncLocalTrayState = useCallback((state: DesktopTrayState) => {
    localTrayStateRef.current = state;
    setLocalTrayState(state);
  }, []);

  useEffect(() => {
    void bridge
      .getTrayState()
      .then((state) => {
        syncLocalTrayState(state);
      })
      .catch(() => {
        // Do nothing
      });
  }, [bridge, syncLocalTrayState]);

  const setTrayStateOverBridge = useCallback(
    (action: SetTrayStateAction) => {
      const nextState = typeof action === "function" ? action(localTrayStateRef.current) : action;

      syncLocalTrayState(nextState);
      bridge.setTrayState(nextState).catch(() => {
        void bridge
          .getTrayState()
          .then((state) => {
            syncLocalTrayState(state);
          })
          .catch(() => {
            // Do nothing
          });
      });
    },
    [bridge, syncLocalTrayState],
  );

  return [localTrayState, setTrayStateOverBridge];
}
