import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";

import { HIGHLIGHTS_LANGUAGE_IDS } from "./highlights.generated";

/** The native lexer ID for a @pierre/highlights language name, or 0 (plain text). */
export function highlightLanguageId(language: string): number {
  return Object.hasOwn(HIGHLIGHTS_LANGUAGE_IDS, language) ? HIGHLIGHTS_LANGUAGE_IDS[language]! : 0;
}

/** A @pierre/highlights language for a fence language or file path, or `text`. */
export function resolveHighlightLanguage(input: {
  readonly language?: string | null;
  readonly path?: string;
}): string {
  const hinted = input.language?.trim().toLowerCase();
  if (hinted && highlightLanguageId(hinted) !== 0) return hinted;
  const detected = input.path ? getFiletypeFromFileName(input.path)?.toLowerCase() : undefined;
  if (detected && highlightLanguageId(detected) !== 0) return detected;
  return "text";
}
