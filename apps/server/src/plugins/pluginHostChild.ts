// @effect-diagnostics nodeBuiltinImport:off
// The child hosts one plugin and runs without the Effect runtime: bin.ts
// dispatches `__plugin-host` here before the CLI module graph loads, so each
// plugin process pays only for this file. Nothing here may run on import.
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type {
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  PluginHandler,
  PluginJson,
  PluginModule,
} from "./pluginApi.ts";
import type { PluginChildMessage, PluginHostMessage, PluginLogLevel } from "./PluginIpc.ts";
import {
  DEFAULT_PLUGIN_IPC_MAX_BYTES,
  PLUGIN_IPC_FD,
  PLUGIN_EVENTS_HANDLER,
  PLUGIN_IPC_MAX_BYTES_LIMIT,
  makeLineDecoder,
} from "./pluginIpcFraming.ts";

// Every launcher loads the entry through require, so a plugin behaves the same
// under Node, Electron, and the single executable (which can only import()
// built-ins). require accepts CommonJS and ES modules, except an ES module
// graph that uses top-level await.
const loadEntry = (entryPath: string): Partial<PluginModule> =>
  NodeModule.createRequire(entryPath)(entryPath);

const isAsyncModuleError = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ERR_REQUIRE_ASYNC_MODULE";

