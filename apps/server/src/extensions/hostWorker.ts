// @effect-diagnostics globalTimers:off -- IPC requests own their deadlines until response, cancellation, or disconnect.
// @effect-diagnostics nodeBuiltinImport:off -- This is the unsandboxed extension subprocess entrypoint.
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeURL from "node:url";
import type {
  Extension,
  ExtensionContext,
  ExtensionHostApi,
  ExtensionEvent,
  InvocationContext,
  Json,
} from "../../../../packages/extension-sdk/src/index.ts";

interface Request {
  readonly type: "request";
  readonly requestId: number;
  readonly operation: string;
  readonly payload: unknown;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const send = (value: unknown) => {
  if (process.connected) process.send?.(value, () => {});
};

export async function runExtensionHost() {
  const operations = new Map<number, AbortController>();
  const operation = new NodeAsyncHooks.AsyncLocalStorage<{ id: number; signal: AbortSignal }>();
  const commands = new Map<
    string,
    (input: Json, context: InvocationContext) => Json | Promise<Json>
  >();
  const tools = new Map<
    string,
    (input: Json, context: InvocationContext) => Json | Promise<Json>
  >();
  const events = new Set<(event: ExtensionEvent) => void | Promise<void>>();
  const settingsListeners = new Set<
    (settings: Readonly<Record<string, Json>>) => void | Promise<void>
  >();
  const disposers: (() => void | Promise<void>)[] = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }
  >();
  let nextId = 0;
  let context: ExtensionContext | undefined;
  let initialized = false;
  const register = (
    map: typeof commands,
    id: string,
    handler: (input: Json, context: InvocationContext) => Json | Promise<Json>,
  ) => {
    if (map.has(id)) throw new Error(`Duplicate registration: ${id}`);
    map.set(id, handler);
  };
  const handle = async (request: Request): Promise<unknown> => {
    const payload = request.payload;
    if (request.operation === "activate") {
      if (initialized || !isRecord(payload)) throw new Error("Invalid activation.");
      initialized = true;
      context = {
        extensionId: String(payload.id),
        storagePath: String(payload.storagePath),
        settings: payload.settings as Record<string, Json>,
        registerCommand: (id, handler) => register(commands, id, handler),
        registerTool: (id, handler) => register(tools, id, handler),
        onEvent: (handler) => {
          events.add(handler);
          return () => {
            events.delete(handler);
          };
        },
        onSettingsChanged: (handler) => {
          settingsListeners.add(handler);
          return () => {
            settingsListeners.delete(handler);
          };
        },
        onDispose: (handler) => {
          disposers.push(handler);
        },
        callT3: <M extends keyof ExtensionHostApi>(
          method: M,
          input: ExtensionHostApi[M]["input"],
        ) =>
          new Promise<ExtensionHostApi[M]["result"]>((resolve, reject) => {
            const requestId = ++nextId;
            const owner = operation.getStore();
            const abort = () => {
              pending.delete(requestId);
              cleanup();
              send({ type: "host-cancel", requestId });
              reject(new Error("T3 service call was cancelled or timed out."));
            };
            const timer = setTimeout(abort, 30_000);
            const cleanup = () => {
              clearTimeout(timer);
              owner?.signal.removeEventListener("abort", abort);
            };
            if (owner?.signal.aborted) {
              abort();
              return;
            }
            owner?.signal.addEventListener("abort", abort, { once: true });
            pending.set(requestId, {
              resolve: (value) => resolve(value as ExtensionHostApi[M]["result"]),
              reject,
              cleanup,
            });
            send({ type: "host-request", requestId, method, input, owner: owner?.id });
          }),
        emit: (type, data) => send({ type: "event", event: { type, data } }),
      };
      const module: { default?: Extension } = await import(
        NodeURL.pathToFileURL(String(payload.entry)).href
      );
      if (typeof module.default?.activate !== "function")
        throw new Error("Export a default extension with activate(context).");
      await module.default.activate(context);
      return { commands: [...commands.keys()], tools: [...tools.keys()] };
    }
    if (!context) throw new Error("Extension has not activated.");
    if (request.operation === "invoke" && isRecord(payload)) {
      const handler = (payload.kind === "tool" ? tools : commands).get(String(payload.name));
      if (!handler) throw new Error("Handler is not registered.");
      return await handler(payload.input as Json, (payload.context ?? {}) as InvocationContext);
    }
    if (request.operation === "settings" && isRecord(payload)) {
      Object.assign(context, { settings: payload });
      for (const listener of settingsListeners) await listener(payload as Record<string, Json>);
      return null;
    }
    if (request.operation === "event") {
      for (const listener of events) await listener(payload as ExtensionEvent);
      return null;
    }
    if (request.operation === "dispose") {
      for (const disposer of disposers.toReversed()) await disposer();
      return null;
    }
    throw new Error("Unknown extension operation.");
  };
  process.on("message", (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === "host-response" && typeof message.requestId === "number") {
      const waiter = pending.get(message.requestId);
      pending.delete(message.requestId);
      waiter?.cleanup();
      if (message.error) waiter?.reject(new Error(String(message.error)));
      else waiter?.resolve(message.result as Json);
      return;
    }
    if (message.type === "cancel-request" && typeof message.requestId === "number") {
      operations.get(message.requestId)?.abort();
      return;
    }
    if (
      message.type !== "request" ||
      typeof message.requestId !== "number" ||
      typeof message.operation !== "string"
    )
      return;
    const controller = new AbortController();
    const requestId = message.requestId;
    operations.set(requestId, controller);
    void operation
      .run({ id: requestId, signal: controller.signal }, () =>
        handle(message as unknown as Request),
      )
      .then(
        (result) =>
          send({ type: "response", requestId: message.requestId, result: result ?? null }),
        (error: unknown) =>
          send({
            type: "response",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : "Extension operation failed.",
          }),
      )
      .finally(() => {
        operations.delete(requestId);
      });
  });
  process.on("disconnect", () => {
    for (const controller of operations.values()) controller.abort();
    for (const waiter of pending.values()) {
      waiter.cleanup();
      waiter.reject(new Error("T3 host disconnected."));
    }
    pending.clear();
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This IPC worker owns its POSIX process group outside Effect.
    if (process.platform !== "win32") {
      try {
        signalProcessGroup(process.pid, "SIGKILL");
      } catch {
        /* A manually launched worker may not lead a group. */
      }
    }
    process.exit(0);
  });
  send({ type: "ready" });
}
