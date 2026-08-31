import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * Deleting this secret from the secrets directory rotates the endpoint's
 * identity: the next announce derives a fresh keypair and every paired device
 * must re-pair against the new address.
 */
export const P2P_ENDPOINT_SEED_SECRET = "p2p-endpoint-seed";

const P2P_SEED_BYTES = 32;

export type P2pEndpointStatus =
  | { readonly status: "disabled" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "announced"; readonly publicKeyZ32: string };

export interface P2pEnsureInput {
  /** Local HTTP port accepted Noise streams are relayed to. */
  readonly targetPort: number;
  /** DHT bootstrap nodes as host:port entries; empty means the public DHT. */
  readonly bootstrap: ReadonlyArray<string>;
}

/**
 * Owns the DHT announcement for this environment. The heavy Holepunch modules
 * load lazily on first ensure and a load failure degrades to an `unavailable`
 * status instead of failing the server, so runtimes without the native
 * addons (for example Bun dev runs) keep working without P2P.
 */
export class P2pEndpointRuntime extends Context.Service<
  P2pEndpointRuntime,
  {
    readonly status: Effect.Effect<P2pEndpointStatus>;
    /** Starts (or re-targets) the announcement relaying to the given local port. */
    readonly ensure: (input: P2pEnsureInput) => Effect.Effect<P2pEndpointStatus>;
    readonly disable: Effect.Effect<void>;
    /** Emits after every status transition so clients can refresh without reconnecting. */
    readonly streamChanges: Stream.Stream<P2pEndpointStatus>;
  }
>()("t3/remoteAccess/P2pEndpointRuntime") {}

interface ActiveAnnouncement {
  readonly scope: Scope.Closeable;
  readonly publicKeyZ32: string;
  readonly inputKey: string;
}

const ensureInputKey = (input: P2pEnsureInput): string =>
  JSON.stringify({ targetPort: input.targetPort, bootstrap: input.bootstrap });

interface RuntimeState {
  readonly active: ActiveAnnouncement | null;
  readonly status: P2pEndpointStatus;
}

const DISABLED_STATE: RuntimeState = { active: null, status: { status: "disabled" } };

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stateRef = yield* Ref.make<RuntimeState>(DISABLED_STATE);
  const semaphore = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<P2pEndpointStatus>();

  const publish = (status: P2pEndpointStatus) =>
    PubSub.publish(changes, status).pipe(Effect.asVoid);

  const clearActive = Effect.gen(function* () {
    const state = yield* Ref.getAndSet(stateRef, DISABLED_STATE);
    if (state.active) {
      yield* Scope.close(state.active.scope, Exit.void).pipe(Effect.ignore);
    }
    return state.status;
  });

  const becomeUnavailable = (reason: string, cause: unknown) =>
    Effect.gen(function* () {
      const status: P2pEndpointStatus = { status: "unavailable", reason };
      yield* Effect.logWarning("P2P endpoint unavailable", { reason, cause });
      yield* Ref.set(stateRef, { active: null, status });
      yield* publish(status);
      return status;
    });

  const ensure: P2pEndpointRuntime["Service"]["ensure"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const inputKey = ensureInputKey(input);
        const state = yield* Ref.get(stateRef);
        if (state.active?.inputKey === inputKey) {
          return state.status;
        }
        yield* clearActive;

        const imported = yield* Effect.result(
          Effect.tryPromise(() => import("@t3tools/p2p/announcer")),
        );
        if (Result.isFailure(imported)) {
          return yield* becomeUnavailable(
            "The P2P runtime failed to load on this system.",
            imported.failure,
          );
        }
        const seed = yield* Effect.result(
          secrets.getOrCreateRandom(P2P_ENDPOINT_SEED_SECRET, P2P_SEED_BYTES),
        );
        if (Result.isFailure(seed)) {
          return yield* becomeUnavailable(
            "Failed to read or create the P2P endpoint seed.",
            seed.failure,
          );
        }

        const scope = yield* Scope.make("sequential");
        const announced = yield* Effect.result(
          imported.success
            .announceP2pEndpoint({
              seed: seed.success,
              targetPort: input.targetPort,
              bootstrap: input.bootstrap,
            })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        if (Result.isFailure(announced)) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
          return yield* becomeUnavailable(
            "Failed to announce the P2P endpoint on the DHT.",
            announced.failure,
          );
        }

        const status: P2pEndpointStatus = {
          status: "announced",
          publicKeyZ32: announced.success.publicKeyZ32,
        };
        yield* Ref.set(stateRef, {
          active: { scope, publicKeyZ32: announced.success.publicKeyZ32, inputKey },
          status,
        });
        yield* Effect.logInfo("P2P endpoint announced", {
          publicKeyZ32: announced.success.publicKeyZ32,
          targetPort: input.targetPort,
        });
        yield* publish(status);
        return status;
      }),
    );

  const disable = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const previous = yield* clearActive;
      if (previous.status !== "disabled") {
        yield* publish({ status: "disabled" });
      }
    }),
  );

  return P2pEndpointRuntime.of({
    status: Ref.get(stateRef).pipe(Effect.map((state) => state.status)),
    ensure,
    disable,
    streamChanges: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(P2pEndpointRuntime, make);
