// oxlint-disable t3code/no-global-process-runtime -- this file is the native voice boundary.
// @effect-diagnostics nodeBuiltinImport:off - path joins mirror packaged native resources.
// Pocket TTS production configuration. Pins the measured english_2026-04
// setup behind the existing native speech boundary. No absolute checkout,
// /tmp, or Python paths leak into the shipped runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const pocketEngineId = "pocket-2026-04" as const;
export const pocketSampleRate = 24_000;
export const pocketTemperature = 0.3;
export const pocketLsdSteps = 1;
export const pocketInferenceThreads = 2;
export const pocketFirstChunkFrames = 1;
export const pocketMaxChunkFrames = 3;
export const pocketMaxTokenPerChunk = 50;
export const pocketMaxFramesPerRequest = 500;
export const pocketMaxTextChars = 2_000;

// Bounded streaming leading-silence removal. Removes only the leading prefix,
// keeps a short preroll so quiet attacks survive, and preserves every later
// pause. Values come from the measured onset study.
export const pocketOnsetThresholdDbfs = -50;
export const pocketOnsetWindowMs = 10;
export const pocketOnsetPrerollMs = 40;
export const pocketOnsetMaxTrimMs = 2_000;

export const pocketIdleOffloadMs = 5 * 60_000;
export const pocketWorkerStartupTimeoutMs = 30_000;
export const pocketWorkerCloseTimeoutMs = 2_000;

export const pocketPinnedRuntime = "e801e7d6c2692121a39e80ae525cb5265174a495" as const;
export const pocketPinnedExports = "fc68ee7e5a0a29662e218df84b24acb311f7fb6d" as const;
export const pocketPinnedOrt = "1.23.2" as const;
export const pocketBundleName = "english_2026-04" as const;

export type PocketVoicePaths = {
  readonly resourceRoot: string;
  readonly modelsDir: string;
  readonly voiceFile: string;
  readonly daemonPath: string;
  readonly bundlePath: string;
  readonly tokenizerPath: string;
};

export function pocketDaemonName(platform: string = process.platform): string {
  return platform === "win32" ? "jarvis-pocket-tts.exe" : "jarvis-pocket-tts";
}

export function pocketVoicePaths(resourceRoot: string): PocketVoicePaths {
  const modelsDir = NodePath.join(resourceRoot, "models");
  return {
    resourceRoot,
    modelsDir,
    voiceFile: NodePath.join(resourceRoot, "voices", "alba-casual-3s.wav"),
    daemonPath: NodePath.join(resourceRoot, "bin", pocketDaemonName()),
    bundlePath: NodePath.join(modelsDir, "bundle.json"),
    tokenizerPath: NodePath.join(modelsDir, "tokenizer.model"),
  };
}

export function bundledPocketVoicePaths(inputResourceRoot?: string): PocketVoicePaths {
  if (inputResourceRoot !== undefined) return pocketVoicePaths(inputResourceRoot);
  const configuredRoot = process.env.JARVIS_POCKET_ROOT?.trim();
  if (configuredRoot !== undefined && configuredRoot.length > 0) {
    return pocketVoicePaths(configuredRoot);
  }
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: unknown })
    .resourcesPath;
  const packagedRoot =
    typeof resourcesPath === "string"
      ? NodePath.join(resourcesPath, "jarvis-resources", "pocket")
      : undefined;
  const resourceRoot =
    packagedRoot !== undefined &&
    NodeFS.existsSync(NodePath.join(packagedRoot, "models", "flow_lm_main_int8.onnx"))
      ? packagedRoot
      : NodePath.resolve(import.meta.dirname, "../resources/pocket");
  return pocketVoicePaths(resourceRoot);
}

const requiredPocketFiles = (paths: PocketVoicePaths): ReadonlyArray<readonly [string, string]> => [
  [NodePath.join(paths.modelsDir, "text_conditioner.onnx"), "Pocket text conditioner"],
  [NodePath.join(paths.modelsDir, "flow_lm_main_int8.onnx"), "Pocket language model"],
  [NodePath.join(paths.modelsDir, "flow_lm_flow.onnx"), "Pocket flow network"],
  [NodePath.join(paths.modelsDir, "mimi_decoder.onnx"), "Pocket audio decoder"],
  [NodePath.join(paths.modelsDir, "mimi_encoder.onnx"), "Pocket voice encoder"],
  [NodePath.join(paths.modelsDir, "bos_before_voice.npy"), "Pocket voice bias"],
  [paths.tokenizerPath, "Pocket tokenizer"],
  [paths.bundlePath, "Pocket model bundle"],
  [paths.voiceFile, "Pocket Alba voice reference"],
  [paths.daemonPath, "Pocket speech runtime"],
];

export function pocketResourceError(paths: PocketVoicePaths): Error | undefined {
  const missing = requiredPocketFiles(paths).find(([path]) => !NodeFS.existsSync(path));
  return missing === undefined
    ? undefined
    : new Error(
        `Jarvis voice is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis.`,
      );
}

// Upgrades from Kokoro installs reuse the same voice directory layout. Pocket
// resources live beside the retired Kokoro directory, so an upgrade never
// requires manual cache deletion. Stale Kokoro files are simply not read.
export function retiredKokoroRootForPocket(paths: PocketVoicePaths): string {
  return NodePath.join(NodePath.dirname(paths.resourceRoot), "kokoro");
}
