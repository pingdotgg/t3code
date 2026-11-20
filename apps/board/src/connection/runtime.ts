import { Connection } from "@t3tools/client-runtime/connection";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";
import * as Socket from "effect/socket/Socket";

import * as ConnectionPlatform from "./platform";

// T3 Connect is out of scope, but the connection layer is built with its relay client. The signer
// fails on use, and nothing registers a relay environment, so it is never asked.
const layerRelay = ManagedRelay.layer({
  relayUrl: "http://relay.invalid",
  clientId: RelayWebClientId,
}).pipe(
  Layer.provideMerge(
    DpopProof.layerSigner({
      keyStore: "indexed-db",
      loadOrCreateKey: Effect.fail("T3 Connect is not available in Agent Board."),
    }),
  ),
  Layer.provide(
    Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    ),
  ),
);

const layerRuntime = layerRelay.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
      Socket.layerWebSocketConstructorGlobal,
    ),
  ),
);

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

// Project commands mint their ids from it.
const layerConnection = layerSnapshotLoader.pipe(
  Layer.provideMerge(Connection.layer),
  Layer.provideMerge(Layer.mergeAll(layerRuntime, ConnectionPlatform.layer)),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof layerRuntime
  | typeof ConnectionPlatform.layer
  | typeof SecureRandom.layerWebCrypto;

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerConnection);
