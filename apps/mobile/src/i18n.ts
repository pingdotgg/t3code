import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { createTranslator } from "@t3tools/client-runtime/i18n";

import { mobilePreferencesAtom } from "./state/preferences";

export function useTranslation() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const language = AsyncResult.isSuccess(preferences)
    ? (preferences.value.interfaceLanguage ?? "en")
    : "en";
  return useMemo(() => createTranslator(language), [language]);
}
