import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { filterSpeechModels } from "./speechModelBrowser";

const model: EnvironmentSpeechModel = {
  id: "active",
  name: "Active",
  description: "Local transcription",
  size: 300,
  languages: ["en", "fr"],
  accuracy: 1,
  speed: 1,
  recommended: false,
  supportsStreaming: false,
  supportsLanguageDetection: false,
  supportsTranslation: false,
  active: true,
  state: "installed",
};
const models: readonly EnvironmentSpeechModel[] = [
  model,
  {
    ...model,
    id: "small",
    name: "Small",
    size: 100,
    active: false,
    state: "downloadable",
    recommended: true,
    benchmark: {
      accuracy: {
        en: { grade: "A", errorPercent: 3.8 },
        fr: { grade: "B", errorPercent: 8 },
      },
      secondsPer30s: { cpu: 2, accelerated: 2 },
    },
  },
  {
    ...model,
    id: "fast",
    name: "Fast",
    size: 200,
    active: false,
    benchmark: {
      accuracy: {
        en: { grade: "A", errorPercent: 3.2 },
        fr: { grade: "B", errorPercent: 9 },
      },
      secondsPer30s: { cpu: 1, accelerated: 1 },
    },
  },
  {
    ...model,
    id: "pending",
    name: "Pending",
    size: 400,
    active: false,
    state: "verifying",
    languages: ["en"],
    benchmark: { accuracy: {}, secondsPer30s: { cpu: null, accelerated: null } },
  },
];

it.each([
  ["recommended", "en", ["active", "fast", "pending", "small"]],
  ["size", "en", ["small", "fast", "active", "pending"]],
  ["speed", "en", ["fast", "small", "active", "pending"]],
  ["accuracy", "en", ["fast", "small", "active", "pending"]],
  ["accuracy", "fr", ["small", "fast", "active", "pending"]],
] as const)(
  "sorts by %s for %s with missing benchmarks last",
  (sort, accuracyLanguage, expected) => {
    expect(
      filterSpeechModels(models, {
        search: "",
        languages: [],
        downloadedOnly: false,
        sort,
        accuracyLanguage,
        benchmarkTier: "accelerated",
      }).map((entry) => entry.id),
    ).toEqual(expected);
    expect(models[0]?.id).toBe("active");
  },
);

it("combines text, all selected languages, and completed downloads without retaining the active model", () => {
  const options = {
    search: "  LOCAL  ",
    languages: ["en", "fr"],
    downloadedOnly: true,
    sort: "size",
    accuracyLanguage: "en",
    benchmarkTier: "accelerated",
  } as const;
  expect(filterSpeechModels(models, options).map((entry) => entry.id)).toEqual(["fast", "active"]);
  expect(
    filterSpeechModels(models, { ...options, search: "fast" }).map((entry) => entry.id),
  ).toEqual(["fast"]);
  expect(filterSpeechModels(models, { ...options, search: "small" })).toEqual([]);
});
