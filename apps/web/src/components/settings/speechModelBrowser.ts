import type { EnvironmentSpeechModel, SpeechBenchmarkTier } from "@t3tools/contracts";

export type SpeechModelSort = "recommended" | "size" | "accuracy" | "speed";

const modelSortOrder = (model: EnvironmentSpeechModel) => {
  if (model.active) return 0;
  if (model.state === "installed") return 1;
  if (model.state === "downloading" || model.state === "verifying") return 2;
  return model.recommended ? 3 : 4;
};

export function filterSpeechModels(
  models: readonly EnvironmentSpeechModel[],
  options: {
    readonly search: string;
    readonly languages: readonly string[];
    readonly downloadedOnly: boolean;
    readonly sort: SpeechModelSort;
    readonly accuracyLanguage: string;
    readonly benchmarkTier: SpeechBenchmarkTier;
  },
) {
  const query = options.search.trim().toLocaleLowerCase();
  const score = (model: EnvironmentSpeechModel) => {
    switch (options.sort) {
      case "size":
        return model.size;
      case "accuracy":
        return model.benchmark?.accuracy[options.accuracyLanguage]?.errorPercent ?? Infinity;
      case "speed":
        return model.benchmark?.secondsPer30s[options.benchmarkTier] ?? Infinity;
      case "recommended":
        return modelSortOrder(model);
    }
  };
  return models
    .filter(
      (model) =>
        options.languages.every((language) => model.languages.includes(language)) &&
        (!options.downloadedOnly || model.state === "installed") &&
        (!query || (model.name + " " + model.description).toLocaleLowerCase().includes(query)),
    )
    .toSorted(
      (left, right) => score(left) - score(right) || modelSortOrder(left) - modelSortOrder(right),
    );
}
