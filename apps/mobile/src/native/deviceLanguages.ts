import { Platform, Settings } from "react-native";

import { normalizeLanguages } from "../lib/voiceInputLanguage";

/**
 * The languages from the device's language list, most preferred first.
 *
 * `Intl` cannot answer this: Hermes takes its default locale from `NSLocale.currentLocale`, which
 * follows the app's own localizations. The app ships English only, so a device set to German
 * still reports an English locale there.
 */
export function deviceLanguages(): ReadonlyArray<string> {
  if (Platform.OS !== "ios") return [];
  return normalizeLanguages(Settings.get("AppleLanguages"));
}
