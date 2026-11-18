// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import { bindAudioCpp, type AudioCppSynthesisRequest } from "@t3tools/audio-cpp";
import { ENCODE_SLICE_SAMPLES, leadingSentence, mp3Kbps, pcm16Mono } from "./synthesisAudio.ts";

// Inlined like the dictation worker, so packaged builds need no separate worker artifact.
const entry = `
  const { createRequire, findPackageJSON } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const bindAudioCpp = ${bindAudioCpp.toString()};
  const pcm16Mono = ${pcm16Mono.toString()};
  const mp3Kbps = ${mp3Kbps.toString()};
  const leadingSentence = ${leadingSentence.toString()};
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
          backend: message.backend, threads: message.threads,
        });
        reply({ ok: true, backend: model.backend, languages: model.languages });
      } else if (message.kind === "synthesize") {
        cancelled = false;
        // One encoder across both parts keeps the MP3 a single seamless stream.
        let encoder;
        for (const text of leadingSentence(message.request.text)) {
          if (cancelled) break;
          const stream = model.stream({ ...message.request, text });
          try {
            while (!cancelled) {
              const audio = stream.next();
              if (!audio) break;
              encoder ??= new lame.Mp3Encoder(1, audio.sampleRate, mp3Kbps(audio.sampleRate));
              const pcm = pcm16Mono(audio.samples, audio.channels);
              // Encoding a text chunk takes longer than synthesizing it, so send it slice by slice.
              for (let start = 0; start < pcm.length && !cancelled; start += ${ENCODE_SLICE_SAMPLES}) {
                chunk(encoder.encodeBuffer(pcm.subarray(start, start + ${ENCODE_SLICE_SAMPLES})));
                // Lets IPC deliver the slice, and a cancel arrive, before the next one.
                await new Promise((resolve) => setImmediate(resolve));
              }
            }
          } finally {
            stream.close();
          }
        }
        if (encoder && !cancelled) chunk(encoder.flush());
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
    /** Delivers MP3 as each text chunk is synthesized; resolves once the stream ends or is cancelled. */
    stream: async (request: AudioCppSynthesisRequest, onAudio: (bytes: Uint8Array) => void) => {
      receive = onAudio;
      try {
        await send({ kind: "synthesize", request });
      } finally {
        receive = undefined;
      }
    },
    /** Stops after the text chunk in progress; the pending `stream` call then resolves. */
    cancel: () => {
      if (alive) child.send({ kind: "cancel" });
    },
    dispose,
  };
}
