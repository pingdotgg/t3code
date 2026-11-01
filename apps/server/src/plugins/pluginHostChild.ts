// @effect-diagnostics nodeBuiltinImport:off
// The child hosts one plugin and runs without the Effect runtime: bin.ts
// dispatches `__plugin-host` here before the CLI module graph loads, so each
// plugin process pays only for this file. Nothing here may run on import.
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type {
  PLUGIN_ENRICH_HANDLER as ContractEnrichHandler,
  PLUGIN_APPROVAL_HANDLER as ContractApprovalHandler,
  PLUGIN_TOOL_HANDLER_PREFIX as ContractToolHandlerPrefix,
} from "@t3tools/contracts";
import type {
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  PluginHandler,
  PluginJson,
  PluginModule,
  PluginProposedApi,
} from "./pluginApi.ts";
import type { PluginChildMessage, PluginHostMessage, PluginLogLevel } from "./PluginIpc.ts";
import {
  DEFAULT_PLUGIN_IPC_MAX_BYTES,
  PLUGIN_IPC_FD,
  PLUGIN_EVENTS_HANDLER,
  PLUGIN_IPC_MAX_BYTES_LIMIT,
  PLUGIN_MAX_HOST_CALLS,
  makeLineDecoder,
} from "./pluginIpcFraming.ts";

// Restates the contract's host-called names plugins may register: importing
// @t3tools/contracts at runtime would load Effect into every plugin process.
const PLUGIN_TOOL_HANDLER_PREFIX: typeof ContractToolHandlerPrefix = "t3.tool.";
const PLUGIN_ENRICH_HANDLER: typeof ContractEnrichHandler = "t3.transform.enrich";
const PLUGIN_APPROVAL_HANDLER: typeof ContractApprovalHandler = "t3.approval.decide";

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
  const hostCalls = new Map<
    number,
    { resolve: (value: PluginJson) => void; reject: (error: Error) => void }
  >();
  let nextHostCallId = 0;

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

  /** Asks the server for something a capability provides; settles with the server's answer. */
  const hostCall = (method: string, input: PluginJson) =>
    new Promise<PluginJson>((resolve, reject) => {
      const requestId = ++nextHostCallId;
      let line: string;
      try {
        line = JSON.stringify({ _tag: "HostCall", requestId, method, input });
      } catch (error) {
        reject(new Error(`The value is not JSON: ${errorMessage(error)}`));
        return;
      }
      if (Buffer.byteLength(line) > maxBytes) {
        reject(new Error(`The request exceeds ${maxBytes} bytes.`));
        return;
      }
      if (hostCalls.size >= PLUGIN_MAX_HOST_CALLS) {
        reject(new Error(`${PLUGIN_MAX_HOST_CALLS} calls to the server are already in flight.`));
        return;
      }
      hostCalls.set(requestId, { resolve, reject });
      write(line);
    });

  const settingsApi = (): Pick<PluginProposedApi, "settings" | "storage"> => ({
    settings: {
      get: async (key) => {
        const { value } = (await hostCall("settings.get", { key })) as {
          value: string | number | boolean | null;
        };
        return value ?? undefined;
      },
    },
    storage: {
      get: async (key) => {
        const result = (await hostCall("storage.get", { key })) as {
          found: boolean;
          value: PluginJson;
        };
        return result.found ? result.value : undefined;
      },
      set: async (key, value) => {
        await hostCall("storage.set", { key, value });
      },
      delete: async (key) => {
        await hostCall("storage.delete", { key });
      },
      keys: async () => ((await hostCall("storage.keys", {})) as { keys: string[] }).keys,
    },
  });

  const activate = async (message: Extract<PluginHostMessage, { _tag: "Activate" }>) => {
    maxBytes = message.maxMessageBytes;
    const controller = new AbortController();
    const proposed: PluginProposedApi | undefined = message.proposedApi
      ? {
          handle(name: string, handler: PluginHandler) {
            if (
              name.startsWith("t3.") &&
              !name.startsWith(PLUGIN_TOOL_HANDLER_PREFIX) &&
              name !== PLUGIN_ENRICH_HANDLER &&
              name !== PLUGIN_APPROVAL_HANDLER
            )
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
          ...(message.capabilities.includes("settings")
            ? settingsApi()
            : { settings: undefined, storage: undefined }),
          status: message.capabilities.includes("status")
            ? {
                set: async (status) => {
                  await hostCall("status.set", status);
                },
                clear: async (status) => {
                  await hostCall("status.clear", status);
                },
              }
            : undefined,
          notify: message.capabilities.includes("notifications")
            ? async (notification) => {
                await hostCall("notifications.show", notification);
              }
            : undefined,
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
      eventHandlers.clear();
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
      case "HostCallSucceeded":
      case "HostCallFailed": {
        const pending = hostCalls.get(message.requestId);
        if (!pending) return;
        hostCalls.delete(message.requestId);
        if (message._tag === "HostCallSucceeded") pending.resolve(message.value);
        else pending.reject(new Error(message.message));
        return;
      }
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
