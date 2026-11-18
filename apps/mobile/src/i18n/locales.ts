import { Platform, TurboModuleRegistry, type TurboModule } from "react-native";

import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

// GT's getLocale() reads the last saved UI locale, so get the device languages directly.
export function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS, NSLocale.currentLocale gets its language from the app bundle. Preferred languages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}
