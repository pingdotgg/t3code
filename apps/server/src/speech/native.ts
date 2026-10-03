// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import type { SpeechStreamText } from "@t3tools/contracts";

// Inline the small child entry so the packaged CLI does not need a separate worker artifact.
const entry = `
let model;
let session;
let stream;
process.on("message", async (message) => {
  try {
    if (message.kind === "load") {
      const { createRequire } = await import("node:module");
      const koffi = createRequire(message.koffiModuleUrl)("koffi");
      // transcribe-cpp 0.2.3 still uses 512 KiB. Remove this after its 2 MiB release.
      if ((koffi.config().async_stack_size ?? 0) < 2 * 1024 * 1024)
        koffi.config({ async_stack_size: 2 * 1024 * 1024 });
      const { TranscribeModel, getAvailableBackends } = await import(message.moduleUrl);
      const device = message.acceleration.startsWith("gpu:")
        ? getAvailableBackends().find((item) =>
            (item.deviceType === "gpu" || item.deviceType === "igpu") &&
            JSON.stringify([item.kind, item.deviceId ?? item.name]) === message.acceleration.slice(4))
        : undefined;
      if (message.acceleration.startsWith("gpu:") && !device)
        throw new Error("The selected speech GPU is unavailable.");
      model = await TranscribeModel.load(message.path, device
        ? { device }
        : { backend: message.acceleration });
      process.send({ type: "t3-speech-reply", ok: true, backend: model.backend,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsTranslation: model.capabilities.supportsTranslate,
        supportsInitialPrompt: model.supports("initial_prompt") });
    } else if (message.kind === "begin") {
      session = model.createSession();
      stream = await session.stream({ timestamps: "none", language: message.language });
      process.send({ type: "t3-speech-reply", ok: true });
    } else if (message.kind === "feed") {
      const update = await stream.feed(message.pcm);
      const text = update.committedChanged || update.tentativeChanged ? stream.text : null;
      process.send({ type: "t3-speech-reply", ok: true, revision: update.revision,
        preview: text ? { committed: text.committed, tentative: text.tentative } : null });
    } else if (message.kind === "finish") {
      await stream.finalize();
      const text = stream.text.full;
      stream.reset();
      session.dispose();
      stream = session = undefined;
      process.send({ type: "t3-speech-reply", ok: true, text });
    } else if (message.kind === "reset") {
      stream.reset();
      session.dispose();
      stream = session = undefined;
      process.send({ type: "t3-speech-reply", ok: true });
    } else if (message.kind === "transcribe") {
      // Leave unbounded models alone. Use headroom for output-bound models:
      // maxAudioMs is an estimate, so dense speech may still need smaller pieces.
      const limit = model.capabilities.maxAudioMs;
      const chunkSamples = limit > 0 ? Math.max(4000, Math.floor(limit * 16 / 2)) : message.pcm.length;
      const texts = [];
      const transcribe = async (pcm) => {
        try {
          const result = await model.transcribe(pcm, message.options);
          texts.push(result.text);
        } catch (error) {
          if ((error?.constructor?.name !== "OutputTruncated" &&
               error?.constructor?.name !== "InputTooLong") || pcm.length <= 4000) throw error;
          const middle = Math.floor(pcm.length / 2);
          await transcribe(pcm.subarray(0, middle));
          await transcribe(pcm.subarray(middle));
        }
      };
      let offset = 0;
      while (offset < message.pcm.length) {
        let end = Math.min(offset + chunkSamples, message.pcm.length);
        if (end < message.pcm.length) {
          // Prefer the quietest 20 ms frame in the final quarter of the window.
          let quietest = Infinity;
          const windowEnd = end;
          for (let start = offset + Math.floor(chunkSamples * 0.75); start + 320 <= windowEnd; start += 320) {
            let energy = 0;
            for (let i = start; i < start + 320; i++) energy += message.pcm[i] ** 2;
            if (energy < quietest) {
              quietest = energy;
              end = start + 160;
            }
          }
        }
        await transcribe(message.pcm.subarray(offset, end));
        offset = end;
      }
      process.send({ type: "t3-speech-reply", ok: true, text: texts.join(" ").trim() });
    }
  } catch (error) {
    process.send({
      type: "t3-speech-reply",
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
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
  readonly supportsTranslation?: boolean;
  readonly supportsInitialPrompt?: boolean;
  readonly backend?: string;
  readonly revision?: number;
  readonly preview?: SpeechStreamText | null;
};

export async function listNativeSpeechGpuDevices(
  moduleUrl = import.meta.resolve("transcribe-cpp"),
) {
  const script = `const { getAvailableBackends } = await import(process.argv[1]);
    process.send(getAvailableBackends().filter((device) =>
      device.deviceType === "gpu" || device.deviceType === "igpu").map((device) => ({
        id: JSON.stringify([device.kind, device.deviceId ?? device.name]),
        name: device.description || device.name,
      })));`;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", script, moduleUrl],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
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

export async function loadNativeSpeechModel(
  path: string,
  signal: AbortSignal,
  moduleUrl = import.meta.resolve("transcribe-cpp"),
  acceleration = "auto",
) {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", entry], {
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
  let supportsStreaming: boolean;
  let supportsTranslation: boolean;
  let supportsInitialPrompt: boolean;
  let backend: string;
  try {
    const loaded = await send({
      kind: "load",
      path,
      moduleUrl,
      koffiModuleUrl: import.meta.resolve("transcribe-cpp"),
      acceleration,
    });
    supportsStreaming = loaded.supportsStreaming === true;
    supportsTranslation = loaded.supportsTranslation === true;
    supportsInitialPrompt = loaded.supportsInitialPrompt === true;
    backend = loaded.backend ?? "unknown";
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend,
    supportsStreaming,
    supportsTranslation,
    supportsInitialPrompt,
    begin: async (language?: string) => {
      await send({ kind: "begin", language });
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
      options: {
        readonly timestamps: "none";
        readonly task?: "translate";
        readonly targetLanguage?: "en";
        readonly language?: string;
        readonly family?: { readonly kind: "whisper"; readonly initialPrompt: string };
      },
    ) => {
      const result = await send({ kind: "transcribe", pcm, options });
      if (typeof result.text !== "string") throw new Error("Invalid speech process response.");
      return { text: result.text };
    },
    dispose,
  };
}
