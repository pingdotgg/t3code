import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import { useGT, useLocale } from "gt-react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const languageNamesByLocale = new Map<string, Intl.DisplayNames>();
export function languageLabel(code: string, locale = "en"): string {
  let languageNames = languageNamesByLocale.get(locale);
  if (!languageNames) {
    languageNames = new Intl.DisplayNames([locale], { type: "language" });
    languageNamesByLocale.set(locale, languageNames);
  }
  return languageNames.of(code) ?? code;
}

type ModelLanguages = Pick<
  Extract<EnvironmentSpeechStatus, { supported: true }>,
  "languages" | "supportsLanguageDetection"
>;

export function SpeechLanguageSelect({ model }: { readonly model: ModelLanguages | null }) {
  const gt = useGT();
  const locale = useLocale();
  const preference = useClientSettings((settings) => settings.speechLanguage);
  const languages = model?.languages ?? [];
  const resolved = model
    ? effectiveSpeechLanguage(
        { languages, supportsLanguageDetection: model.supportsLanguageDetection ?? false },
        preference,
      )
    : preference;
  const effectiveLabel = resolved === "auto" ? gt("Auto-detect") : languageLabel(resolved, locale);
  const unavailable =
    preference !== "auto" && preference !== resolved
      ? gt("{language} unavailable", { language: languageLabel(preference, locale) })
      : null;
  const label = unavailable
    ? gt("{language} ({unavailable})", { language: effectiveLabel, unavailable })
    : preference === "auto" && resolved !== "auto"
      ? gt("Auto ({language})", { language: effectiveLabel })
      : effectiveLabel;
  return (
    <Select
      value={preference}
      disabled={!model}
      onValueChange={(value) => {
        if (value) void updateClientSettings({ speechLanguage: value });
      }}
    >
      <SelectTrigger size="sm" aria-label={gt("Transcription language")} className="max-w-64">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="auto">
          {gt("Auto", { $context: "automatic language detection" })}
        </SelectItem>
        {unavailable ? (
          <SelectItem value={preference} disabled>
            {unavailable}
          </SelectItem>
        ) : null}
        {languages
          .toSorted((left, right) =>
            languageLabel(left, locale).localeCompare(languageLabel(right, locale)),
          )
          .map((code) => (
            <SelectItem key={code} value={code}>
              {languageLabel(code, locale)}
            </SelectItem>
          ))}
      </SelectPopup>
    </Select>
  );
}
