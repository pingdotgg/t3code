import { useEffect, useState } from "react";

import { getDictationLanguages } from "../native/voiceTranscription";
import type { DictationLanguage } from "../native/voiceTranscription.types";

export const DEVICE_DICTATION_LANGUAGE_LABEL = "Device language";

/** The languages this device can transcribe, or undefined while they load. */
export function useDictationLanguages(): ReadonlyArray<DictationLanguage> | undefined {
  const [languages, setLanguages] = useState<ReadonlyArray<DictationLanguage>>();
  useEffect(() => {
    let cancelled = false;
    getDictationLanguages().then(
      (loaded) => {
        if (!cancelled) setLanguages(loaded);
      },
      () => {
        if (!cancelled) setLanguages([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return languages;
}

export function dictationLanguageLabel(
  languages: ReadonlyArray<DictationLanguage> | undefined,
  id: string | null | undefined,
): string {
  if (id == null) return DEVICE_DICTATION_LANGUAGE_LABEL;
  return languages?.find((language) => language.id === id)?.label ?? id;
}
