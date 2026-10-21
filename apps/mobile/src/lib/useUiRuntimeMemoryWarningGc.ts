import { useEffect } from "react";
import { AppState } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

/** iOS memory warnings collect only RN's heap; collect worklets too to release shadow nodes and serializables. */
export function useUiRuntimeMemoryWarningGc() {
  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      scheduleOnUI(collectUiRuntimeGarbage);
    });
    return () => subscription.remove();
  }, []);
}
