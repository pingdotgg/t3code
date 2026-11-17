import type { EnvironmentSpeechModel, SpeechBenchmarkTier } from "@t3tools/contracts";
import { T, Var } from "gt-react";

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
            {score ? (
              <T>
                <Var>{languageLabel(code)}</Var>:{" "}
                <strong className="font-medium text-foreground">
                  <Var>{score.grade}</Var>
                </strong>{" "}
                (<Var>{score.errorPercent}</Var>% error)
              </T>
            ) : (
              <T>
                <Var>{languageLabel(code)}</Var>: not benchmarked
              </T>
            )}
          </span>
        );
      })}
      <span>
        {tier === "cpu" && data && data.secondsPer30s.cpu === undefined ? (
          <T>Speed: update server</T>
        ) : seconds == null ? (
          <T>Speed: not benchmarked</T>
        ) : (
          <T>
            Speed:{" "}
            <strong className="font-medium text-foreground">
              <Var>{seconds}</Var> s
            </strong>{" "}
            / 30 s
          </T>
        )}
      </span>
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
