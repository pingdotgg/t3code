import { Trans } from "@palamedes/react/macro";
import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

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
  facts,
}: {
  model: EnvironmentSpeechModel;
  languages: readonly string[];
  /** Plain facts, such as language count and size, shown after the scores. */
  facts: readonly string[];
}) {
  const data = model.benchmark;
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
                <Trans>
                  <strong className="font-medium text-foreground">{score.grade}</strong> (
                  {score.errorPercent}% error)
                </Trans>
              </>
            ) : (
              <Trans>not benchmarked</Trans>
            )}
          </span>
        );
      })}
      {data ? (
        <span>
          {data.secondsPer30s === null ? (
            <Trans>Speed: not benchmarked</Trans>
          ) : (
            <Trans>
              Speed: <strong className="font-medium text-foreground">{data.secondsPer30s} s</strong>{" "}
              / 30 s
            </Trans>
          )}
        </span>
      ) : null}
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
