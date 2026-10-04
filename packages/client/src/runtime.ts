import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";

const webCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

/** Services `pair` and `connect` need, from Node 22+ globals (fetch, WebSocket, Web Crypto). */
export const nodeRuntimeLayer = Layer.mergeAll(
  remoteHttpClientLayer(fetch),
  Socket.layerWebSocketConstructorGlobal,
  webCryptoLayer,
);
