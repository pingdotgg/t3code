import { getLocales } from "expo-localization";

import { i18n } from "../../../lib/i18n";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../../state/server";
import { watchUiLocale } from "./uiLocaleRuntime";

export function installUiLocaleRuntime(): () => void {
  return watchUiLocale({
    registry: appAtomRegistry,
    configsAtom: environmentServerConfigsAtom,
    systemLocale: getLocales()[0]?.languageTag ?? null,
    changeLanguage: (locale) => i18n.changeLanguage(locale),
  });
}
