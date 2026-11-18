import { Platform, TurboModuleRegistry, type TurboModule } from "react-native";

import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

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
  return {
    regionalLocale: locales[0],
    // On iOS, NSLocale.currentLocale gets its language from the app bundle. Preferred languages follow it.
    preferredLanguages: Platform.OS === "ios" ? locales.slice(1) : locales,
  };
}
