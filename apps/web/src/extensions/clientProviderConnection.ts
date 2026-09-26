import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/unstable/reactivity";
import type {
  ClientProviderEmitEvent,
  ClientProviderServerFrame,
  ClientProvidersRespondInput,
  EnvironmentId,
} from "@t3tools/contracts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  environmentClientProviderEmit,
  environmentClientProviderRespond,
  environmentClientProvidersStream,
  environmentConnectionStateChanges,
} from "@t3tools/client-runtime/state/extensions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { ClientProviderOpError, type ClientLocalProvider } from "./clientProviderTypes";
import { noteClientProviderConnection } from "./extensionCommandRegistry";

/**
 * The client side of the `t3.client/*` seam: owns the connect stream's
 * lifetime, dispatches server frames to the local providers, and answers them
 * through `respond`/`emit`. One instance per environment.
 */

export interface ClientProviderConnectionDeps {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyMap<string, ClientLocalProvider>;
  readonly descriptors: readonly { readonly id: string; readonly version: string }[];
  /**
   * Commits staged `ClientHost.registerGlobalCommands` sets (and replays
   * committed ones) through each installation's invokeApi path. Runs once the
   * socket registers and again whenever installations change while live.
   */
  readonly flushGlobalCommands: (signal: AbortSignal) => Promise<void>;
}

export interface ClientProviderConnection {
  readonly stop: () => void;
  /** Re-run the staged-commit flush while the socket is registered. */
  readonly notifyInstallationsChanged: () => void;
}

const connectionIds = new Map<string, string>();
/** The loop instance that minted the current connection id — a stale teardown must not clear a replacement's identity. */
const connectionOwners = new Map<string, object>();

/** The socket-bound id the server minted for this environment's live seam, if any. */
export function currentClientConnectionId(environmentId: string): string | undefined {
  return connectionIds.get(environmentId);
}

/** Provider-facing emit — fire-and-forget over the current session. */
export function emitClientProviderEvent(
  environmentId: EnvironmentId,
  correlationId: string,
  event: ClientProviderEmitEvent,
) {
  void Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        environmentClientProviderEmit(environmentId, { correlationId, event }).pipe(
          Effect.provide(context),
        ),
      ),
    ),
  ).catch(() => {});
}

/** Per-iteration seam state, shared with `stop` so teardown never waits on the iterator. */
interface ConnectionIteration {
  connectionId: string | undefined;
  subscriptions: Map<string, () => void>;
  pending: Map<string, AbortController>;
  disposed: boolean;
}

export function startClientProviderConnection(
  deps: ClientProviderConnectionDeps,
): ClientProviderConnection {
  const lifecycle = new AbortController();
  const owner = {};
  const iteration: ConnectionIteration = {
    connectionId: undefined,
    subscriptions: new Map(),
    pending: new Map(),
    disposed: true,
  };
  /**
   * Tears down whatever the current iteration owns. Runs from the loop's
   * finally AND synchronously from `stop()` — the stream iterator may never
   * yield again, so cleanup cannot wait for the next frame. The ownership
   * guards keep a stale iteration from clearing a replacement's identity.
   */
  const teardownIteration = () => {
    iteration.disposed = true;
    if (connectionOwners.get(deps.environmentId) === owner) {
      // Only the owner may clear the identity it minted — a replacement loop
      // reusing the same socket-derived id keeps it across this teardown.
      if (
        iteration.connectionId !== undefined &&
        connectionIds.get(deps.environmentId) === iteration.connectionId
      ) {
        connectionIds.delete(deps.environmentId);
      }
      connectionOwners.delete(deps.environmentId);
      // The seam is down: registrations fence until the next connect replays them.
      noteClientProviderConnection(deps.environmentId, false);
    }
    iteration.connectionId = undefined;
    for (const close of [...iteration.subscriptions.values()]) {
      try {
        close();
      } catch {
        /* a throwing watcher must not break teardown */
      }
    }
    for (const controller of [...iteration.pending.values()]) controller.abort();
    iteration.subscriptions.clear();
    iteration.pending.clear();
  };
  const flush = () => {
    if (!connectionIds.has(deps.environmentId) || lifecycle.signal.aborted) return;
    void deps.flushGlobalCommands(lifecycle.signal).catch(() => {});
  };
  void runConnectionLoop(deps, lifecycle.signal, owner, iteration, teardownIteration).catch(
    () => {},
  );
  return {
    stop: () => {
      lifecycle.abort();
      teardownIteration();
    },
    notifyInstallationsChanged: flush,
  };
}

/**
 * Each iteration opens one connect stream on the current session. A transport
 * drop ends the iteration — the socket's connectionId and open subscriptions
 * die with it, then the loop waits for the next connected phase and reopens.
 */
