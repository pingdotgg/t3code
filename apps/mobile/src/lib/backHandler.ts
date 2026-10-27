import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent } from "react";
import { BackHandler } from "react-native";

/**
 * Android hardware back while `active` and the owning screen is focused.
 * Keyed on those alone, not `onBack`: BackHandler calls the newest listener
 * first, so re-registering per render lets a covered screen consume Back.
 */
export function useHardwareBack(active: boolean, onBack: () => boolean) {
  const focused = useIsFocused();
  const handleBack = useEffectEvent(onBack);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler for the focused screen's lifetime
  useEffect(() => {
    if (!active || !focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => handleBack());
    return () => subscription.remove();
  }, [active, focused]);
}
