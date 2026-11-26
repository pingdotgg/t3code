// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import { bindAudioCpp, type AudioCppSynthesisRequest } from "@t3tools/audio-cpp";
import {
  ENCODE_SLICE_SAMPLES,
  mp3Kbps,
  pcm16Mono,
  peakLimiter,
  speechLines,
  splitAtPunctuation,
  wavAudio,
} from "./synthesisAudio.ts";

// Inlined like the dictation worker, so packaged builds need no separate worker artifact.
const entry = `
  const { createRequire, findPackageJSON } = await import("node:module");
  const { existsSync, readFileSync, readdirSync, statSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const bindAudioCpp = ${bindAudioCpp.toString()};
  const pcm16Mono = ${pcm16Mono.toString()};
  const peakLimiter = ${peakLimiter.toString()};
  const mp3Kbps = ${mp3Kbps.toString()};
  const speechLines = ${speechLines.toString()};
  const splitAtPunctuation = ${splitAtPunctuation.toString()};
  const wavAudio = ${wavAudio.toString()};
  // Where the runtime unpacked the eSpeak data package, newest first.
  const espeakDirectory = () => {
    const root = process.env.AUDIOCPP_ESPEAK_CACHE && join(process.env.AUDIOCPP_ESPEAK_CACHE, "audio.cpp", "espeak-data");
    if (!root || !existsSync(root)) return undefined;
    return readdirSync(root)
      .map((name) => join(root, name, "espeak-ng-data"))
      .filter((path) => existsSync(join(path, "phontab")))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  };
  const clips = new Map();
  const packageJson = (name) => {
    const path = findPackageJSON(name, baseUrl);
    if (!path) throw new Error("The " + name + " package is unavailable.");
    return path;
  };
  let model;
  let lame;
  let cancelled = false;
  const reply = (message) => process.send({ type: "t3-synthesis-reply", ...message });
  // lamejs returns Int8Array, which the parent would not recognize as audio bytes.
  const chunk = (bytes) => {
    if (bytes.length)
      process.send({
        type: "t3-synthesis-chunk",
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
      });
  };
  process.on("message", async (message) => {
    if (message.kind === "cancel") {
      cancelled = true;
      return;
    }
    try {
      if (message.kind === "load") {
        const koffiPath = packageJson("koffi");
        const koffi = createRequire(koffiPath)(dirname(koffiPath));
        const lamePath = packageJson("@breezystack/lamejs");
        const lameEntry = join(dirname(lamePath), JSON.parse(readFileSync(lamePath, "utf8")).module);
        lame = await import(pathToFileURL(lameEntry).href);
        model = bindAudioCpp(koffi, message.libraryPath).loadSpeechModel(message.modelPath, {
          backend: message.backend, threads: message.threads, espeakDirectory,
        });
        reply({ ok: true, backend: model.backend, languages: model.languages });
      } else if (message.kind === "synthesize") {
        cancelled = false;
        // One encoder across every part keeps the MP3 a single seamless stream.
        let encoder;
        let limiter;
        let format;
        const emit = async (samples) => {
          const pcm = pcm16Mono(samples, format.channels);
          if (pcm.length) process.send({ type: "t3-synthesis-pcm", pcm, rate: format.sampleRate });
          // Encoding a text chunk takes longer than synthesizing it, so send it slice by slice.
          for (let start = 0; start < pcm.length && !cancelled; start += ${ENCODE_SLICE_SAMPLES}) {
            chunk(encoder.encodeBuffer(pcm.subarray(start, start + ${ENCODE_SLICE_SAMPLES})));
            // Lets IPC deliver the slice, and a cancel arrive, before the next one.
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        const { voiceClip, ...request } = message.request;
        if (voiceClip && !clips.has(voiceClip)) clips.set(voiceClip, wavAudio(readFileSync(voiceClip)));
        const voiceAudio = voiceClip && clips.get(voiceClip);
        const pending = speechLines(request.text);
        while (pending.length && !cancelled) {
          const text = pending.shift();
          let spoke = false;
          let stream;
          try {
            stream = model.stream({ ...request, text, ...(voiceAudio && { voiceAudio }) });
            while (!cancelled) {
              const audio = stream.next();
              if (!audio) break;
              spoke = true;
              encoder ??= new lame.Mp3Encoder(1, audio.sampleRate, mp3Kbps(audio.sampleRate));
              format ??= { sampleRate: audio.sampleRate, channels: audio.channels };
              limiter ??= peakLimiter(audio.sampleRate, audio.channels);
              await emit(limiter.limit(audio.samples));
            }
          } catch (error) {
            // A line already partly heard cannot be said again without repeating it.
            if (spoke) throw error;
            // Supertonic refuses a character outside its vocabulary, naming it; drop and retry.
            const unknown = /no entry for codepoint (\\d+)/.exec(String(error));
            const skipped = unknown && text.replaceAll(String.fromCodePoint(Number(unknown[1])), " ");
            // Kokoro refuses a stretch over its phoneme limit without splitting it itself.
            const halves = /exceeds \\d+ symbols/.test(String(error)) && splitAtPunctuation(text);
            if (skipped && skipped !== text) {
              if (skipped.trim()) pending.unshift(skipped);
            } else if (halves) pending.unshift(...halves);
            else throw error;
          } finally {
            stream?.close();
          }
        }
        if (encoder && !cancelled) {
          await emit(limiter.flush());
          chunk(encoder.flush());
        }
        reply({ ok: true });
      }
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });
  // Exit teardown under in-flight native inference can crash, so terminate without it.
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
`;

