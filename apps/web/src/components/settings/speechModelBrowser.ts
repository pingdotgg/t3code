import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import { recommendSpeechModels } from "@t3tools/shared/speech";

export type SpeechModelSort = "recommended" | "size" | "accuracy" | "speed";

const modelSortOrder = (model: EnvironmentSpeechModel) => {
  if (model.active) return 0;
  if (model.state === "installed") return 1;
  if (model.state === "downloading" || model.state === "verifying") return 2;
  return 3;
};

export function filterSpeechModels(
  models: readonly EnvironmentSpeechModel[],
  options: {
    readonly search: string;
    readonly languages: readonly string[];
    readonly downloadedOnly: boolean;
    readonly sort: SpeechModelSort;
    readonly accuracyLanguage: string;
  },
  recommendations = recommendSpeechModels(models, options.languages),
) {
  const query = options.search.trim().toLocaleLowerCase();
  const ranks = new Map([...recommendations.keys()].map((id, index) => [id, index]));
  const score = (model: EnvironmentSpeechModel) => {
    switch (options.sort) {
      case "size":
        return model.size;
      case "accuracy":
        return model.benchmark?.accuracy[options.accuracyLanguage]?.errorPercent ?? Infinity;
      case "speed":
        return model.benchmark?.secondsPer30s ?? Infinity;
      case "recommended":
        return modelSortOrder(model) * 4 + (ranks.get(model.id) ?? 3);
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
