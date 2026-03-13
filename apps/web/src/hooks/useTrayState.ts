import { useState, useEffect, useCallback } from "react";
import { isElectron } from "~/env";
import type { DesktopTrayState } from "@t3tools/contracts";

const EMPTY_TRAY_STATE: DesktopTrayState = {
  threads: [],
};
type TrayState = [DesktopTrayState, (state: DesktopTrayState) => void];

export function useTrayState(): TrayState {
  if (!isElectron) return [EMPTY_TRAY_STATE, () => {}];
  const bridge = window.desktopBridge;
  if (!bridge) return [EMPTY_TRAY_STATE, () => {}];

  const [localTrayState, setLocalTrayState] = useState<DesktopTrayState>(EMPTY_TRAY_STATE);

  useEffect(() => {
    void bridge
      .getTrayState()
      .then((state) => {
        setLocalTrayState(state);
      })
      .catch(() => {
        // Do nothing
      });
  }, [setLocalTrayState]);

  const setTrayStateOverBridge = useCallback(
    (state: DesktopTrayState) => {
      bridge
        .setTrayState(state)
        .then(() => {
          setLocalTrayState(state);
        })
        .catch(() => {
          // Do nothing
        });
    },
    [setLocalTrayState],
  );

  return [localTrayState, setTrayStateOverBridge];
}
