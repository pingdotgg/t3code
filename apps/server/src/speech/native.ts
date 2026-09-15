// @effect-diagnostics nodeBuiltinImport:off - native inference needs a killable process, not an interruptible JS promise.
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
      const { TranscribeModel } = await import(message.moduleUrl);
      model = await TranscribeModel.load(message.path, { backend: message.backend });
      process.send({ type: "t3-speech-reply", ok: true, backend: model.backend,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsInitialPrompt: model.supports("initial_prompt") });
    } else if (message.kind === "begin") {
      session = model.createSession();
      stream = await session.stream({ timestamps: "none" });
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
    } else if (message.kind === "transcribe") {
      const result = await model.transcribe(message.pcm, message.options);
      process.send({ type: "t3-speech-reply", ok: true, text: result.text });
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
  readonly supportsInitialPrompt?: boolean;
  readonly backend?: string;
  readonly revision?: number;
  readonly preview?: SpeechStreamText | null;
};

export async function loadNativeSpeechModel(
  path: string,
  signal: AbortSignal,
  moduleUrl = import.meta.resolve("transcribe-cpp"),
  requestedBackend: "auto" | "cpu" = "auto",
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
  let supportsInitialPrompt: boolean;
  let backend: string;
  try {
    const loaded = await send({ kind: "load", path, moduleUrl, backend: requestedBackend });
    supportsStreaming = loaded.supportsStreaming === true;
    supportsInitialPrompt = loaded.supportsInitialPrompt === true;
    backend = loaded.backend ?? "unknown";
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend,
    supportsStreaming,
    supportsInitialPrompt,
    begin: async () => {
      await send({ kind: "begin" });
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
    transcribe: async (
      pcm: Float32Array,
      options: {
        readonly timestamps: "none";
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
