// oxlint-disable t3code/no-global-process-runtime -- standalone resource preparation script.
// Downloads the pinned Pocket model set, derives the Alba voice reference and
// the voice-bias vector, and stages the reproducibly built daemon. Model
// binaries are never committed; this script recreates resources/pocket.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

const EXPORT_COMMIT = "fc68ee7e5a0a29662e218df84b24acb311f7fb6d";
const BUNDLE = "onnx/english_2026-04";
const base = `https://huggingface.co/stephvax/pocket-tts-onnx/resolve/${EXPORT_COMMIT}/${BUNDLE}`;
const modelFiles = [
  ["bundle.json", "ed35ae173f111c59d03cf967997e3dc8c87d9967ed8b3d89a0400ff606223ff8"],
  ["text_conditioner.onnx", "6d66994acc358324667e22c56358125acd3e6d219f013e110dbc7b542595c3a2"],
  ["flow_lm_main_int8.onnx", "afe52e2e562aabac08bfb24f89ead5b5853e21272115b3ba07a87151f5d024c8"],
  ["flow_lm_flow.onnx", "cd2a6e2704621088778f4b6e969736a7117a2b75e6127349281b84d8969df36f"],
  ["mimi_decoder.onnx", "25f979e6cca20742ded65edb7b963fba705c36ce420229df7edf3dc52c397bf0"],
  ["mimi_encoder.onnx", "b56b98a160e880bba760c0f39406378b0e01473b648f58703f8c49ebbc5bafe8"],
  ["tokenizer.model", "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6"],
  ["bos_before_voice.npy", "f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1"],
];
const voiceSourceUrl =
  "https://huggingface.co/kyutai/tts-voices/resolve/main/alba-mackenna/casual.wav";

const resourceBase = process.argv[2] ?? NodePath.resolve(import.meta.dirname, "../resources");
const resourceRoot = NodePath.resolve(resourceBase, "pocket");
const markerPath = NodePath.join(resourceRoot, ".resources-sha256");

