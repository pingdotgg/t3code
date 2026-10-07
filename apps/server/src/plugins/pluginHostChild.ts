// @effect-diagnostics nodeBuiltinImport:off
// The child hosts one plugin and runs without the Effect runtime: bin.ts
// dispatches `__plugin-host` here before the CLI module graph loads, so each
// plugin process pays only for this file. Nothing here may run on import.
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type { PluginContext, PluginHandler, PluginJson, PluginModule } from "./pluginApi.ts";
import type { PluginChildMessage, PluginHostMessage, PluginLogLevel } from "./PluginIpc.ts";
import {
  DEFAULT_PLUGIN_IPC_MAX_BYTES,
  PLUGIN_IPC_FD,
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

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/** Serves one plugin over fd 3 until the server deactivates it or goes away. */
export const runPluginHostChild = (): void => {
  const channel = new NodeNet.Socket({ fd: PLUGIN_IPC_FD, readable: true, writable: true });
  let maxBytes = DEFAULT_PLUGIN_IPC_MAX_BYTES;
  let activated: { module: Partial<PluginModule>; controller: AbortController } | undefined;
  const handlers = new Map<string, PluginHandler>();
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
    let line: string;
    try {
      line = JSON.stringify({ _tag: "Succeeded", requestId, value: outcome ?? null });
    } catch (error) {
      send({ _tag: "Failed", requestId, message: `Result is not JSON: ${errorMessage(error)}` });
      return;
    }
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
            if (handlers.has(name)) throw new Error(`Handler "${name}" is already registered.`);
            handlers.set(name, handler);
            return {
              dispose() {
                if (handlers.get(name) === handler) handlers.delete(name);
              },
            };
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
      send({ _tag: "ActivationFailed", message: errorMessage(error) });
    }
  };

  const invoke = (message: Extract<PluginHostMessage, { _tag: "Invoke" }>) => {
    const handler = handlers.get(message.handler);
    if (!handler) {
      settle(message.requestId, new Error(`No handler named "${message.handler}".`));
      return;
    }
    const controller = new AbortController();
    requests.set(message.requestId, controller);
    Promise.resolve()
      .then(() => handler(message.input, { signal: controller.signal }))
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
    const message = JSON.parse(line) as PluginHostMessage;
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
