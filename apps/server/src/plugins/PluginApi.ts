import { PluginRpcName, type PluginId } from "@t3tools/contracts";
import type { PluginApi, PluginRpcAccess, PluginRpcHandler } from "@t3tools/plugin-sdk/server";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { makeFacadeContext, pluginCodeScope, refused } from "./api/facade.ts";
import { makeMcpApi } from "./api/mcp.ts";
import type * as PluginMcpTools from "./PluginMcpTools.ts";
import type * as PluginSettingsStore from "./PluginSettingsStore.ts";
import type * as PluginStorage from "./PluginStorage.ts";

const isJson = Schema.is(Schema.Json);
const isPluginRpcName = Schema.is(PluginRpcName);
const isPluginRpcAccess = Schema.is(Schema.Literals(["read", "write"]));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const utf8 = new TextEncoder();

// A published value or a method's result reaches a client as one WebSocket message, and one large
// message holds up every other stream on the socket.
export const MAX_MESSAGE_KILOBYTES = 256;
export const jsonKilobytes = (value: Schema.Json) =>
  Math.ceil(utf8.encode(encodeJson(value)).byteLength / 1024);

export interface PluginActivation {
  readonly methods: Map<
    string,
    { readonly handler: PluginRpcHandler; readonly access: PluginRpcAccess }
  >;
  readonly cleanups: Array<() => void | Promise<void>>;
  /** Aborted when deactivation starts; handler signals and iterators follow it. */
  readonly controller: AbortController;
  /** Aborted once the cleanups have run; API calls are refused from then on. */
  readonly ended: AbortController;
  /**
   * Each subscriber's buffer, by channel, so a busy channel or a slow subscriber drops only its
   * own values. The host ends them when `ended` aborts.
   */
  readonly channels: Map<string, Set<Queue.Queue<Schema.Json, Cause.Done>>>;
}

export const makePluginActivation = (): PluginActivation => ({
  methods: new Map(),
  cleanups: [],
  controller: new AbortController(),
  ended: new AbortController(),
  channels: new Map(),
});

const assertActive = (activation: PluginActivation) => {
  if (activation.controller.signal.aborted) {
    throw new Error("This plugin activation has ended.");
  }
};

export interface PluginApiServices {
  readonly settings: PluginSettingsStore.PluginSettingsStore["Service"];
  readonly storage: PluginStorage.PluginStorage["Service"];
  readonly mcpTools: PluginMcpTools.PluginMcpTools["Service"];
}

/**
 * Builds the object a plugin's `activate` receives. Effect stays on this side: every call runs
 * with the host's services and settles as a plain Promise that rejects with an `Error`.
 */
export const makePluginApi = (input: {
  readonly id: PluginId;
  readonly rootDir: string;
  readonly settingsSchema: Schema.JsonObject | undefined;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  readonly services: PluginApiServices;
}): PluginApi => {
  const { id, activation, context, services } = input;
  const facade = makeFacadeContext({ pluginId: id, activation, context });
  const { call } = facade;
  const log =
    (level: "Debug" | "Info" | "Warn" | "Error") => (message: string, fields?: Schema.JsonObject) =>
      facade.fork(
        Effect.logWithLevel(level)(message, fields ?? {}).pipe(
          Effect.annotateLogs({ pluginId: id }),
        ),
      );

  const storage: PluginApi["storage"] = {
    get: (key) => call(services.storage.get(id, key).pipe(Effect.map(Option.getOrUndefined))),
    set: (key, value) => {
      if (!isJson(value)) return refused(new TypeError("Storage values must be JSON."));
      return call(services.storage.set(id, key, value));
    },
    delete: (key) => call(services.storage.remove(id, key)),
    list: (prefix) => call(services.storage.list(id, prefix)),
  };

  return {
    version: 1,
    id,
    rootDir: input.rootDir,
    log: { debug: log("Debug"), info: log("Info"), warn: log("Warn"), error: log("Error") },
    settings: {
      get: () => call(services.settings.get(id, input.settingsSchema)),
      changes: () => facade.iterate(services.settings.changes(id)),
    },
    storage,
    rpc: {
      register: (method, handler, options) => {
        assertActive(activation);
        if (!isPluginRpcName(method))
          throw new TypeError(`"${method}" is not a valid method name.`);
        // Plugins are untyped JavaScript, and a misspelled access level must not open a write.
        if (!isPluginRpcAccess(options.access)) {
          throw new TypeError(`Method "${method}" needs access "read" or "write".`);
        }
        if (activation.methods.has(method)) {
          throw new Error(`Method "${method}" is already registered.`);
        }
        activation.methods.set(method, { handler, access: options.access });
      },
      publish: (channel, value) => {
        assertActive(activation);
        if (!isPluginRpcName(channel)) {
          throw new TypeError(`"${channel}" is not a valid channel name.`);
        }
        if (!isJson(value)) throw new TypeError("Published values must be JSON.");
        const size = jsonKilobytes(value);
        if (size > MAX_MESSAGE_KILOBYTES) {
          throw new RangeError(
            `The value published on "${channel}" is ${size} KB as JSON, and a value can be at most ${MAX_MESSAGE_KILOBYTES} KB.`,
          );
        }
        // Waking a subscriber schedules T3's work, which must not run in the plugin's scope.
        pluginCodeScope.exit(() => {
          for (const queue of activation.channels.get(channel) ?? []) {
            Queue.offerUnsafe(queue, value);
          }
        });
      },
    },
    // Something created after deactivation has nothing left to wait for, so it cleans up now.
    onDeactivate: (cleanup) => {
      if (activation.controller.signal.aborted) {
        void Promise.resolve()
          .then(cleanup)
          .catch(() => undefined);
        return;
      }
      activation.cleanups.push(cleanup);
    },
    mcp: makeMcpApi(facade, services),
  };
};
