/**
 * transcribe.cpp accepts a language only when it equals an entry of the GGUF's
 * `general.languages` byte for byte. Nemotron Streaming 3.5 lists `de-DE` where the catalog
 * says `de`, so the request carries the loaded model's own spelling. "auto" omits the hint.
 */
export function nativeSpeechLanguage(
  advertised: readonly string[],
  language: string,
): string | undefined {
  if (language === "auto") return undefined;
  const tag = (value: string) => value.toLowerCase().replaceAll("_", "-");
  const wanted = tag(language);
  return (
    advertised.find((entry) => entry === language) ??
    advertised.find((entry) => tag(entry) === wanted) ??
    (wanted.includes("-")
      ? undefined
      : advertised.find((entry) => tag(entry).split("-", 1)[0] === wanted)) ??
    language
  );
}
