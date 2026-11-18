import type { EnvironmentSpeechModel, SpeechBenchmarkTier } from "@t3tools/contracts";
import { T, useLocale, Var } from "gt-react";

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

export function orderSpeechLanguages(
  languages: readonly string[],
  preferred: readonly string[],
  locale = "en",
) {
  const order = [...new Set([...preferred, ...commonLanguages])];
  const rank = new Map(order.map((code, index) => [code, index]));
  return languages.toSorted(
    (left, right) =>
      (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length) ||
      languageLabel(left, locale).localeCompare(languageLabel(right, locale)),
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
  tier: SpeechBenchmarkTier | undefined;
  /** Plain facts, such as language count and size, shown after the scores. */
  facts: readonly string[];
}) {
  const locale = useLocale();
  const data = model.benchmark;
  const seconds = tier === undefined ? undefined : data?.secondsPer30s[tier];
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
            {score ? (
              <T>
                <Var>{languageLabel(code, locale)}</Var>:{" "}
                <Text variant="meta" tone="strong" emphasis>
                  <Var>{score.grade}</Var>
                </Text>{" "}
                (<Var>{score.errorPercent}</Var>% error)
              </T>
            ) : (
              <T>
                <Var>{languageLabel(code, locale)}</Var>: not benchmarked
              </T>
            )}
          </span>
        );
      })}
      {data ? (
        <span>
          {seconds === undefined ? (
            <T>Speed: update server for this benchmark</T>
          ) : seconds === null ? (
            <T>Speed: not benchmarked</T>
          ) : (
            <T>
              Speed:{" "}
              <Text variant="meta" tone="strong" emphasis>
                <Var>{Number(seconds.toFixed(2))}</Var> s
              </Text>{" "}
              / 30 s
            </T>
          )}
        </span>
      ) : null}
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