export async function runLocalSynthesisWorker() {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function("baseUrl", `return (async () => {${entry}})();`) as (
    baseUrl: string,
  ) => Promise<void>;
  await run(import.meta.url);
}

const workerArgs = () =>
  NodeSea.isSea()
    ? ["__speech-worker", "synthesis"]
    : ["--input-type=module", "-e", `const baseUrl = ${JSON.stringify(import.meta.url)};${entry}`];

type Reply = {
  readonly type: "t3-synthesis-reply";
  readonly ok: boolean;
  readonly error?: string;
  readonly backend?: string;
  readonly languages?: unknown;
};

export type LocalSynthesisModel = Awaited<ReturnType<typeof loadLocalSynthesisModel>>;

export type LocalSynthesisRequest = Omit<AudioCppSynthesisRequest, "voiceAudio"> & {
  /** A 16-bit PCM WAV of the speaker a voice-cloning model imitates. */
  readonly voiceClip?: string;
};

/** Loads a model in an isolated process; aborting `signal` kills it, even mid-synthesis. */
export async function loadLocalSynthesisModel(options: {
  readonly libraryPath: string;
  /** Falls back to the CPU when the backend has no device here. */
  readonly backend: string;
  readonly modelPath: string;
  /** Extra environment for the worker, such as where a model's eSpeak data lives. */
  readonly env?: Readonly<Record<string, string>>;
  readonly threads: number;
  readonly signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, workerArgs(), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  let alive = true;
  let pending: ReturnType<typeof Promise.withResolvers<Reply>> | undefined;
  let receive: ((bytes: Uint8Array) => void) | undefined;
  let receivePcm: ((pcm: Int16Array, rate: number) => void) | undefined;
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    alive = false;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Speech synthesis process exited (${exitSignal ?? code}).`));
    options.signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "t3-synthesis-chunk") {
      if ("bytes" in message && message.bytes instanceof Uint8Array) receive?.(message.bytes);
      return;
    }
    if (message.type === "t3-synthesis-pcm") {
      if (
        "pcm" in message &&
        message.pcm instanceof Int16Array &&
        "rate" in message &&
        typeof message.rate === "number"
      )
        receivePcm?.(message.pcm, message.rate);
      return;
    }
    if (message.type !== "t3-synthesis-reply") return;
    const reply = message as Reply;
    const request = pending;
    pending = undefined;
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "Speech synthesis failed."));
  });
  function stop() {
    fail(new Error("Speech synthesis process stopped."));
    // Never call native dispose while inference is active. The OS owns cleanup of the isolated process.
    child.kill("SIGKILL");
  }
  options.signal.addEventListener("abort", stop, { once: true });
  const send = (message: object) => {
    if (!alive) return Promise.reject(new Error("Speech synthesis process stopped."));
    if (pending) return Promise.reject(new Error("Speech synthesis process is busy."));
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
    loaded = await send({
      kind: "load",
      libraryPath: options.libraryPath,
      backend: options.backend,
      modelPath: options.modelPath,
      threads: options.threads,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend: loaded.backend ?? "unknown",
    languages: Array.isArray(loaded.languages)
      ? loaded.languages.filter((language): language is string => typeof language === "string")
      : [],
    get alive() {
      return alive;
    },
    /**
     * Delivers MP3 as each text chunk is synthesized, and the mono PCM each part was encoded
     * from; resolves once the stream ends or is cancelled.
     */
    stream: async (
      request: LocalSynthesisRequest,
      onAudio: (bytes: Uint8Array) => void,
      onPcm?: (pcm: Int16Array, rate: number) => void,
    ) => {
      receive = onAudio;
      receivePcm = onPcm;
      try {
        await send({ kind: "synthesize", request });
      } finally {
        receive = undefined;
        receivePcm = undefined;
      }
    },
    /** Stops after the text chunk in progress; the pending `stream` call then resolves. */
    cancel: () => {
      if (alive) child.send({ kind: "cancel" });
    },
    dispose,
  };
}
