// @effect-diagnostics nodeBuiltinImport:off - AsyncLocalStorage has no Effect counterpart, and it
// must follow plugin code through Node's own callbacks.
import * as NodeAsyncHooks from "node:async_hooks";

import type { PluginId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { PluginActivation } from "../PluginApi.ts";

const MAX_ERROR_CHARS = 500;

export const errorText = (cause: unknown) => {
  let text = "Unknown error";
  try {
    text =
      cause instanceof Error && typeof cause.message === "string" ? cause.message : String(cause);
  } catch {
    // Plugin code can throw values whose conversion to a string throws again.
  }
  return text.slice(0, MAX_ERROR_CHARS);
};

export class PluginCodeError extends Schema.TaggedError<PluginCodeError>()("PluginCodeError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return errorText(this.cause);
  }
}

/**
 * The plugin whose code is running, carried through every timer, promise and Node callback that
 * code starts, so a failure whose stack shows only Node's internals is still the plugin's. The host
 * runs no server code before Node 24, where this needs promise hooks.
 */
export const pluginCodeScope = new NodeAsyncHooks.AsyncLocalStorage<PluginId>();

export interface FacadeContext {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
  readonly asPlugin: <A>(run: () => A) => A;
  /**
   * Runs an effect as a Promise that rejects with an `Error` carrying the failure's `_tag` as `code`.
   * Map results inside the effect: a `.then` on the Promise is a new one that nothing handles.
   */
  readonly call: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Runs an effect in the background for the plugin; failures are logged, not thrown. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => void;
  /** Exposes a stream as an iterable that ends when the plugin deactivates. */
  readonly iterate: <A, E>(stream: Stream.Stream<A, E>) => AsyncIterable<A>;
}

/**
 * Hands a plugin a promise whose failure only the plugin sees: one it never awaits must not be an
 * unhandled rejection, which stops the server.
 */
const forPlugin = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined);
  return promise;
};

export const refused = (error: Error): Promise<never> => forPlugin(Promise.reject(error));

/** Carries its plugin, so a failure no plugin code handles is still the plugin's. */
// @effect-diagnostics-next-line extendsNativeError:off -- plugin code catches it as a plain Error with a `code`.
export class PluginApiCallError extends Error {
  readonly code: string;
  readonly pluginId: PluginId;
  constructor(pluginId: PluginId, code: string, message: string) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
    this.pluginId = pluginId;
  }
}

export const abortEffect = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export const makeFacadeContext = (input: {
  readonly pluginId: PluginId;
  readonly activation: PluginActivation;
  readonly context: Context.Context<never>;
}): FacadeContext => {
  const { activation, context, pluginId } = input;
  // T3's work for a call is not the plugin's code, so it leaves the plugin's scope.
  const runExit = <A, E>(effect: Effect.Effect<A, E>) =>
    pluginCodeScope.exit(() => Effect.runPromiseExitWith(context)(effect));
  // Cleanups may still save state; afterwards a disabled plugin's leftovers cannot act.
  const call: FacadeContext["call"] = (effect) =>
    activation.ended.signal.aborted
      ? refused(
          new PluginApiCallError(
            pluginId,
            "PluginDeactivated",
            "This plugin activation has ended.",
          ),
        )
      : forPlugin(
          runExit(effect).then((exit) => {
            if (Exit.isSuccess(exit)) return exit.value;
            const error = Cause.squash(exit.cause);
            const code =
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              typeof error._tag === "string"
                ? error._tag
                : "PluginApiFailure";
            throw new PluginApiCallError(
              pluginId,
              code,
              error instanceof Error ? error.message : "The plugin API call failed.",
            );
          }),
        );
  return {
    pluginId,
    activation,
    context,
    asPlugin: (run) => pluginCodeScope.run(pluginId, run),
    call,
    fork: (effect) => {
      pluginCodeScope.exit(() =>
        Effect.runForkWith(context)(
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("plugin background work failed", {
                pluginId,
                cause: Cause.pretty(cause).slice(0, 500),
              }),
            ),
          ),
        ),
      );
    },
    // The plugin pulls, but each pull runs T3's side of the stream, so it is a call too.
    iterate: (stream) => {
      const iterable = Stream.toAsyncIterableWith(
        stream.pipe(Stream.interruptWhen(abortEffect(activation.controller.signal))),
        context,
      );
      return {
        [Symbol.asyncIterator]: () => {
          const iterator = pluginCodeScope.exit(() => iterable[Symbol.asyncIterator]());
          return {
            next: () => call(Effect.promise(() => iterator.next())),
            return: () =>
              call(
                Effect.promise(
                  () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }),
                ),
              ),
          };
        },
      };
    },
  };
};
