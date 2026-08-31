import type { DesktopP2pEnvironmentDialInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

export class DesktopP2pEnvironmentError extends Schema.TaggedErrorClass<DesktopP2pEnvironmentError>()(
  "DesktopP2pEnvironmentError",
  {
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface DesktopP2pEnvironmentEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

interface ActiveTunnel {
  readonly endpoint: DesktopP2pEnvironmentEndpoint;
  readonly scope: Scope.Closeable;
  readonly bootstrapKey: string;
}

/**
 * Owns the P2P loopback tunnels in the Electron main process, keyed by the
 * remote endpoint's public key: ensure reuses a live tunnel (re-dialing only
 * when the bootstrap list changed), disconnect tears one down. The Holepunch
 * modules load lazily so a native addon failure surfaces as a typed error on
 * first dial instead of breaking desktop startup.
 */
export class DesktopP2pEnvironment extends Context.Service<
  DesktopP2pEnvironment,
  {
    readonly ensureEnvironment: (
      input: DesktopP2pEnvironmentDialInput,
    ) => Effect.Effect<DesktopP2pEnvironmentEndpoint, DesktopP2pEnvironmentError>;
    readonly disconnectEnvironment: (publicKeyZ32: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/p2p/DesktopP2pEnvironment") {}

export const make = Effect.gen(function* () {
  const tunnels = yield* Ref.make<ReadonlyMap<string, ActiveTunnel>>(new Map());
  const semaphore = yield* Semaphore.make(1);

  const closeTunnel = (publicKeyZ32: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(tunnels);
      const active = current.get(publicKeyZ32);
      if (active === undefined) {
        return;
      }
      yield* Ref.update(tunnels, (map) => {
        const next = new Map(map);
        next.delete(publicKeyZ32);
        return next;
      });
      yield* Scope.close(active.scope, Exit.void).pipe(Effect.ignore);
    });

  const ensureEnvironment: DesktopP2pEnvironment["Service"]["ensureEnvironment"] = (input) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const bootstrapKey = input.bootstrap.join(",");
        const current = (yield* Ref.get(tunnels)).get(input.publicKeyZ32);
        if (current !== undefined && current.bootstrapKey === bootstrapKey) {
          return current.endpoint;
        }
        yield* closeTunnel(input.publicKeyZ32);

        const dialer = yield* Effect.tryPromise({
          try: () => import("@t3tools/p2p/dialer"),
          catch: (cause) =>
            new DesktopP2pEnvironmentError({
              detail: "The P2P runtime failed to load on this system.",
              cause,
            }),
        });
        const scope = yield* Scope.make("sequential");
        const tunnel = yield* dialer
          .createP2pTunnel({
            publicKeyZ32: input.publicKeyZ32,
            bootstrap: input.bootstrap,
          })
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.catch((cause) =>
              Scope.close(scope, Exit.void).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(
                    new DesktopP2pEnvironmentError({
                      detail: "Could not open the P2P tunnel.",
                      cause,
                    }),
                  ),
                ),
              ),
            ),
          );
        const endpoint = { httpBaseUrl: tunnel.httpBaseUrl, wsBaseUrl: tunnel.wsBaseUrl };
        yield* Ref.update(tunnels, (map) => {
          const next = new Map(map);
          next.set(input.publicKeyZ32, { endpoint, scope, bootstrapKey });
          return next;
        });
        yield* Effect.logInfo("P2P environment tunnel opened", {
          publicKeyZ32: input.publicKeyZ32,
          localHttpBaseUrl: endpoint.httpBaseUrl,
        });
        return endpoint;
      }),
    );

  const disconnectEnvironment: DesktopP2pEnvironment["Service"]["disconnectEnvironment"] = (
    publicKeyZ32,
  ) => semaphore.withPermits(1)(closeTunnel(publicKeyZ32));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(tunnels, new Map());
      yield* Effect.forEach(
        current.values(),
        (active) => Scope.close(active.scope, Exit.void).pipe(Effect.ignore),
        { discard: true },
      );
    }),
  );

  return DesktopP2pEnvironment.of({ ensureEnvironment, disconnectEnvironment });
});

export const layer = Layer.effect(DesktopP2pEnvironment, make);
