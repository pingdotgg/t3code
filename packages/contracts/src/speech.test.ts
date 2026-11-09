import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "./speech.ts";

const model = {
  id: "test",
  name: "Test",
  description: "",
  size: 100,
  languages: ["en"],
  accuracy: 0,
  speed: 0,
  recommended: false,
  supportsStreaming: false,
  supportsLanguageDetection: false,
  supportsTranslation: false,
  active: false,
  state: "downloadable",
};
const decodeModel = Schema.decodeUnknownSync(EnvironmentSpeechModel);
const encodeModel = Schema.encodeSync(EnvironmentSpeechModel);

it.each([
  { secondsPer30s: 2, expected: { accelerated: 2 } },
  { secondsPer30s: null, expected: { accelerated: null } },
  { secondsPer30s: 2, cpuSecondsPer30s: 5, expected: { cpu: 5, accelerated: 2 } },
  { secondsPer30s: null, cpuSecondsPer30s: null, expected: { cpu: null, accelerated: null } },
  { secondsPer30s: { cpu: 5, accelerated: 2 }, expected: { cpu: 5, accelerated: 2 } },
  { secondsPer30s: { accelerated: 2 }, expected: { accelerated: 2 } },
])(
  "normalizes benchmark $secondsPer30s and keeps old clients able to decode the response",
  ({ expected, ...measurement }) => {
    const decoded = decodeModel({ ...model, benchmark: { accuracy: {}, ...measurement } });
    expect(decoded.benchmark?.secondsPer30s).toEqual(expected);
    const encoded = encodeModel(decoded);
    const legacyBenchmark = Schema.Struct({ secondsPer30s: Schema.NullOr(Schema.Finite) });
    expect(Schema.decodeUnknownSync(legacyBenchmark)(encoded.benchmark)).toEqual({
      secondsPer30s: expected.accelerated,
    });
    expect(decodeModel(encoded)).toEqual(decoded);
  },
);

it("rejects malformed benchmark tiers and measurements", () => {
  for (const secondsPer30s of ["2", { cpu: 5 }, Number.NaN, { accelerated: 2, cpu: "5" }]) {
    expect(() => decodeModel({ ...model, benchmark: { accuracy: {}, secondsPer30s } })).toThrow();
  }
});

it.each([
  { acceleration: "cpu", gpuDevices: [{ id: "gpu", name: "GPU" }], expected: "cpu" },
  { acceleration: "auto", gpuDevices: [], expected: "cpu" },
  { acceleration: "auto", gpuDevices: [{ id: "gpu", name: "GPU" }], expected: "accelerated" },
  { acceleration: "gpu:gpu", gpuDevices: [], expected: "accelerated" },
])(
  "normalizes a legacy $acceleration status while trusting a server-reported tier",
  ({ expected, ...settings }) => {
    const status = {
      supported: true,
      state: "missing-model",
      modelId: "test",
      model: "Test",
      size: 100,
      supportsStreaming: false,
      supportsTranslation: false,
      modelUnloadTimeout: "never",
      ...settings,
    };
    const decode = Schema.decodeUnknownSync(EnvironmentSpeechStatus);
    expect(decode(status)).toMatchObject({ benchmarkTier: expected });
    expect(decode({ ...status, benchmarkTier: "cpu" })).toMatchObject({ benchmarkTier: "cpu" });
    expect(() => decode({ ...status, benchmarkTier: "unknown" })).toThrow();
  },
);
