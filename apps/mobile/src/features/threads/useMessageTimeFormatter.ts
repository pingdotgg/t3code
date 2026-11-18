import { formattingLocale, SYSTEM_LANGUAGE } from "@t3tools/client-runtime/locales";
import { requireNativeModule } from "expo";
import { useLocale } from "gt-react-native";
import { useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import { useLanguagePreference } from "../../i18n/I18nProvider";
import { readDeviceLocales } from "../../i18n/locales";
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
  const useDeviceRegion = useLanguagePreference() === SYSTEM_LANGUAGE || Platform.OS === "ios";
  return useMemo(() => {
    const { preferredLanguages, regionalLocale } = readDeviceLocales();
    return createMessageTimeFormatter(
      is24Hour,
      formattingLocale(locale, preferredLanguages, useDeviceRegion ? regionalLocale : undefined),
    );
  }, [is24Hour, locale, useDeviceRegion]);
}
