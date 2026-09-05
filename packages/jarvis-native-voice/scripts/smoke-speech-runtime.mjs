// oxlint-disable t3code/no-global-process-runtime -- standalone speech runtime smoke.
// Standalone speech runtime smoke. Checks Parakeet recognition loads and the
// Pocket daemon starts, synthesizes one short utterance, and emits valid WAV.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const require = NodeModule.createRequire(import.meta.url);
const cpal = require("node-cpal");
const sherpa = require("sherpa-onnx-node");
const resourceRoot = process.argv[2] ?? NodePath.resolve(import.meta.dirname, "../resources");
const parakeet = NodePath.resolve(resourceRoot, "parakeet");
const pocket = NodePath.resolve(resourceRoot, "pocket");
const daemonName = process.platform === "win32" ? "jarvis-pocket-tts.exe" : "jarvis-pocket-tts";

const hosts = cpal.getHosts();
if (!Array.isArray(hosts)) throw new Error("node-cpal did not load its native audio backend.");

const recognizer = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: NodePath.resolve(parakeet, "encoder.int8.onnx"),
      decoder: NodePath.resolve(parakeet, "decoder.int8.onnx"),
      joiner: NodePath.resolve(parakeet, "joiner.int8.onnx"),
    },
    tokens: NodePath.resolve(parakeet, "tokens.txt"),
    numThreads: 2,
    provider: "cpu",
    debug: false,
  },
});
const stream = recognizer.createStream();
stream.acceptWaveform({ samples: new Float32Array(16_000), sampleRate: 16_000 });
await recognizer.decodeAsync(stream);

const daemon = NodeChildProcess.spawn(
  NodePath.join(pocket, "bin", daemonName),
  [
    "--models",
    NodePath.join(pocket, "models"),
    "--voice",
    NodePath.join(pocket, "voices", "alba-casual-3s.wav"),
  ],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
const lines = NodeReadline.createInterface({ input: daemon.stdout });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Pocket daemon did not become ready.")),
    60_000,
  );
  lines.on("line", (line) => {
    try {
      if (JSON.parse(line).type === "ready") {
        clearTimeout(timeout);
        resolve(undefined);
      }
    } catch {
      // Diagnostics are ignored; only the ready event matters.
    }
  });
  daemon.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Pocket daemon exited during smoke (exit ${code ?? "unknown"}).`));
  });
});
const outputDirectory = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "jarvis-pocket-smoke-"),
);
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Pocket smoke synthesis timed out.")), 120_000);
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "synthesis-finished") {
        clearTimeout(timeout);
        resolve(event);
      } else if (event.type === "failed") {
        clearTimeout(timeout);
        reject(new Error(event.message));
      }
    } catch {
      // Chunk events and diagnostics are ignored here.
    }
  });
  daemon.stdin.write(
    `${JSON.stringify({ type: "synthesize", requestId: "smoke", text: "Jarvis voice is ready.", outputDirectory })}\n`,
  );
});
daemon.stdin.write('{"type":"shutdown"}\n');
await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
if (result.chunkCount < 1 || result.totalSamples < 1) {
  throw new Error("Pocket loaded but did not synthesize audio.");
}

console.log(
  `Speech runtime smoke passed (${hosts.length} audio host(s), ${result.totalSamples} Pocket samples in ${result.chunkCount} chunks).`,
);
process.exit(0);
