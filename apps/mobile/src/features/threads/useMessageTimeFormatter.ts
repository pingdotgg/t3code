import { formattingLocale } from "@t3tools/client-runtime/locales";
import { requireNativeModule } from "expo";
import { useLocale } from "gt-react-native";
import { useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import { readSystemLocales } from "../../i18n/locales";
import { createMessageTimeFormatter } from "./messageTimestamp";

function systemUses24HourClock() {
  if (Platform.OS !== "android") return undefined;
  return requireNativeModule<{ is24HourFormat(): boolean }>("T3NativeControls").is24HourFormat();
}

export function useMessageTimeFormatter() {
  const [is24Hour, setIs24Hour] = useState(systemUses24HourClock);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the native clock preference when Android returns to the foreground.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setIs24Hour(systemUses24HourClock());
    });
    return () => subscription.remove();
  }, []);
  const locale = useLocale();
  return useMemo(
    () => createMessageTimeFormatter(is24Hour, formattingLocale(locale, readSystemLocales())),
    [is24Hour, locale],
  );
}
