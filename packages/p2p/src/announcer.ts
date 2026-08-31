/// <reference path="./holepunch.d.ts" />
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import DHT, { type NoiseSecretStream } from "hyperdht";
import * as NodeNet from "node:net";

import { P2pAnnounceError } from "./errors.ts";
import { encodeP2pPublicKey, P2P_SEED_BYTES } from "./keys.ts";
import { relayStreams } from "./relay.ts";

export interface AnnounceP2pEndpointOptions {
  /** 32-byte secret seed; the announced public key is derived from it. */
  readonly seed: Uint8Array;
  /** Local TCP port each accepted Noise stream is piped to. */
  readonly targetPort: number;
  readonly targetHost?: string;
  /** DHT bootstrap nodes as host:port entries; defaults to the public DHT. */
  readonly bootstrap?: ReadonlyArray<string>;
  /**
   * Overrides hyperdht's adaptive firewall detection. Only meaningful on a
   * loopback testnet, where detection would demand a hole punch that bogon
   * filtering aborts; leave unset in production.
   */
  readonly firewalled?: boolean;
  /** Observes each accepted connection by the dialer's public key. */
  readonly onConnection?: (remotePublicKeyZ32: string) => void;
}

export interface P2pEndpointAnnouncer {
  /** The dialable z-base-32 address of this endpoint. */
  readonly publicKeyZ32: string;
}

/** The z-base-32 address a seed announces under, without announcing. */
export function deriveP2pPublicKeyZ32(seed: Uint8Array): string {
  return encodeP2pPublicKey(DHT.keyPair(Buffer.from(seed)).publicKey);
}

interface AnnouncerHandle extends P2pEndpointAnnouncer {
  readonly close: () => Promise<void>;
}

/**
 * Announces this environment on the DHT and relays every accepted Noise
 * stream to the local HTTP server, so remote peers reach the ordinary
 * `/ws` + HTTP surface with all authentication intact. Announcing lasts for
 * the lifetime of the surrounding scope.
 */
export const announceP2pEndpoint = (
  options: AnnounceP2pEndpointOptions,
): Effect.Effect<P2pEndpointAnnouncer, P2pAnnounceError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startAnnouncer(options),
      catch: (cause) =>
        new P2pAnnounceError({
          detail: "Failed to announce the P2P endpoint on the DHT.",
          cause,
        }),
    }),
    (handle) => Effect.promise(() => handle.close()),
  ).pipe(Effect.map(({ publicKeyZ32 }) => ({ publicKeyZ32 })));

async function startAnnouncer(options: AnnounceP2pEndpointOptions): Promise<AnnouncerHandle> {
  if (options.seed.length !== P2P_SEED_BYTES) {
    throw new Error(
      `P2P endpoint seed must be ${P2P_SEED_BYTES} bytes, got ${options.seed.length}.`,
    );
  }
  const keyPair = DHT.keyPair(Buffer.from(options.seed));
  const targetHost = options.targetHost ?? "127.0.0.1";
  const dht = new DHT({
    ...(options.bootstrap && options.bootstrap.length > 0
      ? { bootstrap: [...options.bootstrap] }
      : {}),
    ...(options.firewalled === undefined ? {} : { firewalled: options.firewalled }),
  });
  const openStreams = new Set<NoiseSecretStream>();
  const server = dht.createServer(undefined, (socket) => {
    openStreams.add(socket);
    socket.on("close", () => openStreams.delete(socket));
    options.onConnection?.(encodeP2pPublicKey(socket.remotePublicKey));
    relayStreams(socket, NodeNet.connect(options.targetPort, targetHost));
  });
  try {
    await server.listen(keyPair);
  } catch (error) {
    await dht.destroy().catch(() => undefined);
    throw error;
  }
  const close = async () => {
    for (const stream of openStreams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
    await server.close().catch(() => undefined);
    await dht.destroy().catch(() => undefined);
  };
  return { publicKeyZ32: encodeP2pPublicKey(keyPair.publicKey), close };
}
