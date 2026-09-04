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
import * as DateTime from "effect/DateTime";
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
    /** Whether a forward to the peer is currently up. */
    readonly isActive: (peerId: EnvironmentId) => Effect.Effect<boolean>;
  }
>()("t3/federation/FederationTransport") {}

/** Forwards nobody has used for this long are closed; the next call reopens one. */
const FORWARD_IDLE_TTL = Duration.minutes(10);
const FORWARD_IDLE_SWEEP_INTERVAL = Duration.minutes(1);

interface ActiveForward {
  readonly scope: Scope.Closeable;
  readonly handle: TailcatRuntime.TailcatForwardHandle;
  readonly address: string;
  readonly port: number;
  readonly lastUsedAtMs: number;
}

const withoutKey = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

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
  // One lock per peer: a slow or unreachable peer must not stall the others.
  const locks = yield* Ref.make<ReadonlyMap<EnvironmentId, Semaphore.Semaphore>>(new Map());
  const lockFor = (peerId: EnvironmentId) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(locks)).get(peerId);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      yield* Ref.update(locks, (current) => new Map(current).set(peerId, created));
      return created;
    });
  const withPeerLock = <A, E>(peerId: EnvironmentId, effect: Effect.Effect<A, E>) =>
    lockFor(peerId).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

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

  const endpointFor: FederationTransport["Service"]["endpointFor"] = ({ peerId, transport }) =>
    withPeerLock(
      peerId,
      Effect.gen(function* () {
        const existing = (yield* Ref.get(forwards)).get(peerId);
        if (existing !== undefined) {
          const sameTarget =
            existing.address === transport.tailcat.address &&
            existing.port === transport.tailcat.port;
          // A live forward is trusted as-is; a failed request drops it and the
          // caller retries, which is cheaper than probing before every call.
          if (sameTarget && (yield* existing.handle.isRunning)) {
            const touched = { ...existing, lastUsedAtMs: yield* nowMs };
            yield* Ref.update(forwards, (current) => new Map(current).set(peerId, touched));
            return {
              httpBaseUrl: existing.handle.httpBaseUrl,
              localPort: existing.handle.localPort,
            } satisfies PeerEndpoint;
          }
          yield* Ref.update(forwards, (current) => withoutKey(current, peerId));
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
            lastUsedAtMs: 0,
          }),
        );
        const touchedAt = yield* nowMs;
        yield* Ref.update(forwards, (current) => {
          const entry = current.get(peerId);
          return entry === undefined
            ? current
            : new Map(current).set(peerId, { ...entry, lastUsedAtMs: touchedAt });
        });
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
    withPeerLock(
      peerId,
      Effect.gen(function* () {
        const existing = (yield* Ref.get(forwards)).get(peerId);
        if (existing === undefined) {
          return;
        }
        yield* Ref.update(forwards, (current) => withoutKey(current, peerId));
        yield* closeForward(existing);
      }),
    );

  const isActive: FederationTransport["Service"]["isActive"] = (peerId) =>
    Ref.get(forwards).pipe(
      Effect.flatMap((current) => {
        const existing = current.get(peerId);
        return existing === undefined ? Effect.succeed(false) : existing.handle.isRunning;
      }),
    );

  // Idle forwards are child processes with keepalive traffic; close the ones
  // nobody has called through recently.
  const sweepIdle = Effect.gen(function* () {
    const cutoff = (yield* nowMs) - Duration.toMillis(FORWARD_IDLE_TTL);
    const current = yield* Ref.get(forwards);
    for (const [peerId, forward] of current) {
      if (forward.lastUsedAtMs < cutoff) {
        yield* drop(peerId);
        yield* Effect.logInfo("Federation transport closed after idling.", { peerId });
      }
    }
  });
  yield* Effect.sleep(FORWARD_IDLE_SWEEP_INTERVAL).pipe(
    Effect.andThen(sweepIdle),
    Effect.forever,
    Effect.forkIn(serviceScope),
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
    isActive,
  });
});

export const layer = Layer.effect(FederationTransport, make);
