// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import type { ModelFile } from "./SpeechModelStore.ts";

export const KOKORO_SAMPLE_RATE = 24_000;
export const KOKORO_DEFAULT_VOICE = "af_heart";

const KOKORO_REPOSITORY = {
  id: "onnx-community/Kokoro-82M-v1.0-ONNX",
  revision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
  directory: "kokoro-82m-v1.0-onnx",
} as const;

// fp32: on x64 CPUs the q8 graph renders about 4.7x slower, and fp16 drops whole sentences on the CPU.
export const KOKORO_MODEL_FILES: readonly ModelFile[] = [
  ["config.json", 44, "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f"],
  ["tokenizer.json", 3497, "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34"],
  [
    "tokenizer_config.json",
    113,
    "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  ],
  [
    "onnx/model.onnx",
    325_532_232,
    "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
  ],
].map(([filename, size, sha256]) => ({
  ...KOKORO_REPOSITORY,
  filename: filename as string,
  size: size as number,
  sha256: sha256 as string,
}));

// transformers.js loads sharp for image models only; the workspace drops it, so stub the import.
const loaderEntry = `
  const { createRequire, findPackageJSON, registerHooks } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const loadKokoro = async (moduleUrl) => {
    if (moduleUrl) return await import(moduleUrl);
    const packagePath = findPackageJSON("kokoro-js", baseUrl);
    if (!packagePath) throw new Error("The speech synthesis package is unavailable.");
    const sharpStub = "file:///t3-speech-worker/sharp-stub.cjs";
    registerHooks({
      resolve: (specifier, context, next) => specifier === "sharp"
        ? { url: sharpStub, format: "commonjs", shortCircuit: true } : next(specifier, context),
      load: (url, context, next) => url === sharpStub
        ? { format: "commonjs", shortCircuit: true,
            source: "module.exports = () => { throw new Error('Images are unavailable.'); };" }
        : next(url, context),
    });
    // The require entry keeps the package on disk reachable from Node SEA, like transcribe-cpp.
    const entry = createRequire(packagePath).resolve(join(dirname(packagePath), "dist/kokoro.cjs"));
    const { env } = createRequire(entry)("@huggingface/transformers");
    // Model files come only from the verified store; never reach the Hugging Face hub.
    Object.assign(env, { allowRemoteModels: false, allowLocalModels: true,
      useFSCache: false, useBrowserCache: false });
    return createRequire(entry)(entry);
  };
`;

const entry = `
let tts;
process.on("message", async (message) => {
  try {
    if (message.kind === "load") {
      const { KokoroTTS } = await loadKokoro(message.moduleUrl);
      tts = await KokoroTTS.from_pretrained(message.path, { dtype: "fp32", device: message.device });
      // The first inference allocates the graph and takes about twice as long; pay it here.
      await tts.generate("Ready.", { voice: "af_heart" });
      process.send({ type: "t3-tts-reply", ok: true });
    } else if (message.kind === "speak") {
      const audio = await tts.generate(message.text, { voice: message.voice });
      process.send({ type: "t3-tts-reply", ok: true, pcm: audio.audio,
        sampleRate: audio.sampling_rate });
    }
  } catch (error) {
    process.send({ type: "t3-tts-reply", ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

export async function runKokoroWorker() {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function("baseUrl", `return (async () => {${loaderEntry}${entry}})();`) as (
    baseUrl: string,
  ) => Promise<void>;
  await run(import.meta.url);
}

function kokoroWorkerArgs() {
  if (NodeSea.isSea()) return ["__speech-worker", "tts"];
  const loader = `const baseUrl = ${JSON.stringify(import.meta.url)};${loaderEntry}`;
  return ["--input-type=module", "-e", loader + entry];
}

type Reply = {
  readonly type: "t3-tts-reply";
  readonly ok: boolean;
  readonly error?: string;
  readonly pcm?: unknown;
  readonly sampleRate?: number;
};

export type KokoroSpeaker = Awaited<ReturnType<typeof loadKokoroSpeaker>>;

/** Loads Kokoro in an isolated process. Requests queue; abort kills the process. */
export async function loadKokoroSpeaker(
  modelDirectory: string,
  signal: AbortSignal,
  options: { readonly moduleUrl?: string; readonly device?: "cpu" | "cuda" } = {},
) {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, kokoroWorkerArgs(), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
    fail(new Error(`Speech synthesis process exited (${exitSignal ?? code}).`));
    signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "t3-tts-reply"
    )
      return;
    const reply = message as Reply;
    const request = pending;
    pending = undefined;
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "Speech synthesis failed."));
  });
  function stop() {
    fail(new Error("Speech synthesis process stopped."));
    child.kill("SIGKILL");
  }
  signal.addEventListener("abort", stop, { once: true });
  const sendNow = (message: object) => {
    if (stopped) return Promise.reject(new Error("Speech synthesis process stopped."));
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
  // A caller that stops waiting leaves its sentence rendering; later requests queue behind it.
  let queue: Promise<unknown> = Promise.resolve();
  const send = (message: object) => {
    const reply = queue.then(() => sendNow(message));
    queue = reply.catch(() => undefined);
    return reply;
  };
  const dispose = async () => {
    stop();
    await exited.promise;
  };
  try {
    await send({
      kind: "load",
      path: modelDirectory,
      moduleUrl: options.moduleUrl,
      device: options.device ?? "cpu",
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    /** Renders one sentence as 24 kHz mono PCM. */
    speak: async (text: string, voice: string) => {
      const reply = await send({ kind: "speak", text, voice });
      if (!(reply.pcm instanceof Float32Array) || reply.sampleRate !== KOKORO_SAMPLE_RATE)
        throw new Error("Invalid speech synthesis response.");
      return reply.pcm;
    },
    dispose,
  };
}