// The server refuses a longer `Failed.message`, and a line it cannot decode kills the child.
const errorMessage = (error: unknown, prefix = "") =>
  `${prefix}${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);

/** Serves one plugin over fd 3 until the server deactivates it or goes away. */
export const runPluginHostChild = (): void => {
  const channel = new NodeNet.Socket({ fd: PLUGIN_IPC_FD, readable: true, writable: true });
  let maxBytes = DEFAULT_PLUGIN_IPC_MAX_BYTES;
  let activated: { module: Partial<PluginModule>; controller: AbortController } | undefined;
  const handlers = new Map<string, PluginHandler>();
  const eventHandlers = new Set<PluginEventHandler>();
  const requests = new Map<number, AbortController>();

  const write = (line: string) => {
    if (!channel.destroyed && channel.writable) channel.write(`${line}\n`);
  };
  const send = (message: PluginChildMessage) => write(JSON.stringify(message));
  // Logs are lossy: while the server is not reading, they are counted and
  // dropped instead of buffered. Results and lifecycle messages always queue.
  let droppedLogs = 0;
  const log = (level: PluginLogLevel, message: unknown) => {
    if (channel.writableNeedDrain) droppedLogs++;
    else send({ _tag: "Log", level, message: String(message).slice(0, 4000) });
  };
  channel.on("drain", () => {
    if (droppedLogs === 0) return;
    const message = `Dropped ${droppedLogs} log messages while the server was busy.`;
    droppedLogs = 0;
    send({ _tag: "Log", level: "warn", message });
  });

  const settle = (requestId: number, outcome: PluginJson | Error) => {
    requests.delete(requestId);
    if (outcome instanceof Error) {
      send({ _tag: "Failed", requestId, message: errorMessage(outcome) });
      return;
    }
    let value: string | undefined;
    try {
      value = JSON.stringify(outcome ?? null);
    } catch (error) {
      send({ _tag: "Failed", requestId, message: errorMessage(error, "Result is not JSON: ") });
      return;
    }
    // A function, symbol or `toJSON` returning undefined has no JSON form at all.
    if (value === undefined) {
      send({ _tag: "Failed", requestId, message: "Result is not JSON." });
      return;
    }
    const line = `{"_tag":"Succeeded","requestId":${requestId},"value":${value}}`;
    if (Buffer.byteLength(line) > maxBytes) {
      send({ _tag: "Failed", requestId, message: `Result exceeds ${maxBytes} bytes.` });
      return;
    }
    write(line);
  };

  const activate = async (message: Extract<PluginHostMessage, { _tag: "Activate" }>) => {
    maxBytes = message.maxMessageBytes;
    const controller = new AbortController();
    const proposed = message.proposedApi
      ? {
          handle(name: string, handler: PluginHandler) {
            if (name.startsWith("t3."))
              throw new Error(`Handler names starting with "t3." are reserved.`);
            if (handlers.has(name)) throw new Error(`Handler "${name}" is already registered.`);
            handlers.set(name, handler);
            return {
              dispose() {
                if (handlers.get(name) === handler) handlers.delete(name);
              },
            };
          },
          onEvent(handler: PluginEventHandler) {
            // A wrapper per registration, so registering one function twice runs it twice.
            const registered: PluginEventHandler = (event, context) => handler(event, context);
            eventHandlers.add(registered);
            return { dispose: () => void eventHandlers.delete(registered) };
          },
        }
      : undefined;
    const context: PluginContext = {
      apiVersion: 1,
      plugin: { id: message.pluginId, version: message.version },
      signal: controller.signal,
      log: {
        debug: (text) => log("debug", text),
        info: (text) => log("info", text),
        warn: (text) => log("warn", text),
        error: (text) => log("error", text),
      },
      proposed,
    };
    let module: Partial<PluginModule>;
    try {
      module = loadEntry(message.entryPath);
    } catch (error) {
      send(
        isAsyncModuleError(error)
          ? {
              _tag: "Incompatible",
              message:
                "The plugin's entry or a module it imports uses top-level await, which plugins cannot use. Move asynchronous setup into activate().",
            }
          : { _tag: "ActivationFailed", message: errorMessage(error) },
      );
      return;
    }
    try {
      if (typeof module.activate !== "function")
        throw new Error("The plugin entry does not export an activate function.");
      activated = { module, controller };
      await module.activate(context);
      send({ _tag: "Ready" });
    } catch (error) {
      // A plugin that failed to activate serves nothing it registered before
      // failing, and is not deactivated later as if it had started.
      activated = undefined;
      handlers.clear();
      controller.abort(new Error("Activation failed."));
      send({ _tag: "ActivationFailed", message: errorMessage(error) });
    }
  };

  // Runs every onEvent handler for each event of the page, in order. Any failure fails the
  // whole page, so the server keeps its cursor before it and delivers the page again.
  const deliverEvents: PluginHandler = async (input, context) => {
    if (eventHandlers.size === 0)
      throw new Error(
        "The plugin declares the events capability but registered no onEvent handler.",
      );
    const { events } = input as unknown as { readonly events: ReadonlyArray<PluginEvent> };
    for (const event of events) {
      for (const handler of eventHandlers) {
        context.signal.throwIfAborted();
        try {
          await handler(event, context);
        } catch (error) {
          throw new Error(`onEvent failed for ${event.deliveryId}: ${errorMessage(error)}`, {
            cause: error,
          });
        }
      }
    }
    return null;
  };

  const invoke = (message: Extract<PluginHostMessage, { _tag: "Invoke" }>) => {
    const handler =
      message.handler === PLUGIN_EVENTS_HANDLER ? deliverEvents : handlers.get(message.handler);
    if (!handler) {
      settle(message.requestId, new Error(`No handler named "${message.handler}".`));
      return;
    }
    const controller = new AbortController();
    requests.set(message.requestId, controller);
    Promise.resolve()
      .then(() => {
        // A cancel read with its invoke aborts before the handler could listen for it.
        if (controller.signal.aborted) throw controller.signal.reason;
        return handler(message.input, { signal: controller.signal });
      })
      .then(
        (value) => settle(message.requestId, value),
        (error) => settle(message.requestId, new Error(errorMessage(error))),
      );
  };

  const deactivate = async () => {
    const reason = new Error("Plugin deactivated.");
    activated?.controller.abort(reason);
    for (const controller of requests.values()) controller.abort(reason);
    try {
      await activated?.module.deactivate?.();
    } catch (error) {
      log("error", `deactivate failed: ${errorMessage(error)}`);
    }
    send({ _tag: "Deactivated" });
    channel.end(() => process.exit(0));
  };

  const receive = (line: string) => {
    let message: PluginHostMessage;
    try {
      message = JSON.parse(line) as PluginHostMessage;
    } catch {
      // A corrupt stream ends the child the same way an oversized line does.
      process.exit(1);
    }
    switch (message._tag) {
      case "Activate":
        void activate(message);
        return;
      case "Invoke":
        invoke(message);
        return;
      case "Cancel":
        requests.get(message.requestId)?.abort(new Error("Call cancelled."));
        return;
      case "Deactivate":
        void deactivate();
        return;
    }
  };

  channel.on(
    "data",
    // The server bounds what it sends by its configured limit; this only stops a
    // corrupt stream from growing without end.
    makeLineDecoder({
      maxBytes: PLUGIN_IPC_MAX_BYTES_LIMIT,
      onLine: receive,
      onOverflow: () => process.exit(1),
    }),
  );
  // The server closed the channel or died: nothing can reach this plugin again.
  channel.on("end", () => process.exit(0));
  channel.on("error", () => process.exit(1));
};
