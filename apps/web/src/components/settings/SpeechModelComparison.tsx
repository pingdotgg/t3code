import type { EnvironmentSpeechModel, SpeechBenchmarkTier } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import { useT } from "../../hooks/useI18n";
import { cn } from "../../lib/utils";
import { languageLabel } from "./SpeechLanguageSelect";

const commonLanguages = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "bn",
  "pt",
  "id",
  "ur",
  "ru",
  "de",
  "ja",
  "mr",
  "vi",
  "te",
  "sw",
  "ha",
  "tr",
  "tl",
  "ta",
  "jw",
  "ko",
  "am",
  "th",
  "it",
  "gu",
  "kn",
  "yo",
];

export function orderSpeechLanguages(languages: readonly string[], preferred: readonly string[]) {
  const order = [...new Set([...preferred, ...commonLanguages])];
  const rank = new Map(order.map((code, index) => [code, index]));
  return languages.toSorted(
    (left, right) =>
      (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length) ||
      languageLabel(left).localeCompare(languageLabel(right)),
  );
}

export function LanguageRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-muted font-medium",
      )}
    >
      {label}
      {selected && <CheckIcon className="size-3.5 shrink-0" />}
    </button>
  );
}

export function ModelBenchmarks({
  model,
  languages,
  tier,
  facts,
}: {
  model: EnvironmentSpeechModel;
  languages: readonly string[];
  tier: SpeechBenchmarkTier;
  /** Plain facts, such as language count and size, shown after the scores. */
  facts: readonly string[];
}) {
  const t = useT();
  const data = model.benchmark;
  const seconds = data?.secondsPer30s[tier];
  const visible = !data
    ? []
    : languages.length
      ? languages
      : [model.languages.find((code) => data.accuracy[code]) ?? model.languages[0]].filter(
          (code): code is string => code !== undefined,
        );
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
      {visible.map((code) => {
        const score = data?.accuracy[code];
        return (
          <span key={code}>
            {languageLabel(code)}:{" "}
            {score ? (
              <>
                <strong className="font-medium text-foreground">{score.grade}</strong>{" "}
                {t("voice.settings.benchmark.error", { percent: score.errorPercent })}
              </>
            ) : (
              t("voice.settings.benchmark.notBenchmarked")
            )}
          </span>
        );
      })}
      <span>
        {t("voice.settings.benchmark.speed")}
        {tier === "cpu" && data && data.secondsPer30s.cpu === undefined ? (
          t("voice.settings.benchmark.updateServer")
        ) : seconds == null ? (
          t("voice.settings.benchmark.notBenchmarked")
        ) : (
          <>
            <strong className="font-medium text-foreground">{seconds} s</strong> / 30 s
          </>
        )}
      </span>
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
