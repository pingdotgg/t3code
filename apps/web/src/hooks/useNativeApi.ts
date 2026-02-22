import { useMemo } from "react";
import { readNativeApi } from "../nativeApi";

export function useNativeApi() {
  return useMemo(() => readNativeApi(), []);
}
