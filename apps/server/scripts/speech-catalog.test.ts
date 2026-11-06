// @effect-diagnostics nodeBuiltinImport:off - compares the generated bundle directly with its checked-in bytes.
import * as NodeFS from "node:fs";

import { catalog } from "@handy-computer/models";
import { expect, it } from "vite-plus/test";

import manifest from "../package.json" with { type: "json" };
import { generateSpeechCatalog, renderSpeechCatalog } from "./speech-catalog.ts";

const generate = (models = catalog.models) =>
  generateSpeechCatalog(
    { ...catalog.data, models },
    manifest.devDependencies["@handy-computer/models"],
    manifest.dependencies["transcribe-cpp"],
  );

it("reproduces the bundled registry byte for byte without upstream requests", async () => {
  expect(NodeFS.readFileSync(new URL("../src/speech/catalog.json", import.meta.url), "utf8")).toBe(
    await renderSpeechCatalog(
      catalog.data,
      manifest.devDependencies["@handy-computer/models"],
      manifest.dependencies["transcribe-cpp"],
    ),
  );
  for (const model of generate().models) {
    const source = catalog.models.find((entry) => entry.repository === model.id)!;
    expect(model).toMatchObject({
      revision: source.revision,
      name: source.name,
      ...source.files[source.quant],
      supportsStreaming: source.capabilities.streaming,
      supportsLanguageDetection: source.capabilities.languageDetection,
      supportsTranslation: source.capabilities.translate,
    });
  }
  const parakeet = catalog.models[0]!;
  const withoutFrenchOrSpeed = generateSpeechCatalog(
    {
      ...catalog.data,
      models: [{ ...parakeet, languages: ["en", "fr"] }],
      results: { [parakeet.id]: { accuracy: { en: { error: 3.99 } }, performance: {} } },
    },
    "0.2.3",
    "0.4.1",
  );
  expect(withoutFrenchOrSpeed.models[0]?.benchmark).toEqual({
    accuracy: { en: { grade: "A-", errorPercent: 3.99 } },
    secondsPer30s: null,
  });
  expect(generate().models[0]?.benchmark.secondsPer30s).toBeCloseTo(1.19, 2);
});

it("filters restricted licenses, unsupported roles, engines, architectures and files", () => {
  const model = catalog.models[0]!;
  for (const override of [
    { role: "langid" as const },
    { role: "vad" as const },
    { role: "diarize" as const },
    { license: "cc-by-nc-4.0" },
    { license: "CC-BY-NC-SA-4.0" },
    { license: "cc-by-nc-nd-3.0" },
    { license: "cc-by-nc" },
    { license: "CC BY-NC 4.0" },
    { license: "custom_NC" },
    { minEngine: "0.4.2" },
    { minEngine: "0.5.0" },
    { family: "future_arch" },
    ...[
      "nested/model.gguf",
      "nested\\model.gguf",
      "../model.gguf",
      "model.bin",
      "model.safetensors",
    ].map((filename) => ({ files: { [model.quant]: { ...model.files[model.quant]!, filename } } })),
  ]) {
    expect(generate([{ ...model, ...override }]).models).toEqual([]);
  }
  for (const license of ["other", "apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "unlicense"]) {
    expect(generate([{ ...model, license, minEngine: "0.4.1" }]).models).toHaveLength(1);
  }
  const moonshine = catalog.models.find((entry) => entry.id === "moonshine-tiny-ja")!;
  for (const [id, allowed] of [
    ["moonshine-tiny-ja", false],
    ["moonshine-base-vi", false],
    ["moonshine-base-es", false],
    ["moonshine-base", true],
    ["moonshine-streaming-tiny-ja", true],
  ] as const) {
    const entry = { ...moonshine, id, repository: `handy-computer/${id}-gguf`, license: "mit" };
    expect(generate([entry]).models, id).toHaveLength(allowed ? 1 : 0);
  }
});

it("rejects missing defaults, unpinned or corrupt metadata, collisions, and unreviewed engine/schema changes", () => {
  const model = catalog.models[0]!;
  const file = model.files[model.quant]!;
  for (const override of [
    { files: {} },
    { revision: "main" },
    { repository: "../model" },
    { languages: [] },
    ...[{ sha256: "bad" }, { size: 0 }, { size: 1.5 }].map((entry) => ({
      files: { [model.quant]: { ...file, ...entry } },
    })),
  ]) {
    expect(() => generate([{ ...model, ...override }])).toThrow();
  }
  expect(() => generate([model, model])).toThrow(/Duplicate/);
  expect(() => generate([model, { ...model, repository: "handy-computer/another" }])).toThrow(
    /Duplicate/,
  );
  expect(() => generateSpeechCatalog(catalog.data, "0.2.3", "0.4.2")).toThrow(/loader support/);
  expect(() =>
    generateSpeechCatalog({ ...catalog.data, schema: 3 as 2 }, "0.2.3", "0.4.1"),
  ).toThrow(/schema/);
});
