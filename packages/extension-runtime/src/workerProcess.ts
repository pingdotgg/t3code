import { copyEnvelope } from "./ipc.js";
import type { ApiStreamEvent, ApiStreamFrame } from "@t3tools/extension-sdk/capabilities";
import * as NodeURL from "node:url";
import {
  copyJson,
  validateContext,
  type Json,
  type ViewContext,
} from "@t3tools/extension-sdk/contracts";
import {
  validateServerExtension,
  type EnvironmentPackage,
  type ServerExtension,
} from "@t3tools/extension-sdk/environment";

export interface WorkerProcessOptions {
  /**
   * Loads the extension's server entry by absolute path. Defaults to
   * `import()`, which a Node single-executable can only use for built-ins.
   */
  readonly loadEntry?: (entryPath: string) => Promise<{ readonly default?: unknown }>;
}

let loadEntry: NonNullable<WorkerProcessOptions["loadEntry"]> = (entryPath) =>
  import(NodeURL.pathToFileURL(entryPath).href);
let definition: ServerExtension | undefined;
const controllers = new Map<string, AbortController>();
const streams = new Map<
  string,
  { iterator: AsyncIterator<ApiStreamEvent>; controller: AbortController; pulling: boolean }
>();
const closingStreams = new Set<string>();
type ConsumerStream = {
  opened: boolean;
  pending: boolean;
  ended: boolean;
  resolveReady(): void;
  rejectReady(error: Error): void;
  ready: Promise<void>;
  finish(error?: Error): void;
  waiting:
    | { resolve(value: IteratorResult<ApiStreamFrame>): void; reject(error: Error): void }
    | undefined;
};
const consumerStreams = new Map<string, ConsumerStream>();
const consumerClosures = new Map<string, (error?: Error) => void>();
const services = new Map<
  string,
  { callId: string; resolve(value: Json): void; reject(error: Error): void }
