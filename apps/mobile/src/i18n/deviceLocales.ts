import { Platform, TurboModuleRegistry, type TurboModule } from "react-native";

// GT's getLocale() reads the last saved UI locale, so get the device languages directly.
export function readDeviceLocales() {
  let locales: ReadonlyArray<string> = [];
  try {
    locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
  } catch {
    // The native module is optional.
  }
  const regionalLocale = locales[0];
  if (Platform.OS !== "ios") {
    return { regionalLocale, preferredLanguages: locales };
  }
  // iOS puts its region setting first as an NSLocale identifier, ahead of its language tags.
  return {
    regionalLocale: regionalLocale?.trim().replace(/@.*$/, "").replaceAll("_", "-"),
    preferredLanguages: locales.slice(1),
  };
}