async function sha256File(path) {
  const contents = await NodeFSP.readFile(path);
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

async function downloadVerified(url, destination, expectedHash, label) {
  const temporaryPath = `${destination}.download`;
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.rm(temporaryPath, { force: true });
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download ${label}: ${response.status} ${response.statusText}`);
  }
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body),
    NodeFS.createWriteStream(temporaryPath),
  );
  if (expectedHash !== undefined && (await sha256File(temporaryPath)) !== expectedHash) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw new Error(`${label} failed its SHA-256 check.`);
  }
  await NodeFSP.rename(temporaryPath, destination);
}

function parseWav(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Voice reference is not a WAV file.");
  }
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const format = bytes.readUInt16LE(20);
  const bits = bytes.readUInt16LE(34);
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset === -1) throw new Error("Voice reference WAV has no data chunk.");
  const available = bytes.length - dataOffset;
  const length = Math.min(dataLength, available);
  let mono;
  if (format === 3 && bits === 32) {
    const frames = Math.floor(length / 4 / channels);
    mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let total = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        total += bytes.readFloatLE(dataOffset + (frame * channels + channel) * 4);
      }
      mono[frame] = total / channels;
    }
  } else if (format === 1 && bits === 16) {
    const frames = Math.floor(length / 2 / channels);
    mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let total = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        total += bytes.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32_768;
      }
      mono[frame] = total / channels;
    }
  } else {
    throw new Error(`Voice reference has unsupported WAV format (${format}/${bits}).`);
  }
  return { samples: mono, sampleRate };
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const count = Math.floor((samples.length * toRate) / fromRate);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const position = (index * fromRate) / toRate;
    const before = Math.floor(position);
    const after = Math.min(samples.length - 1, before + 1);
    const fraction = position - before;
    output[index] = (samples[before] ?? 0) * (1 - fraction) + (samples[after] ?? 0) * fraction;
  }
  return output;
}

function encodeWav16Mono(samples, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    body.writeInt16LE(Math.round(clamped * 32_767), index * 2);
  }
  return Buffer.concat([header, body]);
}

function npyFloat32(bytes) {
  if (bytes.length < 10 || bytes.toString("latin1", 0, 6) !== "\x93NUMPY") {
    throw new Error("Voice bias is not a NumPy file.");
  }
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.toString("latin1", 10, 10 + headerLength);
  if (!header.includes("float32") && !header.includes("<f4")) {
    throw new Error("Voice bias is not float32.");
  }
  const data = bytes.subarray(10 + headerLength);
  const count = Math.floor(data.length / 4);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) output[index] = data.readFloatLE(index * 4);
  return output;
}

const required = [
  "models/bundle.json",
  "models/text_conditioner.onnx",
  "models/flow_lm_main_int8.onnx",
  "models/flow_lm_flow.onnx",
  "models/mimi_decoder.onnx",
  "models/mimi_encoder.onnx",
  "models/tokenizer.model",
  "models/bos_before_voice.npy",
  "models/bos_before_voice.f32",
  "voices/alba-casual-3s.wav",
  "bin/jarvis-pocket-tts",
];

const daemonName = process.platform === "win32" ? "jarvis-pocket-tts.exe" : "jarvis-pocket-tts";
const nextRoot = `${resourceRoot}.next`;
await NodeFSP.rm(nextRoot, { recursive: true, force: true });
await NodeFSP.mkdir(NodePath.join(nextRoot, "models"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(nextRoot, "voices"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(nextRoot, "bin"), { recursive: true });

// Fast path: everything already staged and pinned.
const markerWanted = async () => {
  const hashes = [];
  for (const [file] of modelFiles) {
    const staged = NodePath.join(resourceRoot, "models", file);
    if (!NodeFS.existsSync(staged)) return undefined;
    hashes.push(`${file}:${await sha256File(staged)}`);
  }
  return `${hashes.join("\n")}\n`;
};
if (NodeFS.existsSync(markerPath)) {
  const [marker, wanted] = await Promise.all([
    NodeFSP.readFile(markerPath, "utf8").catch(() => ""),
    markerWanted(),
  ]);
  const daemonStaged = NodePath.join(resourceRoot, "bin", daemonName);
  const voiceStaged = NodePath.join(resourceRoot, "voices", "alba-casual-3s.wav");
  const biasStaged = NodePath.join(resourceRoot, "models", "bos_before_voice.f32");
  if (
    wanted !== undefined &&
    marker === wanted &&
    NodeFS.existsSync(daemonStaged) &&
    NodeFS.existsSync(voiceStaged) &&
    NodeFS.existsSync(biasStaged)
  ) {
    process.exit(0);
  }
}

for (const [file, hash] of modelFiles) {
  const destination = NodePath.join(nextRoot, "models", file);
  await downloadVerified(`${base}/${file}`, destination, hash, `the Pocket model file ${file}`);
}
const bosNpy = await NodeFSP.readFile(NodePath.join(nextRoot, "models", "bos_before_voice.npy"));
const bos = npyFloat32(bosNpy);
if (bos.length !== 1024) throw new Error(`Voice bias has ${bos.length} values, expected 1024.`);
const bosRaw = Buffer.alloc(bos.length * 4);
for (let index = 0; index < bos.length; index += 1) bosRaw.writeFloatLE(bos[index] ?? 0, index * 4);
await NodeFSP.writeFile(NodePath.join(nextRoot, "models", "bos_before_voice.f32"), bosRaw);

const voiceDownload = NodePath.join(nextRoot, "voices", "casual-source.wav");
await downloadVerified(voiceSourceUrl, voiceDownload, undefined, "the Alba voice reference");
const source = parseWav(await NodeFSP.readFile(voiceDownload));
const mono24k = resampleLinear(source.samples, source.sampleRate, 24_000);
const first3s = mono24k.slice(0, 72_000);
if (first3s.length < 72_000) throw new Error("Alba voice reference is shorter than three seconds.");
await NodeFSP.writeFile(
  NodePath.join(nextRoot, "voices", "alba-casual-3s.wav"),
  encodeWav16Mono(first3s, 24_000),
);
await NodeFSP.rm(voiceDownload, { force: true });

const builtDaemon = NodePath.resolve(
  import.meta.dirname,
  `../native/pocket/build/install/bin/${daemonName}`,
);
if (!NodeFS.existsSync(builtDaemon)) {
  throw new Error(
    "The Pocket daemon is not built. Run: node packages/jarvis-native-voice/scripts/build-pocket-runtime.mjs",
  );
}
await NodeFSP.copyFile(builtDaemon, NodePath.join(nextRoot, "bin", daemonName));
if (process.platform !== "win32")
  await NodeFSP.chmod(NodePath.join(nextRoot, "bin", daemonName), 0o755);
const builtLibDir = NodePath.resolve(import.meta.dirname, "../native/pocket/build/install/lib");
await NodeFSP.mkdir(NodePath.join(nextRoot, "lib"), { recursive: true });
for (const lib of await NodeFSP.readdir(builtLibDir)) {
  if (!lib.startsWith("libonnxruntime")) continue;
  const source = NodePath.join(builtLibDir, lib);
  const destination = NodePath.join(nextRoot, "lib", lib);
  const stat = await NodeFSP.lstat(source);
  await NodeFSP.rm(destination, { force: true });
  if (stat.isSymbolicLink()) {
    await NodeFSP.symlink(await NodeFSP.readlink(source), destination);
  } else {
    await NodeFSP.copyFile(source, destination);
  }
}

const pinned = JSON.parse(
  await NodeFSP.readFile(
    NodePath.resolve(import.meta.dirname, "../native/pocket/PINNED_REVISIONS.json"),
    "utf8",
  ),
);
const voiceSha = await sha256File(NodePath.join(nextRoot, "voices", "alba-casual-3s.wav"));
await NodeFSP.writeFile(
  NodePath.join(nextRoot, "PROVENANCE.json"),
  `${JSON.stringify({ ...pinned, stagedVoiceSha256: voiceSha }, null, 2)}\n`,
  "utf8",
);

for (const name of required.map((file) =>
  file === "bin/jarvis-pocket-tts" ? `bin/${daemonName}` : file,
)) {
  if (!NodeFS.existsSync(NodePath.join(nextRoot, name))) {
    throw new Error(`The Pocket resource staging is missing ${name}.`);
  }
}
const marker = [];
for (const [file] of modelFiles) {
  marker.push(`${file}:${await sha256File(NodePath.join(nextRoot, "models", file))}`);
}
await NodeFSP.writeFile(
  NodePath.join(nextRoot, ".resources-sha256"),
  `${marker.join("\n")}\n`,
  "utf8",
);
await NodeFSP.rm(resourceRoot, { recursive: true, force: true });
await NodeFSP.rename(nextRoot, resourceRoot);
