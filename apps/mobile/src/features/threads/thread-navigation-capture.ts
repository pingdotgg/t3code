import { useNavigation } from "@react-navigation/native";
import { createContext, use } from "react";

export const PreviewHostNavigationContext = createContext<(() => () => boolean) | null>(null);

/** Captures the route and any preview host before work that may navigate on completion. */
export function useCaptureThreadNavigation() {
  const navigation = useNavigation();
  const captureHostNavigation = use(PreviewHostNavigationContext);
  return () => {
    const state = navigation.getState();
    const isHostCurrent = captureHostNavigation?.();
    return () =>
      (isHostCurrent?.() ?? true) && navigation.isFocused() && navigation.getState() === state;
  };
}
