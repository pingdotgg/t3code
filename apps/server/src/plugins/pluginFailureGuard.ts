// @effect-diagnostics globalConsole:off - The guard runs in Node's process callbacks, outside an Effect runtime, where printing is all it can do with its own failure.
import type { PluginId } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { PluginApiCallError, pluginCodeScope } from "./api/facade.ts";

const REJECTION = "unhandledRejection";
type Listener = (...args: ReadonlyArray<unknown>) => unknown;
const isListener = (value: unknown): value is Listener => typeof value === "function";

/**
 * Ties plugin failures outside a call to the plugin. An uncaught exception goes to `onCrash` and
 * still stops the server, since Node calls resuming unsafe. A plugin's unhandled rejection goes to
 * `onRejection` and skips the other listeners, which the guard wraps; it listens only while none do.
 */
export const makePluginFailureGuard = (handlers: {
  readonly onRejection: (pluginId: PluginId, reason: unknown) => void;
  /** Runs just before Node reports the exception, so it has to finish synchronously. */
  readonly onCrash: (pluginId: PluginId, error: unknown) => void;
}) => {
  // Node keeps loaded plugin code and its timers until exit, so a root is never dropped.
  const roots = new Map<string, PluginId>();
  // Each wrapper and what `process.rawListeners` held before it: the listener or its `once` wrapper.
  const wrapped = new WeakMap<Listener, Listener>();
  let installed = false;
  let syncing = false;

  // The plugin whose scope the failure ran in, else one whose files its stack names.
  const pluginOf = (error: unknown): PluginId | undefined => {
    const running = pluginCodeScope.getStore();
    if (running !== undefined) return running;
    if (error instanceof PluginApiCallError) return error.pluginId;
    let stack: unknown;
    try {
      stack = Predicate.isObject(error) ? error.stack : undefined;
    } catch {
      // A plugin can throw an object whose `stack` getter throws.
      return undefined;
    }
    if (typeof stack !== "string") return undefined;
    for (const [root, pluginId] of roots) if (stack.includes(root)) return pluginId;
    return undefined;
  };

  // Node calls monitors before the exception's listeners or its own exit. It adds no listener, so
  // whatever stops the server for T3's crashes stops it for a plugin's too.
  const onUncaught = (error: unknown) => {
    const pluginId = pluginOf(error);
    if (pluginId === undefined) return;
    try {
      handlers.onCrash(pluginId, error);
    } catch (recordError) {
      // Node still reports the crash itself.
      console.error(recordError);
    }
  };

  // What Node does with no listener, for rejections that aren't a plugin's.
  const alone = (reason: unknown) => {
    const pluginId = pluginOf(reason);
    if (pluginId !== undefined) return handlers.onRejection(pluginId, reason);
    throw reason;
  };

  // Node's `off` and `listeners()` read `listener`, as on its own `once` wrappers.
  const wrap = (raw: Listener) => {
    const listener: unknown = Reflect.get(raw, "listener");
    const original = isListener(listener) ? listener : raw;
    const gated = Object.assign(
      (reason: unknown, promise: unknown) => {
        const pluginId = pluginOf(reason);
        if (pluginId !== undefined) {
          // Every wrapper sees the rejection; the first records it.
          const first = process
            .rawListeners(REJECTION)
            .find((other) => isListener(other) && wrapped.has(other));
          if (first === gated) handlers.onRejection(pluginId, reason);
          return;
        }
        if (original !== raw) process.off(REJECTION, gated);
        Reflect.apply(original, process, [reason, promise]);
      },
      { listener: original },
    );
    wrapped.set(gated, raw);
    return gated;
  };

  // The server always installs the Cursor SDK's listener (CursorSdk.ts). It exits when it listens
  // alone and leaves a rejection to the others otherwise, so beside a plain listener T3's own
  // rejections would no longer stop the server. Wrapped, it still sees those, and only those.
  const sync = () => {
    if (!installed || syncing) return;
    syncing = true;
    try {
      const listeners = process.rawListeners(REJECTION).filter(isListener);
      const others = listeners.filter((other) => other !== alone);
      if (
        others.every((other) => wrapped.has(other)) &&
        (others.length === 0) === listeners.includes(alone)
      ) {
        return;
      }
      // Re-adding them all keeps their order.
      process.removeAllListeners(REJECTION);
      for (const other of others) {
        process.on(REJECTION, wrapped.has(other) ? other : wrap(other));
      }
      if (others.length === 0) process.on(REJECTION, alone);
    } finally {
      syncing = false;
    }
  };
  // Node adds a listener after announcing it, so it is wrapped once it is in.
  const onNewListener = (event: string | symbol) => {
    if (!syncing && event === REJECTION) queueMicrotask(sync);
  };
  const onRemoveListener = (event: string | symbol) => {
    if (!syncing && event === REJECTION) sync();
  };

  return {
    /** Ties failures whose stack names a file under `root` to the plugin; the first call installs. */
    watch: (root: string, pluginId: PluginId) => {
      roots.set(root, pluginId);
      if (installed) return;
      installed = true;
      sync();
      process.on("newListener", onNewListener);
      process.on("removeListener", onRemoveListener);
      process.on("uncaughtExceptionMonitor", onUncaught);
    },
    /** Puts back the listeners it wrapped. */
    uninstall: () => {
      if (!installed) return;
      installed = false;
      process.off("newListener", onNewListener);
      process.off("removeListener", onRemoveListener);
      process.off("uncaughtExceptionMonitor", onUncaught);
      const others = process.rawListeners(REJECTION).filter(isListener);
      process.removeAllListeners(REJECTION);
      for (const other of others) {
        if (other !== alone) process.on(REJECTION, wrapped.get(other) ?? other);
      }
    },
  };
};
