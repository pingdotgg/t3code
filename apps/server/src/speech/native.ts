// @effect-diagnostics nodeBuiltinImport:off - native inference needs a killable process, not an interruptible JS promise.
import * as NodeChildProcess from "node:child_process";

// Inline the small child entry so the packaged CLI does not need a separate worker artifact.
const entry = `
let model;
process.on("message", async (message) => {
  try {
    if (message.kind === "load") {
      const { TranscribeModel } = await import(message.moduleUrl);
      model = await TranscribeModel.load(message.path, { backend: "cpu" });
      process.send({ ok: true });
    } else {
      const result = await model.transcribe(message.pcm, message.options);
      process.send({ ok: true, text: result.text });
    }
  } catch (error) {
    process.send({ ok: false, error: String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

type Reply = { ok: boolean; text?: string; error?: string };

export async function loadNativeSpeechModel(
  path: string,
  signal: AbortSignal,
  moduleUrl = import.meta.resolve("transcribe-cpp"),
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
  child.on("message", (message: Reply) => {
    const request = pending;
    pending = undefined;
    if (message.ok) request?.resolve(message);
    else request?.reject(new Error(message.error ?? "Native speech failed."));
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
  try {
    await send({ kind: "load", path, moduleUrl });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    transcribe: async (
      pcm: Float32Array,
      options: { readonly timestamps: "none"; readonly language: "en" },
    ) => {
      const result = await send({ kind: "transcribe", pcm, options });
      if (typeof result.text !== "string") throw new Error("Invalid speech process response.");
      return { text: result.text };
    },
    dispose,
  };
}
