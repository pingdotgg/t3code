import { createContext, useContext } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

export const FabScrollContext = createContext<
  ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined
>(undefined);

export function useFabScroll() {
  return useContext(FabScrollContext);
}

/** The New thread FAB's top edge, so the undo toast can sit above it instead of covering it. */
export const FabTopContext = createContext<number | undefined>(undefined);
