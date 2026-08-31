/// <reference path="./holepunch.d.ts" />
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import DHT, { type NoiseSecretStream } from "hyperdht";
import * as NodeNet from "node:net";

import { P2pDialError, P2pKeyDecodeError } from "./errors.ts";
import { decodeP2pPublicKey } from "./keys.ts";
import { relayStreams } from "./relay.ts";

export interface CreateP2pTunnelOptions {
  /** The remote endpoint's z-base-32 public key address. */
  readonly publicKeyZ32: string;
  /** DHT bootstrap nodes as host:port entries; defaults to the public DHT. */
  readonly bootstrap?: ReadonlyArray<string>;
}

export interface P2pTunnel {
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

interface TunnelHandle extends P2pTunnel {
  readonly close: () => Promise<void>;
}

/**
 * Opens a loopback TCP listener whose every connection is dialed through the
 * DHT to the remote endpoint's public key, yielding ordinary local HTTP/WS
 * base URLs the normal client connection stack consumes unchanged (the same
 * shape the SSH tunnel resolves to). Lives for the surrounding scope.
 */
export const createP2pTunnel = (
  options: CreateP2pTunnelOptions,
): Effect.Effect<P2pTunnel, P2pDialError | P2pKeyDecodeError, Scope.Scope> =>
  Effect.gen(function* () {
    const publicKey = decodeP2pPublicKey(options.publicKeyZ32);
    if (publicKey === null) {
      return yield* new P2pKeyDecodeError({
        detail: "The P2P endpoint address is not a valid public key.",
      });
    }
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startTunnel(publicKey, options.bootstrap),
        catch: (cause) =>
          new P2pDialError({
            detail: "Failed to open the local P2P tunnel listener.",
            cause,
          }),
      }),
      (tunnel) => Effect.promise(() => tunnel.close()),
    );
    return {
      localPort: handle.localPort,
      httpBaseUrl: handle.httpBaseUrl,
      wsBaseUrl: handle.wsBaseUrl,
    };
  });

async function startTunnel(
  publicKey: Uint8Array,
  bootstrap: ReadonlyArray<string> | undefined,
): Promise<TunnelHandle> {
  const dht = new DHT({
    ...(bootstrap && bootstrap.length > 0 ? { bootstrap: [...bootstrap] } : {}),
    ephemeral: true,
  });
  const remoteKey = Buffer.from(publicKey);
  const openStreams = new Set<NoiseSecretStream>();
  const server = NodeNet.createServer((local) => {
    const remote = dht.connect(remoteKey);
    openStreams.add(remote);
    remote.on("close", () => openStreams.delete(remote));
    relayStreams(local, remote);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await dht.destroy().catch(() => undefined);
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    await dht.destroy().catch(() => undefined);
    throw new Error("Failed to read the local P2P tunnel address.");
  }
  const localPort = address.port;
  const close = async () => {
    for (const stream of openStreams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await dht.destroy().catch(() => undefined);
  };
  return {
    localPort,
    httpBaseUrl: `http://127.0.0.1:${localPort}`,
    wsBaseUrl: `ws://127.0.0.1:${localPort}`,
    close,
  };
}
