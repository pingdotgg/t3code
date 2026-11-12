// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import type { SpeechStreamText } from "@t3tools/contracts";
import { createSpeechAudio } from "./audio.ts";

// Inline the small child entry so the packaged CLI does not need a separate worker artifact.
const entry = `
const createSpeechAudio = ${createSpeechAudio.toString()};
let speech;
let model;
let vadModel;
let vad;
let session;
let stream;
let audio;
let options;
let nativeStreaming;
let useVad;
let scored;
let revision;
let texts;
let heardAudio;
const warnVad = () => console.warn("Silero silence filtering unavailable; preserving raw recording and using bounded ASR chunks.");
const resetAsr = () => {
  if (stream) stream.reset();
  if (session) session.dispose();
  stream = session = undefined;
};
const newAudio = (filterSilence) => createSpeechAudio({
  frameSamples: 512, filterSilence, nativeStreaming: model.capabilities.supportsStreaming,
  longForm: model.supports("long_form"), maxAudioMs: model.capabilities.maxAudioMs,
});
const openAsr = async () => {
  if (nativeStreaming) {
    session = model.createSession();
    stream = await session.stream(options);
  }
};
const begin = async (message, live) => {
  resetAsr();
  options = message.options;
  nativeStreaming = live && model.capabilities.supportsStreaming;
  texts = [];
  scored = revision = 0;
  heardAudio = false;
  useVad = Boolean(message.vadPath) && (message.filterSilence ||
    (!model.capabilities.supportsStreaming && !model.supports("long_form")));
  if (useVad) {
    try {
      if (!vadModel) {
        vadModel = await speech.TranscribeModel.load(message.vadPath, { backend: "cpu" });
        if (vadModel.vadInfo.sampleRate !== 16000 || vadModel.vadInfo.frameSamples !== 512)
          throw new Error("Unsupported Silero model frames.");
        vad = vadModel.createVadSession({ nThreads: 1 });
      }
      await vad.streamReset();
    } catch {
      vad?.dispose();
      vadModel?.dispose();
      vad = vadModel = undefined;
      useVad = false;
      warnVad();
    }
  }
  audio = newAudio(useVad && message.filterSilence);
  await openAsr();
};
const transcribe = async (pcm) => {
  try {
    const result = await model.transcribe(pcm, options);
    texts.push(result.text);
  } catch (error) {
    if ((error?.constructor?.name !== "OutputTruncated" &&
         error?.constructor?.name !== "InputTooLong") || pcm.length <= 4000) throw error;
    const middle = Math.floor(pcm.length / 2);
    await transcribe(pcm.subarray(0, middle));
    await transcribe(pcm.subarray(middle));
  }
};
const decode = async (final) => {
  let preview = null;
  for (const pcm of audio.take(final)) {
    if (!pcm.length) continue;
    heardAudio = true;
    if (nativeStreaming) {
      const update = await stream.feed(pcm);
      if (update.committedChanged || update.tentativeChanged) {
        const text = stream.text;
        preview = { committed: text.committed, tentative: text.tentative };
      }
    } else {
      await transcribe(pcm);
      preview = { committed: texts.join(" ").trim(), tentative: "" };
    }
  }
  return preview;
};
const feed = async (pcm, final = false) => {
  if (pcm) audio.append(pcm);
  try {
    if (useVad) {
      if (pcm) {
        const result = await vad.streamFeed(pcm);
        audio.score(result.firstFrame, result.probs);
        if (result.firstFrame + result.probs.length !== Math.floor(audio.samples() / 512))
          throw new Error("Incomplete Silero frames.");
      }
      if (final) {
        const result = await vad.streamFlush();
        audio.score(result.firstFrame, result.probs);
        if (result.firstFrame + result.probs.length !== Math.ceil(audio.samples() / 512))
          throw new Error("Incomplete Silero tail.");
      }
    } else {
      const count = final ? Math.ceil(audio.samples() / 512) : Math.floor(audio.samples() / 512);
      audio.score(scored, new Array(count - scored).fill(1));
      scored = count;
    }
  } catch {
    // Replay on optional VAD failure, including audio it had withheld; ASR errors stay separate.
    const raw = audio.audio();
    useVad = false;
    warnVad();
    resetAsr();
    texts = [];
    heardAudio = false;
    audio = newAudio(false);
    audio.append(raw);
    scored = final ? Math.ceil(raw.length / 512) : Math.floor(raw.length / 512);
    audio.score(0, new Array(scored).fill(1));
    await openAsr();
  }
  return await decode(final);
};
process.on("message", async (message) => {
  try {
    if (message.kind === "load") {
      speech = await loadSpeechModule(message.moduleUrl);
      const { TranscribeModel, getAvailableBackends } = speech;
      const device = message.acceleration.startsWith("gpu:")
        ? getAvailableBackends().find((item) =>
            (item.deviceType === "gpu" || item.deviceType === "igpu") &&
            JSON.stringify([item.kind, item.deviceId ?? item.name]) === message.acceleration.slice(4))
        : undefined;
      if (message.acceleration.startsWith("gpu:") && !device)
        throw new Error("The selected speech GPU is unavailable.");
      model = await TranscribeModel.load(message.path, device ? { device } : { backend: message.acceleration });
      process.send({ type: "t3-speech-reply", ok: true, backend: model.backend,
        languages: model.capabilities.languages,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsLongForm: model.supports("long_form"),
        supportsTranslation: model.capabilities.supportsTranslate,
        supportsVocabulary: model.supports("vocabulary") });
    } else if (message.kind === "begin") {
      await begin(message, true);
      process.send({ type: "t3-speech-reply", ok: true });
    } else if (message.kind === "feed") {
      const preview = await feed(message.pcm);
      process.send({ type: "t3-speech-reply", ok: true, revision: ++revision, preview });
    } else if (message.kind === "finish") {
      await feed(undefined, true);
      if (nativeStreaming && heardAudio) await stream.finalize();
      const text = nativeStreaming ? (heardAudio ? stream.text.full : "") : texts.join(" ").trim();
      resetAsr();
      audio = undefined;
      process.send({ type: "t3-speech-reply", ok: true, text });
    } else if (message.kind === "reset") {
      resetAsr();
      if (vad) await vad.streamReset();
      audio = undefined;
      process.send({ type: "t3-speech-reply", ok: true });
    } else if (message.kind === "transcribe") {
      await begin(message, false);
      await feed(message.pcm, true);
      const text = texts.join(" ").trim();
      audio = undefined;
      process.send({ type: "t3-speech-reply", ok: true, text });
    }
  } catch (error) {
    process.send({ type: "t3-speech-reply", ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

type Reply = {
  readonly type: "t3-speech-reply";
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
  readonly supportsStreaming?: boolean;
  readonly supportsLongForm?: boolean;
  readonly supportsTranslation?: boolean;
  readonly supportsVocabulary?: boolean;
  readonly backend?: string;
  readonly languages?: unknown;
  readonly revision?: number;
  readonly preview?: SpeechStreamText | null;
};

// transcribe-cpp has an import-only export. Load its disk entry with require so
// Node SEA can reach it, including its native dependencies.
const loaderEntry = `
  const { createRequire, findPackageJSON } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const loadSpeechModule = async (moduleUrl) => {
    let speech;
    if (moduleUrl) speech = await import(moduleUrl);
    else {
      const packagePath = findPackageJSON("transcribe-cpp", baseUrl);
      if (!packagePath) throw new Error("The native speech package is unavailable.");
      speech = createRequire(packagePath)(join(dirname(packagePath), "dist/index.js"));
    }
    if (process.versions.electron && !process.env.TRANSCRIBE_LIBRARY) {
      const directory = speech.artifactDir();
      const unpacked = directory.replace(/\\.asar([\\\\/])/g, ".asar.unpacked$1");
      // Koffi opens native libraries outside Electron's ASAR-aware filesystem.
      if (unpacked !== directory) process.env.TRANSCRIBE_LIBRARY = join(unpacked,
        process.platform === "win32" ? "transcribe.dll"
          : process.platform === "darwin" ? "libtranscribe.dylib" : "libtranscribe.so");
    }
    return speech;
  };
