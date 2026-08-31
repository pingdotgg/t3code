import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "@t3tools/client-runtime/connection";
import { P2pEnvironmentGateway, type P2pDialInput } from "@t3tools/client-runtime/platform";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { AppState, type NativeEventSubscription } from "react-native";
import type { Worklet } from "react-native-bare-kit";

import {
  createP2pWorkletReplyDecoder,
  encodeP2pWorkletCommand,
  type P2pWorkletCommand,
  type P2pWorkletReply,
} from "./protocol";

const DIAL_TIMEOUT_MILLIS = 45_000;

interface ActiveWorklet {
  readonly worklet: Worklet;
  readonly appStateSubscription: NativeEventSubscription;
  readonly pending: Map<string, (reply: P2pWorkletReply) => void>;
  /** publicKeyZ32 → loopback port of the live tunnel. */
  readonly tunnels: Map<string, number>;
  /** Bytes helpers from `b4a` — BareKit IPC only accepts TypedArrays. */
  readonly bytes: {
    readonly toString: (buffer: Uint8Array, encoding?: string) => string;
    readonly from: (input: string, encoding?: string) => Uint8Array;
  };
  nextRequestId: number;
}

/**
 * Mobile implementation of the P2P gateway: a Bare worklet
 * (react-native-bare-kit) runs hyperdht and relays a loopback TCP listener to
 * the dialed public key; the ordinary connection stack consumes the loopback
 * URLs unchanged. The worklet starts lazily on the first dial, follows the
 * app's foreground state for suspend/resume, and terminates once the last
 * tunnel is gone, so it costs nothing while no P2P environment is connected.
 */
