import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Text } from "../ui/text";
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
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={selected}
      data-pressed={selected || undefined}
      onClick={onClick}
      className="shrink-0 justify-between"
    >
      {label}
      {selected && <CheckIcon />}
    </Button>
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
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground tabular-nums">
      {visible.map((code) => {
        const score = data?.accuracy[code];
        return (
          <span key={code}>
            {languageLabel(code)}:{" "}
            {score ? (
              <>
                <Text variant="meta" tone="strong" emphasis>
                  {score.grade}
                </Text>{" "}
                ({score.errorPercent}% error)
              </>
            ) : (
              "not benchmarked"
            )}
          </span>
        );
      })}
      {data ? (
        <span>
          Speed:{" "}
          {data.secondsPer30s === null ? (
            "not benchmarked"
          ) : (
            <>
              <Text variant="meta" tone="strong" emphasis>
                {data.secondsPer30s} s
              </Text>{" "}
              / 30 s
            </>
          )}
        </span>
      ) : null}
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
