import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "./speech.ts";

const decodeStatus = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
const encodeStatus = Schema.encodeSync(EnvironmentSpeechStatus);
const decodeModel = Schema.decodeUnknownSync(EnvironmentSpeechModel);
const encodeModel = Schema.encodeSync(EnvironmentSpeechModel);

const legacyStatus = {
  supported: true,
  state: "ready",
  modelId: "test",
  model: "Test",
  size: 100,
  supportsStreaming: false,
  supportsTranslation: false,
  acceleration: "auto",
  modelUnloadTimeout: "never",
  gpuDevices: [],
};
const gpuDevices = [{ id: "gpu", name: "Remote GPU" }];

it.each([
  { acceleration: "cpu", gpuDevices, tier: "cpu" },
  { acceleration: "auto", gpuDevices: [], tier: "cpu" },
  { acceleration: "auto", gpuDevices, tier: "accelerated" },
  { acceleration: "gpu:gpu", gpuDevices: [], tier: "accelerated" },
])("decodes legacy speech status for $acceleration with $gpuDevices", ({ tier, ...settings }) => {
  const status = decodeStatus({
    ...legacyStatus,
    ...settings,
  });
  expect(status).toMatchObject({ ...settings, benchmarkTier: tier });
  expect(encodeStatus(status)).toMatchObject({ benchmarkTier: tier });

  const fallback = { ...legacyStatus, ...settings, benchmarkTier: "cpu" };
  expect(decodeStatus(fallback)).toEqual(fallback);
  expect(() =>
    decodeStatus({
      ...legacyStatus,
      benchmarkTier: "unknown",
    }),
  ).toThrow();
});

it.each([
  { wire: { secondsPer30s: 2.1 }, expected: { accelerated: 2.1 } },
  { wire: { secondsPer30s: null }, expected: { accelerated: null } },
  { wire: { secondsPer30s: 2.1, cpuSecondsPer30s: 5 }, expected: { cpu: 5, accelerated: 2.1 } },
  {
    wire: { secondsPer30s: null, cpuSecondsPer30s: null },
    expected: { cpu: null, accelerated: null },
  },
  {
    wire: { secondsPer30s: { cpu: 5, accelerated: 2.1 } },
    expected: { cpu: 5, accelerated: 2.1 },
  },
  { wire: { secondsPer30s: { accelerated: 2.1 } }, expected: { accelerated: 2.1 } },
])("keeps speech benchmark $wire compatible with old and new clients", ({ wire, expected }) => {
  const model = {
    id: "test",
    name: "Test",
    description: "",
    size: 100,
    languages: ["en"],
    accuracy: 0,
    speed: 0,
    benchmark: { accuracy: { en: { grade: "A-", errorPercent: 4 } }, ...wire },
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
    active: true,
    state: "installed",
  };
  const decoded = decodeModel(model);
  expect(decoded.benchmark).toEqual({
    accuracy: model.benchmark.accuracy,
    secondsPer30s: expected,
  });
  const encoded = encodeModel(decoded);
  const legacyBenchmark = Schema.Struct({ secondsPer30s: Schema.NullOr(Schema.Finite) });
  expect(Schema.decodeUnknownSync(legacyBenchmark)(encoded.benchmark)).toEqual({
    secondsPer30s: expected.accelerated,
  });
  expect(decodeModel(encoded)).toEqual(decoded);
  for (const secondsPer30s of ["2.1", { cpu: 5 }, Number.NaN]) {
    expect(() =>
      decodeModel({
        ...model,
        benchmark: { ...model.benchmark, secondsPer30s },
      }),
    ).toThrow();
  }
});
