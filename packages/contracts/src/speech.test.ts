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
  { measurement: 2.1, expected: { accelerated: 2.1 } },
  { measurement: null, expected: { accelerated: null } },
  { measurement: { cpu: 5, accelerated: 2.1 }, expected: { cpu: 5, accelerated: 2.1 } },
])("decodes speech benchmark measurements $measurement", ({ measurement, expected }) => {
  const model = {
    id: "test",
    name: "Test",
    description: "",
    size: 100,
    languages: ["en"],
    accuracy: 0,
    speed: 0,
    benchmark: { accuracy: { en: { grade: "A-", errorPercent: 4 } }, secondsPer30s: measurement },
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: false,
    active: true,
    state: "installed",
  };
  const decoded = decodeModel(model);
  expect(decoded.benchmark).toEqual({ ...model.benchmark, secondsPer30s: expected });
  expect(encodeModel(decoded)).toMatchObject({
    benchmark: { secondsPer30s: expected },
  });
  for (const secondsPer30s of ["2.1", { cpu: 5 }, Number.NaN]) {
    expect(() =>
      decodeModel({
        ...model,
        benchmark: { ...model.benchmark, secondsPer30s },
      }),
    ).toThrow();
  }
});
