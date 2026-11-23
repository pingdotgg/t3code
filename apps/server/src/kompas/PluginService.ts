import type { KompasError, Plugin, PluginTool, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { kompasError } from "./KompasDatabase.ts";
import { PluginProxy, type PluginProxyError } from "./PluginProxy.ts";
import { PluginStore } from "./PluginStore.ts";

const CONNECT_TIMEOUT = "30 seconds";

/** Plugins as Settings and agents use them: saved state and the live connection kept in step. */
export class PluginService extends Context.Service<
  PluginService,
  {
    readonly save: (plugin: Plugin) => Effect.Effect<void, KompasError>;
    readonly remove: (id: string) => Effect.Effect<void, KompasError>;
    /** Connects, and remembers the tools or the failure for Settings. */
    readonly test: (
      id: string,
    ) => Effect.Effect<{ readonly tools: ReadonlyArray<PluginTool> }, KompasError>;
    readonly signIn: (input: {
      readonly id: string;
      readonly redirectBaseUrl: string;
    }) => Effect.Effect<{ readonly authorizationUrl: string | null }, KompasError>;
    readonly finishSignIn: (
      state: string,
      code: string,
    ) => Effect.Effect<{ readonly plugin: Plugin }, KompasError>;
    /** The plugin with its secrets, or undefined while the conversation has it off. */
    readonly forThread: (
      threadId: ThreadId,
      pluginId: string,
    ) => Effect.Effect<Plugin | undefined, KompasError>;
  }
>()("t3/kompas/PluginService") {}

const fromProxy = (error: PluginProxyError) =>
  kompasError(error.needsSignIn ? "needs-sign-in" : "unreachable", error.message);

const make = Effect.gen(function* () {
  const store = yield* PluginStore;
  const proxy = yield* PluginProxy;

  const test = Effect.fn("PluginService.test")(function* (id: string) {
    const plugin = yield* store.get(id);
    const tools = yield* proxy.describeTools(plugin).pipe(
      Effect.mapError(fromProxy),
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(kompasError("unreachable", `${plugin.label} did not answer in time.`)),
      }),
      Effect.tapError((error) =>
        store.recordConnection(id, {
          tools: null,
          needsSignIn: error.reason === "needs-sign-in",
          error: error.message,
        }),
      ),
    );
    yield* store.recordConnection(id, { tools, needsSignIn: false, error: null });
    return { tools };
  });

  const save = Effect.fn("PluginService.save")(function* (plugin: Plugin) {
    yield* store.save(plugin);
    yield* proxy.disconnect(plugin.id);
  });

  const remove = Effect.fn("PluginService.remove")(function* (id: string) {
    yield* proxy.disconnect(id);
    yield* store.remove(id);
  });

  const signIn: PluginService["Service"]["signIn"] = Effect.fn("PluginService.signIn")(
    function* (input) {
      const plugin = yield* store.get(input.id);
      return yield* proxy
        .startSignIn(plugin, input.redirectBaseUrl)
        .pipe(Effect.mapError(fromProxy));
    },
  );

  const finishSignIn = Effect.fn("PluginService.finishSignIn")(function* (
    state: string,
    code: string,
  ) {
    const finished = yield* proxy.finishSignIn(state, code).pipe(Effect.mapError(fromProxy));
    // Lists the tools, so Settings shows the plugin ready without another click.
    yield* test(finished.plugin.id).pipe(Effect.ignore);
    return finished;
  });

  const forThread = Effect.fn("PluginService.forThread")(function* (
    threadId: ThreadId,
    pluginId: string,
  ) {
    const enabled = yield* store.forThread(threadId);
    return enabled.some((plugin) => plugin.id === pluginId)
      ? yield* store.get(pluginId)
      : undefined;
  });

  return PluginService.of({ save, remove, test, signIn, finishSignIn, forThread });
});

export const layer = Layer.effect(PluginService, make);