`;

const discoveryEntry = `
  const { getAvailableBackends } = await loadSpeechModule(moduleUrl);
  process.send(getAvailableBackends().filter((device) =>
    device.deviceType === "gpu" || device.deviceType === "igpu").map((device) => ({
      id: JSON.stringify([device.kind, device.deviceId ?? device.name]),
      name: device.description || device.name,
    })));
`;

export async function runNativeSpeechWorker(mode: "discover" | "model", moduleUrl?: string) {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function(
    "baseUrl",
    "moduleUrl",
    `return (async () => {${loaderEntry}${mode === "discover" ? discoveryEntry : entry}})();`,
  ) as (baseUrl: string, moduleUrl?: string) => Promise<void>;
  await run(import.meta.url, moduleUrl);
}

function speechWorkerArgs(mode: "discover" | "model", moduleUrl?: string) {
  if (NodeSea.isSea()) return ["__speech-worker", mode, ...(moduleUrl ? [moduleUrl] : [])];
  // Normal Node and Electron hosts can evaluate the same entry without a sibling artifact.
  const loader = `const baseUrl = ${JSON.stringify(import.meta.url)};
    const moduleUrl = process.argv[1];${loaderEntry}`;
  return [
    "--input-type=module",
    "-e",
    loader + (mode === "discover" ? discoveryEntry : entry),
    ...(moduleUrl ? [moduleUrl] : []),
  ];
}

export async function listNativeSpeechGpuDevices(moduleUrl?: string) {
  const child = NodeChildProcess.spawn(process.execPath, speechWorkerArgs("discover", moduleUrl), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return await new Promise<{ id: string; name: string }[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Speech device discovery timed out."));
    }, 10_000);
    child.on("message", (devices: unknown) => {
      if (
        Array.isArray(devices) &&
        devices.every(
          (device: unknown) =>
            typeof device === "object" &&
            device !== null &&
            "id" in device &&
            typeof device.id === "string" &&
            "name" in device &&
            typeof device.name === "string",
        )
      ) {
        clearTimeout(timer);
        resolve(devices);
        child.kill();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Speech device discovery exited (${code}).`));
    });
  });
}