export const makeMobileP2pEnvironmentGateway = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  let active: ActiveWorklet | undefined;

  const terminateWorklet = () => {
    if (active === undefined) {
      return;
    }
    const current = active;
    active = undefined;
    current.appStateSubscription.remove();
    for (const [id, settle] of current.pending) {
      settle({
        type: "dial-error",
        id,
        publicKeyZ32: "",
        message: "the P2P runtime was shut down",
      });
    }
    current.pending.clear();
    try {
      current.worklet.terminate();
    } catch {
      // Already dead; nothing to release.
    }
  };

  yield* Effect.addFinalizer(() => Effect.sync(terminateWorklet));

  const ensureWorklet = Effect.gen(function* () {
    if (active !== undefined) {
      return active;
    }
    const [bareKitModule, bundleModule, b4aModule] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          import("react-native-bare-kit"),
          import("./worklet/p2p-worklet.bundle.mjs"),
          import("b4a"),
        ]),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: `The P2P runtime is unavailable in this build: ${String(cause)}`,
        }),
    });
    const WorkletCtor =
      (
        bareKitModule as {
          Worklet?: new () => Worklet;
          default?: { Worklet?: new () => Worklet };
        }
      ).Worklet ??
      (bareKitModule as { default?: { Worklet?: new () => Worklet } }).default?.Worklet;
    const bundleSource =
      typeof bundleModule.default === "string"
        ? bundleModule.default
        : typeof (bundleModule as { default?: { default?: unknown } }).default?.default === "string"
          ? (bundleModule as { default: { default: string } }).default.default
          : undefined;
    const b4aExport = (b4aModule as { default?: typeof b4aModule }).default ?? b4aModule;
    const bytes = {
      toString: (
        b4aExport as {
          toString: (buffer: Uint8Array, encoding?: string) => string;
        }
      ).toString,
      from: (
        b4aExport as {
          from: (input: string, encoding?: string) => Uint8Array;
        }
      ).from,
    };
    if (WorkletCtor === undefined || bundleSource === undefined) {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "The P2P runtime modules did not load correctly in this build.",
      });
    }
    const worklet = yield* Effect.try({
      try: () => {
        const instance = new WorkletCtor();
        instance.start("/p2p-worklet.bundle", bundleSource);
        return instance;
      },
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: `The P2P runtime failed to start: ${String(cause)}`,
        }),
    });

    const started: ActiveWorklet = {
      worklet,
      appStateSubscription: AppState.addEventListener("change", (state) => {
        // Suspends the Bare thread in the background so an idle tunnel does
        // not burn battery; resumed automatically on foreground.
        worklet.update(state);
      }),
      pending: new Map(),
      tunnels: new Map(),
      bytes,
      nextRequestId: 1,
    };

    const decodeChunk = createP2pWorkletReplyDecoder();
    started.worklet.IPC.on("data", (data: unknown) => {
      const chunk =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? started.bytes.toString(data)
            : "";
      for (const reply of decodeChunk(chunk)) {
        if (reply.type === "listening") {
          started.tunnels.set(reply.publicKeyZ32, reply.port);
        }
        if (reply.type === "closed") {
          started.tunnels.delete(reply.publicKeyZ32);
        }
        const settle = started.pending.get(reply.id);
        if (settle !== undefined) {
          started.pending.delete(reply.id);
          settle(reply);
        }
      }
    });
    // A dead worklet (crash, OS kill) settles whatever is pending and resets
    // the gateway so the next dial starts a fresh one.
    started.worklet.IPC.on("close", () => {
      if (active === started) {
        terminateWorklet();
      }
    });

    active = started;
    return started;
  });

  const sendCommand = (current: ActiveWorklet, command: P2pWorkletCommand) =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<P2pWorkletReply>();
      current.pending.set(command.id, (reply) => {
        Deferred.doneUnsafe(settled, Effect.succeed(reply));
      });
      yield* Effect.try({
        try: () => {
          // BareKit's native write path requires an ArrayBuffer view. Passing a
          // raw string makes JSI throw; passing typedArray.buffer can also
          // arrive as undefined across RN TurboModules. Own the bytes in a
          // standalone Uint8Array and let the patched BareKit accept the view.
          const payload = new TextEncoder().encode(encodeP2pWorkletCommand(command));
          current.worklet.IPC.write(payload);
        },
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "network",
            detail: `Could not reach the P2P runtime: ${String(cause)}`,
          }),
      });
      return yield* Deferred.await(settled).pipe(
        Effect.timeoutOrElse({
          duration: DIAL_TIMEOUT_MILLIS,
          orElse: () =>
            Effect.sync(() => {
              current.pending.delete(command.id);
            }).pipe(
              Effect.andThen(
                new ConnectionTransientError({
                  reason: "timeout",
                  detail: "Timed out reaching the environment over the DHT.",
                }),
              ),
            ),
        }),
      );
    });

  const prepare = (
    input: P2pDialInput,
  ): Effect.Effect<{ httpBaseUrl: string; wsBaseUrl: string }, ConnectionAttemptError> =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* ensureWorklet;
        const reply = yield* sendCommand(current, {
          type: "dial",
          id: `dial-${current.nextRequestId++}`,
          publicKeyZ32: input.publicKeyZ32,
          bootstrap: input.bootstrap,
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (active !== undefined && active.tunnels.size === 0) {
                terminateWorklet();
              }
            }),
          ),
        );
        if (reply.type !== "listening") {
          if (active !== undefined && active.tunnels.size === 0) {
            terminateWorklet();
          }
          return yield* new ConnectionTransientError({
            reason: "network",
            detail: reply.type === "dial-error" ? reply.message : "Could not open the P2P tunnel.",
          });
        }
        return {
          httpBaseUrl: `http://127.0.0.1:${reply.port}`,
          wsBaseUrl: `ws://127.0.0.1:${reply.port}`,
        };
      }),
    );

  const disconnect = (publicKeyZ32: string): Effect.Effect<void, ConnectionAttemptError> =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = active;
        if (current === undefined || !current.tunnels.has(publicKeyZ32)) {
          return;
        }
        yield* sendCommand(current, {
          type: "close",
          id: `close-${current.nextRequestId++}`,
          publicKeyZ32,
        }).pipe(Effect.ignore);
        current.tunnels.delete(publicKeyZ32);
        if (current.tunnels.size === 0) {
          terminateWorklet();
        }
      }),
    );

  return P2pEnvironmentGateway.of({ prepare, disconnect });
});
