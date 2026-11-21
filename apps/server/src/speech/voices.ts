import catalog from "./voices.json" with { type: "json" };

export const SPEECH_VOICES = catalog.voices.map((voice) => ({
  ...voice,
  size: voice.files.reduce((size, file) => size + file.size, 0),
  modelCardUrl: `https://huggingface.co/${catalog.repository}/blob/${catalog.revision}/${voice.files.find((file) => file.sourceFilename.endsWith("MODEL_CARD"))!.sourceFilename}`,
  files: voice.files.map((file) => ({
    ...file,
    id: catalog.repository,
    revision: catalog.revision,
  })),
}));