/** Loads a model in an isolated process. "auto" retries on the CPU when GPU setup fails. */
export async function loadNativeSpeechModel(
  path: string,
  signal: AbortSignal,
  moduleUrl?: string,
  acceleration = "auto",
) {
  try {
    return await loadNativeSpeechModelOnce(path, signal, moduleUrl, acceleration);
  } catch (error) {
    if (acceleration !== "auto" || signal.aborted) throw error;
    return await loadNativeSpeechModelOnce(path, signal, moduleUrl, "cpu");
  }
}

async function loadNativeSpeechModelOnce(
  path: string,
  signal: AbortSignal,
  moduleUrl?: string,
  acceleration = "auto",
) {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, speechWorkerArgs("model"), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // Backend registration can initialize drivers even when model placement is CPU.
      ...(acceleration === "cpu" ? { TRANSCRIBE_BACKENDS: "cpu" } : {}),
    },
  });
  let stopped = false;
  let pending: ReturnType<typeof Promise.withResolvers<Reply>> | undefined;
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    stopped = true;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Speech process exited (${exitSignal ?? code}).`));
    signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "t3-speech-reply"
    )
      return;
    const reply = message as Reply;
    const request = pending;
    pending = undefined;
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "Native speech failed."));
  });
  function stop() {
    fail(new Error("Speech process stopped."));
    // Never call native dispose while inference is active. The OS owns cleanup of the isolated process.
    child.kill("SIGKILL");
  }
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const send = (message: object) => {
    if (stopped) return Promise.reject(new Error("Speech process stopped."));
    if (pending) return Promise.reject(new Error("Speech process is busy."));
    const request = Promise.withResolvers<Reply>();
    pending = request;
    child.send(message, (error) => {
      if (error) {
        request.reject(error);
        if (pending === request) pending = undefined;
      }
    });
    return request.promise;
  };
  const dispose = async () => {
    stop();
    await exited.promise;
  };
  let loaded: Reply;
  try {
    loaded = await send({ kind: "load", path, moduleUrl, acceleration });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend: loaded.backend ?? "unknown",
    languages: Array.isArray(loaded.languages)
      ? loaded.languages.filter((entry): entry is string => typeof entry === "string")
      : [],
    supportsStreaming: loaded.supportsStreaming === true,
    supportsLongForm: loaded.supportsLongForm === true,
    supportsTranslation: loaded.supportsTranslation === true,
    supportsVocabulary: loaded.supportsVocabulary === true,
    begin: async (options: NativeSpeechOptions, filterSilence: boolean, vadPath?: string) => {
      await send({ kind: "begin", options, filterSilence, vadPath });
    },
    feed: async (pcm: Float32Array) => {
      const reply = await send({ kind: "feed", pcm });
      if (typeof reply.revision !== "number" || reply.preview === undefined)
        throw new Error("Invalid speech stream response.");
      return { revision: reply.revision, text: reply.preview };
    },
    finish: async () => {
      const reply = await send({ kind: "finish" });
      if (typeof reply.text !== "string") throw new Error("Invalid speech stream response.");
      return reply.text;
    },
    reset: async () => {
      const inFlight = pending?.promise;
      if (inFlight) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            inFlight.catch(() => undefined),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Speech stream reset timed out.")),
                1_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      await send({ kind: "reset" });
    },
    transcribe: async (
      pcm: Float32Array,
      options: NativeSpeechOptions,
      filterSilence: boolean,
      vadPath?: string,
    ) => {
      const result = await send({ kind: "transcribe", pcm, options, filterSilence, vadPath });
      if (typeof result.text !== "string") throw new Error("Invalid speech process response.");
      return { text: result.text };
    },
    dispose,
  };
}

type NativeSpeechOptions = {
  readonly timestamps: "none";
  readonly task?: "translate";
  readonly targetLanguage?: "en";
  readonly language?: string;
  readonly vocabulary?: readonly string[];
};
