// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off -- standalone catalog maintenance command.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

const repository = "rhasspy/piper-voices";
const revision = "e9ab671f2a0e50a701b34361136ba3e6a3a9eb0c";
const root = `https://huggingface.co/${repository}/resolve/${revision}`;

type Voice = {
  key: string;
  name: string;
  language: { code: string; name_english: string; country_english: string };
  quality: string;
  num_speakers: number;
  files: Record<string, { size_bytes: number }>;
};
const response = await fetch(`${root}/voices.json`);
if (!response.ok) throw new Error(`Voice catalog: HTTP ${response.status}`);
const upstream = (await response.json()) as Record<string, Voice>;
const quality = ["medium", "high", "low", "x_low"];
const voices = new Map<string, Voice>();
for (const voice of Object.values(upstream)) {
  if (voice.num_speakers !== 1) continue;
  const key = `${voice.language.code}/${voice.name}`;
  const previous = voices.get(key);
  if (!previous || quality.indexOf(voice.quality) < quality.indexOf(previous.quality))
    voices.set(key, voice);
}
const selected = [...voices.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
const paths = selected.flatMap((voice) => Object.keys(voice.files));
const metadata = new Map<string, { size: number; lfs?: { oid: string } }>();
for (let offset = 0; offset < paths.length; offset += 100) {
  const result = await fetch(
    `https://huggingface.co/api/models/${repository}/paths-info/${revision}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: paths.slice(offset, offset + 100), expand: false }),
    },
  );
  if (!result.ok) throw new Error(`Voice metadata: HTTP ${result.status}`);
  for (const file of (await result.json()) as Array<{
    path: string;
    size: number;
    lfs?: { oid: string };
  }>)
    metadata.set(file.path, file);
}
const results = new Map<string, string>();
const smallFiles = paths.filter((path) => !metadata.get(path)?.lfs);
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < smallFiles.length) {
      const path = smallFiles[next++]!;
      const response = await fetch(`${root}/${path}`);
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== metadata.get(path)?.size) throw new Error(`${path}: size changed`);
      results.set(path, NodeCrypto.createHash("sha256").update(data).digest("hex"));
    }
  }),
);
const catalog = {
  repository,
  revision,
  voices: selected.map((voice) => ({
    id: voice.key,
    name: voice.name,
    language: voice.language.code.replace("_", "-"),
    languageName: `${voice.language.name_english} (${voice.language.country_english})`,
    quality: voice.quality,
    files: Object.keys(voice.files).map((path) => {
      const info = metadata.get(path);
      const sha256 = info?.lfs?.oid ?? results.get(path);
      if (!info || !sha256) throw new Error(`Missing metadata: ${path}`);
      return {
        filename: `piper-${voice.key}${path.endsWith(".onnx") ? ".onnx" : path.endsWith(".onnx.json") ? ".onnx.json" : ".modelcard"}`,
        sourceFilename: path,
        size: info.size,
        sha256,
      };
    }),
  })),
};
await NodeFSP.writeFile(
  new URL("../src/speech/voices.json", import.meta.url),
  JSON.stringify(catalog, null, 2) + "\n",
);
console.log(`Pinned ${catalog.voices.length} Piper voices at ${revision}.`);