>();
let nextService = 0;
function send(value: unknown) {
  if (process.connected) process.send?.(copyEnvelope(value));
}
function fail(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : "Extension failed";
}
function apiSession(
  callId: string,
  controller: AbortController,
  extra: { context: ViewContext; resumeCursor?: string },
) {
  const invokeApi = (request: unknown): Promise<Json> => {
    if (controller.signal.aborted || services.size >= 8)
      return Promise.reject(new Error("API call unavailable"));
    const requestId = String(++nextService);
    return new Promise((resolve, reject) => {
      services.set(requestId, { callId, resolve, reject });
      try {
        send({ type: "api-service", callId, requestId, request: copyJson(request) });
      } catch (error) {
        services.delete(requestId);
        reject(error);
      }
    });
  };
  const subscribeApi = (request: unknown): AsyncIterable<ApiStreamFrame> => ({
    [Symbol.asyncIterator]() {
      const streamId = callId + ":" + ++nextService;
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      void ready.catch(() => {});
      let cleanup: Promise<void> | undefined;
      const finish = (error?: Error) => {
        if (state.ended) return;
        state.ended = true;
        controller.signal.removeEventListener("abort", abort);
        consumerStreams.delete(streamId);
        if (error) {
          state.rejectReady(error);
          state.waiting?.reject(error);
        } else {
          state.resolveReady();
          state.waiting?.resolve({ done: true, value: undefined });
        }
        state.waiting = undefined;
      };
      const abort = () => {
        if (state.ended) return;
        if (state.opened) {
          cleanup = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              consumerClosures.delete(streamId);
              reject(new Error("Stream cleanup acknowledgement deadline exceeded"));
            }, 1000);
            const settle = (error?: Error) => {
              clearTimeout(timer);
              consumerClosures.delete(streamId);
              if (error) reject(error);
              else resolve();
            };
            consumerClosures.set(streamId, settle);
            try {
              send({ type: "api-stream-cancel", callId, streamId });
            } catch (error) {
              settle(error instanceof Error ? error : new Error("Stream disconnected"));
            }
          });
          void cleanup.catch(() => {});
        }
        finish(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("Stream cancelled"),
        );
      };
      const state: ConsumerStream = {
        opened: false,
        pending: false,
        ended: false,
        ready,
        resolveReady: readyResolve,
        rejectReady: readyReject,
        waiting: undefined,
        finish,
      };
      return {
        async next(): Promise<IteratorResult<ApiStreamFrame>> {
          if (state.ended) return { done: true, value: undefined };
          if (state.pending) throw new Error("Concurrent stream pull");
          state.pending = true;
          try {
            if (!state.opened) {
              if (controller.signal.aborted) throw new Error("Stream parent expired");
              if (consumerStreams.size + consumerClosures.size >= 8)
                throw new Error("Worker stream limit reached");
              consumerStreams.set(streamId, state);
              controller.signal.addEventListener("abort", abort, { once: true });
              state.opened = true;
              send({ type: "api-stream-open", callId, streamId, request: copyJson(request) });
            }
            await state.ready;
            if (state.ended) return { done: true, value: undefined };
            return await new Promise<IteratorResult<ApiStreamFrame>>((resolve, reject) => {
              state.waiting = { resolve, reject };
              try {
                send({ type: "api-stream-pull", callId, streamId });
              } catch (error) {
                reject(error);
              }
            });
          } catch (error) {
            abort();
            throw error;
          } finally {
            state.pending = false;
            state.waiting = undefined;
          }
        },
        async return() {
          abort();
          await cleanup;
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<ApiStreamFrame>> {
          abort();
          await cleanup;
          throw error;
        },
      };
    },
  });
  return {
    context: extra.context,
    signal: controller.signal,
    ...(extra.resumeCursor === undefined ? {} : { resumeCursor: extra.resumeCursor }),
    invokeApi,
    subscribeApi,
  };
}
async function handle(raw: unknown) {
  const message = copyEnvelope(raw);
  if (message.type === "initialize") {
    if (definition) throw new Error("Already initialized");
    const loaded = await loadEntry(String(message.entry));
    definition = validateServerExtension(
      message.package as unknown as EnvironmentPackage,
      loaded.default,
    );
    send({ type: "ready" });
    return;
  }
  if (message.type === "cancel") {
    const callId = String(message.callId);
    const controller = controllers.get(callId);
    controller?.abort();
    for (const [id, service] of services)
      if (service.callId === callId) {
        services.delete(id);
        service.reject(new Error("Invocation cancelled"));
      }
    if (!controller) send({ type: "settled", callId });
    return;
  }
  if (message.type === "api-stream-settled") {
    consumerClosures.get(String(message.streamId))?.();
    return;
  }
  if (message.type === "api-stream-ready") {
    consumerStreams.get(String(message.streamId))?.resolveReady();
    return;
  }
  if (message.type === "api-stream-frame") {
    const state = consumerStreams.get(String(message.streamId));
    if (state?.waiting)
      state.waiting.resolve({
        done: false,
        value: copyJson(message.frame) as unknown as ApiStreamFrame,
      });
    return;
  }
  if (message.type === "api-stream-end") {
    const state = consumerStreams.get(String(message.streamId));
    state?.finish();
    return;
  }
  if (message.type === "api-stream-error") {
    const state = consumerStreams.get(String(message.streamId));
    state?.finish(new Error(String(message.error ?? "Stream failed")));
    return;
  }
  if (message.type === "stream-cancel") {
    const callId = String(message.callId);
    const stream = streams.get(callId);
    if (stream) {
      streams.delete(callId);
      closingStreams.add(callId);
      stream.controller.abort();
      for (const [id, service] of services)
        if (service.callId === callId) {
          services.delete(id);
          service.reject(new Error("Stream cancelled"));
        }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const returned = Promise.resolve()
        .then(() => stream.iterator.return?.())
        .then(
          () => true,
          () => true,
        );
      const finished = await Promise.race([
        returned,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 250);
        }),
      ]);
      clearTimeout(timer);
      if (!finished) {
        send({ type: "stream-error", callId, error: "Stream cleanup deadline exceeded" });
        process.exit(1);
        return;
      }
      closingStreams.delete(callId);
      send({ type: "stream-settled", callId });
    } else if (!closingStreams.has(callId)) send({ type: "stream-settled", callId });
    return;
  }
  if (message.type === "stream-pull") {
    const stream = streams.get(String(message.callId));
    if (!stream) return;
    if (closingStreams.has(String(message.callId))) return;
    if (stream.pulling) {
      send({
        type: "stream-error",
        callId: String(message.callId),
        error: "Concurrent stream pull",
      });
      return;
    }
    stream.pulling = true;
    try {
      const next = await stream.iterator.next();
      if (stream.controller.signal.aborted || streams.get(String(message.callId)) !== stream)
        return;
      if (next.done) {
        stream.controller.abort();
        try {
          await stream.iterator.return?.();
        } catch {}
        streams.delete(String(message.callId));
        send({ type: "stream-end", callId: String(message.callId) });
      } else
        send({ type: "stream-frame", callId: String(message.callId), event: copyJson(next.value) });
    } catch (error) {
      stream.controller.abort();
      try {
        await stream.iterator.return?.();
      } catch {}
      streams.delete(String(message.callId));
      send({ type: "stream-error", callId: String(message.callId), error: fail(error) });
    } finally {
      stream.pulling = false;
    }
    return;
  }
  if (message.type === "stream-open") {
    if (!definition) throw new Error("Worker is not ready");
    const callId = String(message.callId);
    const api = definition.apis?.find((item) => item.id === message.apiId);
    const stream = api?.streams?.find((item) => item.name === message.name);
    if (
      !stream ||
      streams.has(callId) ||
      closingStreams.has(callId) ||
      streams.size + closingStreams.size >= 8
    )
      throw new Error("Invalid API stream");
    const controller = new AbortController();
    const context = validateContext(message.context as unknown as ViewContext);
    const iteratorSource = stream.subscribe(
      copyJson(message.input ?? null),
      apiSession(callId, controller, {
        context,
        ...(message.cursor === undefined ? {} : { resumeCursor: String(message.cursor) }),
      }),
    );
    const iterator = iteratorSource[Symbol.asyncIterator]();
    streams.set(callId, { iterator, controller, pulling: false });
    send({ type: "stream-ready", callId });
    return;
  }
  if (message.type === "service-result") {
    const pending = services.get(String(message.requestId));
    if (!pending) return;
    services.delete(String(message.requestId));
    if (typeof message.error === "string") pending.reject(new Error(message.error));
    else pending.resolve(copyJson(message.value ?? null));
    return;
  }
  if (message.type !== "invoke" || !definition) throw new Error("Worker is not ready");
  const callId = String(message.callId);
  const tool = message.apiId
    ? definition.apis
        ?.find((api) => api.id === message.apiId)
        ?.methods?.find((method) => method.name === message.method)
    : definition.tools.find((item) => item.id === message.toolId);
  if (!tool || controllers.has(callId)) throw new Error("Invalid tool invocation");
  if (controllers.size >= 8) {
    send({ type: "result", callId, error: "Worker pending tool limit reached" });
    return;
  }
  const controller = new AbortController();
  controllers.set(callId, controller);
  try {
    const value = await tool.invoke(copyJson(message.input ?? null), {
      ...apiSession(callId, controller, {
        context: validateContext(message.context as unknown as ViewContext),
      }),
      invoke(capability, input) {
        if (controller.signal.aborted || services.size >= 8)
          return Promise.reject(new Error("Service call unavailable"));
        const requestId = String(++nextService);
        return new Promise((resolve, reject) => {
          services.set(requestId, { callId, resolve, reject });
          try {
            send({ type: "service", callId, requestId, capability, input: copyJson(input) });
          } catch (error) {
            services.delete(requestId);
            reject(error);
          }
        });
      },
    });
    if (!controller.signal.aborted) send({ type: "result", callId, value: copyJson(value) });
  } catch (error) {
    if (!controller.signal.aborted) send({ type: "result", callId, error: fail(error) });
  } finally {
    controller.abort();
    controllers.delete(callId);
    send({ type: "settled", callId });
    for (const [id, service] of services)
      if (service.callId === callId) {
        services.delete(id);
        service.reject(new Error("Invocation ended"));
      }
  }
}

/**
 * Serves one extension over the parent's IPC channel until it disconnects.
 * `worker.ts` calls this when forked as a script; an executable host calls it
 * from a hidden subcommand. Importing this module starts nothing.
 */
export function runWorkerProcess(options: WorkerProcessOptions = {}): void {
  if (options.loadEntry) loadEntry = options.loadEntry;
  process.on("message", (raw: unknown) => {
    void handle(raw).catch((error) => send({ type: "fatal", error: fail(error) }));
  });
  process.on("disconnect", () => {
    const reason = new Error("Worker disconnected");
    for (const controller of controllers.values()) controller.abort(reason);
    for (const stream of streams.values()) stream.controller.abort(reason);
    for (const state of consumerStreams.values()) {
      state.ended = true;
      state.rejectReady(reason);
      state.waiting?.reject(reason);
    }
    consumerStreams.clear();
    for (const settle of consumerClosures.values()) settle(reason);
    consumerClosures.clear();
    process.exit(0);
  });
}
