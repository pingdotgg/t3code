import {
  EnvironmentId,
  FederationCapability,
  type FederationPeer,
  type FederationPeerStatus,
  FederationRemoteRun,
  FederationScopes,
  FederationTransport,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { federationKeyFingerprint } from "./FederationIdentity.ts";

/**
 * Durable federation state: the peers this environment trusts, the runs it
 * started on peers, and the runs peers started here. Pinned public keys live
 * here in plain JSON on purpose: they are public, and pinning them is what
 * makes a peer's identity stable across relabels and transport changes.
 */
export const FEDERATION_STATE_FILE = "federation.json";

export const PersistedFederationPeer = Schema.Struct({
  peerId: EnvironmentId,
  label: TrimmedNonEmptyString,
  publicKey: TrimmedNonEmptyString,
  grantedScopes: FederationScopes,
  allowedScopes: FederationScopes,
  transport: Schema.NullOr(FederationTransport),
  remoteServerVersion: Schema.NullOr(TrimmedNonEmptyString),
  remoteProtocolVersion: Schema.NullOr(Schema.Int),
  remoteCapabilities: Schema.Array(FederationCapability),
  createdAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type PersistedFederationPeer = typeof PersistedFederationPeer.Type;

/** A run a peer started here; only that peer may observe it. */
export const PersistedInboundRun = Schema.Struct({
  threadId: ThreadId,
  peerId: EnvironmentId,
  createdAt: IsoDateTime,
});
export type PersistedInboundRun = typeof PersistedInboundRun.Type;

const PersistedFederationState = Schema.Struct({
  version: Schema.Literal(1),
  peers: Schema.Array(PersistedFederationPeer),
  remoteRuns: Schema.Array(FederationRemoteRun),
  inboundRuns: Schema.Array(PersistedInboundRun),
});
type PersistedFederationState = typeof PersistedFederationState.Type;

const PersistedFederationStateJson = Schema.fromJsonString(PersistedFederationState);
const decodeState = Schema.decodeUnknownEffect(PersistedFederationStateJson);
const encodeState = Schema.encodeEffect(PersistedFederationStateJson);

const EMPTY_STATE: PersistedFederationState = {
  version: 1,
  peers: [],
  remoteRuns: [],
  inboundRuns: [],
};

export interface PeerRuntimeStatus {
  readonly status: FederationPeerStatus;
  readonly lastError: string | null;
}

export class FederationPeerStoreError extends Schema.TaggedErrorClass<FederationPeerStoreError>()(
  "FederationPeerStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} federation state.`;
  }
}

export class FederationPeerStore extends Context.Service<
  FederationPeerStore,
  {
    readonly peers: Effect.Effect<ReadonlyArray<PersistedFederationPeer>>;
    readonly getPeer: (
      peerId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PersistedFederationPeer>>;
    readonly upsertPeer: (
      peer: PersistedFederationPeer,
    ) => Effect.Effect<void, FederationPeerStoreError>;
    readonly removePeer: (peerId: EnvironmentId) => Effect.Effect<void, FederationPeerStoreError>;
    readonly peerStatus: (peerId: EnvironmentId) => Effect.Effect<PeerRuntimeStatus>;
    readonly setPeerStatus: (
      peerId: EnvironmentId,
      status: PeerRuntimeStatus,
    ) => Effect.Effect<void>;
    readonly remoteRuns: Effect.Effect<ReadonlyArray<FederationRemoteRun>>;
    readonly upsertRemoteRun: (
      run: FederationRemoteRun,
    ) => Effect.Effect<void, FederationPeerStoreError>;
    readonly removeRemoteRunsForPeer: (
      peerId: EnvironmentId,
    ) => Effect.Effect<void, FederationPeerStoreError>;
    readonly inboundRuns: Effect.Effect<ReadonlyArray<PersistedInboundRun>>;
    readonly recordInboundRun: (
      run: PersistedInboundRun,
    ) => Effect.Effect<void, FederationPeerStoreError>;
    /** Present-tense view for clients, merging pinned facts with runtime status. */
    readonly presentPeer: (peer: PersistedFederationPeer) => Effect.Effect<FederationPeer>;
  }
>()("t3/federation/FederationPeerStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, FEDERATION_STATE_FILE);
  const lock = yield* Semaphore.make(1);

  const initial = yield* fileSystem.readFileString(statePath).pipe(
    Effect.option,
    Effect.flatMap((raw) =>
      Option.isNone(raw) || raw.value.trim().length === 0
        ? Effect.succeed(EMPTY_STATE)
        : decodeState(raw.value).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Federation state is unreadable; starting from defaults.", {
                statePath,
                cause,
              }).pipe(Effect.as(EMPTY_STATE)),
            ),
          ),
    ),
  );
  const state = yield* Ref.make<PersistedFederationState>(initial);
  const statuses = yield* Ref.make<ReadonlyMap<EnvironmentId, PeerRuntimeStatus>>(new Map());

  const update = (transform: (current: PersistedFederationState) => PersistedFederationState) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const next = transform(yield* Ref.get(state));
        const encoded = yield* encodeState(next).pipe(
          Effect.mapError((cause) => new FederationPeerStoreError({ operation: "write", cause })),
        );
        yield* writeFileStringAtomically({ filePath: statePath, contents: `${encoded}\n` }).pipe(
          Effect.mapError((cause) => new FederationPeerStoreError({ operation: "write", cause })),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        yield* Ref.set(state, next);
      }),
    );

  const peerStatus: FederationPeerStore["Service"]["peerStatus"] = (peerId) =>
    Ref.get(statuses).pipe(
      Effect.map((current) => current.get(peerId) ?? { status: "unknown", lastError: null }),
    );

  const presentPeer: FederationPeerStore["Service"]["presentPeer"] = (peer) =>
    peerStatus(peer.peerId).pipe(
      Effect.map((status): FederationPeer => ({
        peerId: peer.peerId,
        label: peer.label,
        publicKeyFingerprint: federationKeyFingerprint(peer.publicKey),
        grantedScopes: peer.grantedScopes,
        allowedScopes: peer.allowedScopes,
        transport: peer.transport,
        remoteServerVersion: peer.remoteServerVersion,
        remoteProtocolVersion: peer.remoteProtocolVersion,
        remoteCapabilities: peer.remoteCapabilities,
        status: status.status,
        lastSeenAt: peer.lastSeenAt,
        lastError: status.lastError,
        createdAt: peer.createdAt,
      })),
    );

  return FederationPeerStore.of({
    peers: Ref.get(state).pipe(Effect.map((current) => current.peers)),
    getPeer: (peerId) =>
      Ref.get(state).pipe(
        Effect.map((current) =>
          Option.fromUndefinedOr(current.peers.find((peer) => peer.peerId === peerId)),
        ),
      ),
    upsertPeer: (peer) =>
      update((current) => ({
        ...current,
        peers: [...current.peers.filter((existing) => existing.peerId !== peer.peerId), peer],
      })),
    removePeer: (peerId) =>
      update((current) => ({
        ...current,
        peers: current.peers.filter((peer) => peer.peerId !== peerId),
        remoteRuns: current.remoteRuns.filter((run) => run.peerId !== peerId),
        inboundRuns: current.inboundRuns.filter((run) => run.peerId !== peerId),
      })).pipe(
        Effect.andThen(
          Ref.update(statuses, (current) => {
            const next = new Map(current);
            next.delete(peerId);
            return next;
          }),
        ),
      ),
    peerStatus,
    setPeerStatus: (peerId, status) =>
      Ref.update(statuses, (current) => new Map(current).set(peerId, status)),
    remoteRuns: Ref.get(state).pipe(Effect.map((current) => current.remoteRuns)),
    upsertRemoteRun: (run) =>
      update((current) => ({
        ...current,
        remoteRuns: [
          ...current.remoteRuns.filter(
            (existing) =>
              !(existing.peerId === run.peerId && existing.run.threadId === run.run.threadId),
          ),
          run,
        ],
      })),
    removeRemoteRunsForPeer: (peerId) =>
      update((current) => ({
        ...current,
        remoteRuns: current.remoteRuns.filter((run) => run.peerId !== peerId),
      })),
    inboundRuns: Ref.get(state).pipe(Effect.map((current) => current.inboundRuns)),
    recordInboundRun: (run) =>
      update((current) => ({
        ...current,
        inboundRuns: [
          ...current.inboundRuns.filter((existing) => existing.threadId !== run.threadId),
          run,
        ],
      })),
    presentPeer,
  });
});

export const layer = Layer.effect(FederationPeerStore, make);
