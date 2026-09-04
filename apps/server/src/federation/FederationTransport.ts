import {
  type EnvironmentId,
  FederationError,
  type FederationTransport as FederationTransportDescriptor,
  type TailcatNodeKey,
} from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as NetService from "@t3tools/shared/Net";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";

/**
 * FederationTransport gives this server a loopback HTTP endpoint for each peer
 * by running a Tailcat forward to the peer's listener, using this server's own
 * Tailcat client identity. Forwards are created lazily, reused while healthy,
 * and closed when the peer is removed or the server shuts down.
 */
export const TAILCAT_CLIENT_IDENTITY_FILE = "tailcat-client-identity.private.json";
const PEER_READY_TIMEOUT = Duration.seconds(25);
const PEER_HEALTH_TIMEOUT = Duration.millis(2_500);

export interface PeerEndpoint {
  readonly httpBaseUrl: string;
  readonly localPort: number;
}

export class FederationTransport extends Context.Service<
  FederationTransport,
  {
    /** This server's Tailcat client node key, created on first use. */
    readonly clientNodeKey: Effect.Effect<TailcatNodeKey, FederationError>;
    readonly endpointFor: (input: {
      readonly peerId: EnvironmentId;
      readonly transport: FederationTransportDescriptor;
    }) => Effect.Effect<PeerEndpoint, FederationError>;
    /** Drops the forward for a peer so the next call starts a fresh one. */
    readonly drop: (peerId: EnvironmentId) => Effect.Effect<void>;
  }
>()("t3/federation/FederationTransport") {}

interface ActiveForward {
  readonly scope: Scope.Closeable;
  readonly handle: TailcatRuntime.TailcatForwardHandle;
  readonly address: string;
  readonly port: number;
}

const transportUnavailable = (message: string) =>
  new FederationError({ code: "transport-unavailable", message });

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtime = yield* TailcatRuntime.TailcatRuntime;
  const net = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Scope.Scope;
  const identityPath = path.join(config.secretsDir, TAILCAT_CLIENT_IDENTITY_FILE);
  const forwards = yield* Ref.make<ReadonlyMap<EnvironmentId, ActiveForward>>(new Map());
  const lock = yield* Semaphore.make(1);

  const clientNodeKey: FederationTransport["Service"]["clientNodeKey"] = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(identityPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      const created = yield* runtime.generateClientIdentity({ keyPath: identityPath });
      return created.nodeKey;
    }
    return yield* runtime.readClientPublicKey({ keyPath: identityPath });
  }).pipe(
    Effect.mapError((error) =>
      transportUnavailable(`Tailcat is not available on this machine: ${error.message}`),
    ),
  );

  const closeForward = (forward: ActiveForward) =>
    Scope.close(forward.scope, Exit.void).pipe(Effect.ignore);

  const probe = (httpBaseUrl: string) =>
    waitForHttpReady({
      baseUrl: httpBaseUrl,
      path: "/.well-known/t3/environment",
      timeoutMs: Duration.toMillis(PEER_HEALTH_TIMEOUT),
      intervalMs: 250,
      probeTimeoutMs: Duration.toMillis(PEER_HEALTH_TIMEOUT),
      makeError: () => "unhealthy" as const,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const endpointFor: FederationTransport["Service"]["endpointFor"] = ({ peerId, transport }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = (yield* Ref.get(forwards)).get(peerId);
        if (existing !== undefined) {
          const sameTarget =
            existing.address === transport.tailcat.address &&
            existing.port === transport.tailcat.port;
          const alive = sameTarget && (yield* existing.handle.isRunning);
          if (alive) {
            const healthy = yield* probe(existing.handle.httpBaseUrl).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (healthy) {
              return {
                httpBaseUrl: existing.handle.httpBaseUrl,
                localPort: existing.handle.localPort,
              } satisfies PeerEndpoint;
            }
          }
          yield* Ref.update(forwards, (current) => {
            const next = new Map(current);
            next.delete(peerId);
            return next;
          });
          yield* closeForward(existing);
        }
        yield* clientNodeKey;
        const localPort = yield* net
          .reserveLoopbackPort()
          .pipe(
            Effect.mapError((error) =>
              transportUnavailable(`Could not reserve a local port: ${error.message}`),
            ),
          );
        const scope = yield* Scope.make("sequential");
        const handle = yield* runtime
          .forward({
            keyPath: identityPath,
            address: transport.tailcat.address,
            remotePort: transport.tailcat.port,
            localPort,
            readiness: ({ httpBaseUrl }) =>
              waitForHttpReady({
                baseUrl: httpBaseUrl,
                path: "/.well-known/t3/environment",
                timeoutMs: Duration.toMillis(PEER_READY_TIMEOUT),
                intervalMs: 300,
                probeTimeoutMs: 3_000,
                makeError: () => "unreachable" as const,
              }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
            readinessTimeout: PEER_READY_TIMEOUT,
          })
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
            Effect.mapError((error) =>
              error === "unreachable"
                ? new FederationError({
                    code: "peer-unreachable",
                    message:
                      "The peer did not answer through Tailcat. It may be offline, or this environment may no longer be trusted by it.",
                  })
                : error._tag === "TailcatBinaryMissingError" ||
                    error._tag === "TailcatBinaryNotExecutableError" ||
                    error._tag === "TailcatVersionIncompatibleError"
                  ? transportUnavailable(error.message)
                  : new FederationError({ code: "peer-unreachable", message: error.message }),
            ),
          );
        yield* Ref.update(forwards, (current) =>
          new Map(current).set(peerId, {
            scope,
            handle,
            address: transport.tailcat.address,
            port: transport.tailcat.port,
          }),
        );
        yield* Effect.logInfo("Federation transport ready.", {
          peerId,
          localPort: handle.localPort,
          pid: handle.pid,
        });
        return {
          httpBaseUrl: handle.httpBaseUrl,
          localPort: handle.localPort,
        } satisfies PeerEndpoint;
      }),
    );

  const drop: FederationTransport["Service"]["drop"] = (peerId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = (yield* Ref.get(forwards)).get(peerId);
        if (existing === undefined) {
          return;
        }
        yield* Ref.update(forwards, (current) => {
          const next = new Map(current);
          next.delete(peerId);
          return next;
        });
        yield* closeForward(existing);
      }),
    );

  yield* Scope.addFinalizer(
    serviceScope,
    Ref.get(forwards).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), closeForward, { discard: true, concurrency: "unbounded" }),
      ),
    ),
  );

  return FederationTransport.of({
    clientNodeKey,
    endpointFor,
    drop,
  });
});

export const layer = Layer.effect(FederationTransport, make);
