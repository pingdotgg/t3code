import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpServerRequest } from "effect/http";

import { checkRequestDpopProof } from "./dpop.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("Not used by this check."),
  remove: () => Effect.void,
});

const outbound = (proto: string | undefined) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3773/ws", {
      headers: {
        host: "t3.example.com",
        ...(proto === undefined ? {} : { "x-forwarded-proto": proto }),
      },
    }),
  );

// A TLS-terminating proxy sends `wss` on the upgrade, while the client signs its `htu`
// for https. Reading `wss` as plain http rejected every proxied socket with url_mismatch.
it.live.each(["https", "wss"])("accepts a proof signed for the proxied %s scheme", (proto) =>
  Effect.gen(function* () {
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const result = yield* checkRequestDpopProof({
      request: outbound(proto),
      proof: key.sign({ method: "GET", url: "https://t3.example.com/ws", token: "", iat }),
      expectedThumbprint: key.thumbprint,
    }).pipe(
      Effect.as("accepted" as const),
      Effect.orElseSucceed(() => "refused" as const),
      Effect.provideService(SecureRandom.SecureRandom, yield* SecureRandom.SecureRandom),
      Effect.provideService(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    expect(result).toBe("accepted");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("still refuses a proof signed for a scheme the proxy did not forward", () =>
  Effect.gen(function* () {
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const result = yield* checkRequestDpopProof({
      request: outbound("http"),
      proof: key.sign({ method: "GET", url: "https://t3.example.com/ws", token: "", iat }),
      expectedThumbprint: key.thumbprint,
    }).pipe(
      Effect.as("accepted" as const),
      Effect.orElseSucceed(() => "refused" as const),
      Effect.provideService(SecureRandom.SecureRandom, yield* SecureRandom.SecureRandom),
      Effect.provideService(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    expect(result).toBe("refused");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
