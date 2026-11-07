// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";

import { FRONT_DECISION_JSON_SCHEMA } from "./decision.ts";
import type { FrontMessage } from "./FrontModel.ts";

// node-llama-cpp is ESM with top-level await, so it loads with import() from its disk entry.
// The engine is the seam tests replace through moduleUrl.
const loaderEntry = `
  const loadEngine = async (moduleUrl) => {
    if (moduleUrl) return await import(moduleUrl);
    const { findPackageJSON } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const packagePath = findPackageJSON("node-llama-cpp", baseUrl);
    if (!packagePath) throw new Error("The front model package is unavailable.");
    const fromPackage = (file) => import(pathToFileURL(join(dirname(packagePath), file)).href);
    const llamaCpp = await fromPackage("dist/index.js");
    const { getGbnfGrammarForGbnfJsonSchema } =
      await fromPackage("dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js");
    return { load: async ({ path, gpu, schema }) => {
      const llama = await llamaCpp.getLlama({ gpu, build: "never", skipDownload: true,
        progressLogs: false, logLevel: "error" });
      const model = await llama.loadModel({ modelPath: path });
      const context = await model.createContext({ contextSize: 8192 });
      // Thinking would spend the latency budget before the first decision token.
      const chatWrapper = llamaCpp.resolveChatWrapper(model, { customWrapperSettings: {
        qwen: { thoughts: "discourage" }, gemma4: { reasoning: false } } });
      const chat = new llamaCpp.LlamaChat({ contextSequence: context.getSequence(), chatWrapper });
      // Compact JSON: indentation would cost a decode step per whitespace token.
      const grammar = new llamaCpp.LlamaGrammar(llama, {
        grammar: getGbnfGrammarForGbnfJsonSchema(schema, { allowNewLines: false }),
        stopGenerationTriggers: [llamaCpp.LlamaText(["\\n\\n\\n\\n"])], trimWhitespaceSuffix: true });
      return {
        gpu: llama.gpu || "cpu",
        // The context sequence keeps its tokens, so a history that extends the last one only
        // evaluates the new messages.
        decide: async (messages, signal) => {
          const history = messages.map((message) => message.role === "assistant"
            ? { type: "model", response: [message.content] }
            : { type: message.role, text: message.content });
          history.push({ type: "model", response: [] });
          const result = await chat.generateResponse(history,
            { grammar, signal, temperature: 0, maxTokens: 512 });
          return result.response;
        },
      };
    } };
  };
`;

const entry = `
let engine;
let running = Promise.resolve();
const controllers = new Map();
const reply = (message) => process.send({ type: "t3-front-reply", ...message });
const failure = (error) => error instanceof Error ? error.stack ?? error.message : String(error);
process.on("message", async (message) => {
  if (message.kind === "load") {
    try {
      engine = await (await loadEngine(message.moduleUrl)).load(message);
      reply({ id: message.id, ok: true, gpu: String(engine.gpu) });
    } catch (error) {
      reply({ id: message.id, ok: false, error: failure(error) });
    }
  } else if (message.kind === "abort") {
    controllers.get(message.id)?.abort();
  } else if (message.kind === "decide") {
    const controller = new AbortController();
    controllers.set(message.id, controller);
    // One sequence holds the KV cache, so decisions run one at a time.
    running = running.then(async () => {
      try {
        if (controller.signal.aborted) throw new Error("Aborted.");
        reply({ id: message.id, ok: true,
          text: await engine.decide(message.messages, controller.signal) });
      } catch (error) {
        reply({ id: message.id, ok: false, error: failure(error) });
      } finally {
        controllers.delete(message.id);
      }
    });
  }
});
process.on("disconnect", () => process.exit(0));
`;

export async function runFrontModelWorker() {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function("baseUrl", `return (async () => {${loaderEntry}${entry}})();`) as (
    baseUrl: string,
  ) => Promise<void>;
  await run(import.meta.url);
}

function frontWorkerArgs() {
  if (NodeSea.isSea()) return ["__speech-worker", "front"];
  const loader = `const baseUrl = ${JSON.stringify(import.meta.url)};${loaderEntry}`;
  return ["--input-type=module", "-e", loader + entry];
}

type Reply = {
  readonly type: "t3-front-reply";
  readonly id: number;
  readonly ok: boolean;
  readonly text?: string;
  readonly gpu?: string;
  readonly error?: string;
};

export type FrontLlama = Awaited<ReturnType<typeof loadFrontLlama>>;

/**
 * Loads a GGUF in an isolated process. Aborting a decision stops its generation in the worker and
 * keeps the model loaded; aborting `signal` or disposing kills the process.
 */
export async function loadFrontLlama(
  modelPath: string,
  signal: AbortSignal,
  options: { readonly moduleUrl?: string; readonly gpu?: "auto" | false } = {},
) {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, frontWorkerArgs(), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  let stopped: Error | undefined;
  let nextId = 0;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    stopped ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Front model process exited (${exitSignal ?? code}).`));
    signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "t3-front-reply" ||
      !("id" in message) ||
      typeof message.id !== "number"
    )
      return;
    const reply = message as Reply;
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "The front model failed."));
  });
  function stop() {
    fail(new Error("Front model process stopped."));
    child.kill("SIGKILL");
  }
  signal.addEventListener("abort", stop, { once: true });
  const send = (message: object, requestSignal?: AbortSignal) => {
    if (stopped) return Promise.reject(stopped);
    const id = nextId++;
    const request = Promise.withResolvers<Reply>();
    pending.set(id, request);
    child.send({ ...message, id }, (error) => {
      if (error && pending.delete(id)) request.reject(error);
    });
    // The caller stops waiting at once; the worker drops the generation and frees the sequence.
    requestSignal?.addEventListener(
      "abort",
      () => {
        if (!pending.delete(id)) return;
        request.reject(requestSignal.reason);
        if (!stopped) child.send({ kind: "abort", id });
      },
      { once: true },
    );
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
      path: modelPath,
      moduleUrl: options.moduleUrl,
      gpu: options.gpu ?? "auto",
      schema: FRONT_DECISION_JSON_SCHEMA,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    gpu: loaded.gpu ?? "cpu",
    /** The model's raw JSON text for the conversation so far. */
    decide: async (messages: readonly FrontMessage[], requestSignal: AbortSignal) => {
      requestSignal.throwIfAborted();
      const reply = await send({ kind: "decide", messages }, requestSignal);
      if (typeof reply.text !== "string") throw new Error("Invalid front model response.");
      return reply.text;
    },
    dispose,
  };
}
