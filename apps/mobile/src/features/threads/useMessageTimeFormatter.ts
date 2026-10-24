import { requireNativeModule } from "expo";
import { useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import { createMessageTimeFormatter } from "./messageTime";

function systemUses24HourClock() {
  if (Platform.OS !== "android") return undefined;
  return requireNativeModule<{ is24HourFormat(): boolean }>("T3NativeControls").is24HourFormat();
}

export function useMessageTimeFormatter() {
  const [is24Hour, setIs24Hour] = useState(systemUses24HourClock);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Android's clock preference can change while the app is in the background.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setIs24Hour(systemUses24HourClock());
    });
    return () => subscription.remove();
  }, []);
  return useMemo(() => createMessageTimeFormatter(is24Hour), [is24Hour]);
}
