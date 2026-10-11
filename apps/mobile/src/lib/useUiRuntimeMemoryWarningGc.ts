import { useEffect } from "react";
import { AppState } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  // Hermes exposes `gc` on the worklets UI runtime; skip quietly on runtimes that do not.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

/**
 * React Native only collects the main JS runtime on an iOS memory warning. The
 * worklets UI runtime is a separate Hermes heap that holds native shadow nodes and
 * serializables alive until its own GC runs, so collect it on the same warning.
 */
export function useUiRuntimeMemoryWarningGc() {
  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      scheduleOnUI(collectUiRuntimeGarbage);
    });
    return () => subscription.remove();
  }, []);
}