async function runConnectionLoop(
  deps: ClientProviderConnectionDeps,
  signal: AbortSignal,
  owner: object,
  iteration: ConnectionIteration,
  teardownIteration: () => void,
) {
  const context = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime),
    { signal },
  );
  const emitEvent = (correlationId: string, event: ClientProviderEmitEvent) =>
    emitClientProviderEvent(deps.environmentId, correlationId, event);
  const respond = (payload: ClientProvidersRespondInput) => {
    void Effect.runPromise(
      environmentClientProviderRespond(deps.environmentId, payload).pipe(Effect.provide(context)),
    ).catch(() => {});
  };
  while (!signal.aborted) {
    iteration.connectionId = undefined;
    iteration.subscriptions = new Map();
    iteration.pending = new Map();
    iteration.disposed = false;
    try {
      const iterable = Stream.toAsyncIterableWith(
        environmentClientProvidersStream(deps.environmentId, {
          providers: [...deps.descriptors],
        }),
        context,
      );
      const iterator = iterable[Symbol.asyncIterator]();
      // Some transports never unblock `next()` on their own — race the pull
      // against the abort signal so `stop()` is observed immediately.
      let resolveAborted: () => void = () => {};
      const aborted = new Promise<"aborted">((resolve) => {
        resolveAborted = () => resolve("aborted");
      });
      signal.addEventListener("abort", resolveAborted, { once: true });
      try {
        while (!signal.aborted) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next === "aborted" || signal.aborted) return;
          // A clean EOF ends this iteration only — teardown runs, then the
          // loop waits for the transport's next connected phase and reopens.
          if (next.done) break;
          try {
            handleFrame(deps, next.value, emitEvent, respond, iteration, signal, owner);
          } catch {
            // A malformed frame or throwing provider hook must not kill the seam.
          }
        }
      } finally {
        signal.removeEventListener("abort", resolveAborted);
        await iterator.return?.().catch(() => {});
      }
    } catch {
      // Transport or session failure — fall through to the reconnect wait.
    } finally {
      teardownIteration();
    }
    if (signal.aborted) return;
    // A non-transport failure (e.g. a rejected connect) would otherwise spin.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (signal.aborted) return;
    await waitForReconnect(deps.environmentId, signal).catch(() => {});
  }
}

function handleFrame(
  deps: ClientProviderConnectionDeps,
  frame: ClientProviderServerFrame,
  emitEvent: (correlationId: string, event: ClientProviderEmitEvent) => void,
  respond: (payload: ClientProvidersRespondInput) => void,
  iteration: ConnectionIteration,
  signal: AbortSignal,
  owner: object,
) {
  const { subscriptions, pending } = iteration;
  switch (frame.type) {
    case "registered": {
      connectionIds.set(deps.environmentId, frame.connectionId);
      connectionOwners.set(deps.environmentId, owner);
      iteration.connectionId = frame.connectionId;
      // A new connection epoch: prior registrations stay fenced until the
      // flush replays them onto this socket.
      noteClientProviderConnection(deps.environmentId, true);
      void deps.flushGlobalCommands(signal).catch(() => {});
      return;
    }
    case "invoke": {
      const provider = deps.providers.get(frame.apiId);
      const controller = new AbortController();
      pending.set(frame.requestId, controller);
      void (async () => {
        try {
          if (!provider)
            throw new ClientProviderOpError(
              "client-provider-unavailable",
              `No local provider for ${frame.apiId}`,
            );
          const value = await provider.invoke({
            method: frame.method,
            input: frame.input,
            context: frame.context as ViewContext,
            caller: frame.caller,
            signal: controller.signal,
          });
          respond({ requestId: frame.requestId, ok: true, value: value ?? null });
        } catch (error) {
          respond({
            requestId: frame.requestId,
            ok: false,
            error: {
              code: error instanceof ClientProviderOpError ? error.code : "provider-rejected",
              message: (error instanceof Error ? error.message : "Provider failed").slice(0, 2000),
            },
          });
        } finally {
          pending.delete(frame.requestId);
        }
      })();
      return;
    }
    case "cancel": {
      pending.get(frame.requestId)?.abort();
      return;
    }
    case "subscriptionOpen": {
      const provider = deps.providers.get(frame.apiId);
      const emit = (event: ClientProviderEmitEvent) => emitEvent(frame.subscriptionId, event);
      if (!provider?.openStream) {
        emit({ type: "closed", value: null });
        return;
      }
      // The async wrapper confines synchronous throws and rejections to this
      // subscription — a failing open never tears down the connection.
      void (async () => {
        let close: () => void;
        try {
          close = await provider.openStream!({
            name: frame.name,
            input: frame.input,
            context: frame.context as ViewContext,
            caller: frame.caller,
            emit,
          });
        } catch {
          emit({ type: "closed", value: null });
          return;
        }
        // An open that resolves after teardown or a racing close must not
        // install a live subscription into a dead iteration.
        if (iteration.disposed || iteration.subscriptions !== subscriptions) {
          try {
            close();
          } catch {
            /* teardown-only path */
          }
          return;
        }
        if (subscriptions.has(frame.subscriptionId)) {
          // Remove the close-pending marker so the map does not retain it.
          subscriptions.delete(frame.subscriptionId);
          try {
            close();
          } catch {
            /* teardown-only path */
          }
          return;
        }
        subscriptions.set(frame.subscriptionId, close);
      })();
      return;
    }
    case "subscriptionClose": {
      const close = subscriptions.get(frame.subscriptionId);
      if (close === undefined) {
        // The open is still resolving — mark it so its completion closes.
        subscriptions.set(frame.subscriptionId, () => {});
        return;
      }
      subscriptions.delete(frame.subscriptionId);
      try {
        close();
      } catch {
        /* a throwing watcher must not kill the seam */
      }
      return;
    }
  }
}

/** Resolves once the environment reports a connected phase, or on abort. */
async function waitForReconnect(environmentId: EnvironmentId, signal: AbortSignal) {
  const context = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime),
    { signal },
  );
  const iterable = Stream.toAsyncIterableWith(
    environmentConnectionStateChanges(environmentId),
    context,
  );
  const iterator = iterable[Symbol.asyncIterator]();
  const cancel = () => void iterator.return?.().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await iterator.next();
      if (next.done) return;
      if (next.value.phase === "connected") return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await iterator.return?.();
  }
}
