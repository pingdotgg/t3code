import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- computes a replay key the way dpop.ts does.
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import { DPOP_REPLAY_MARKER_PREFIX, DpopReplayGuard, verifyRequestDpopProof } from "./dpop.ts";
import { makeDpopKey } from "./dpop.testkit.ts";

it.effect("checks replays in memory and records markers without waiting on them", () =>
  Effect.gen(function* () {
    const key = makeDpopKey();
    const earlierMarker = `${DPOP_REPLAY_MARKER_PREFIX}${NodeCrypto.createHash("sha256")
      .update(`${key.thumbprint}:proof-1`)
      .digest("base64url")}`;
    const markerWrite = yield* Deferred.make<void>();
    const markerWritten = yield* Deferred.make<void>();
    const created: Array<string> = [];
    const secretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) =>
        Deferred.await(markerWrite).pipe(
          Effect.andThen(Effect.sync(() => void created.push(name))),
          Effect.andThen(Deferred.succeed(markerWritten, undefined)),
        ),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.void,
      list: () => Effect.succeed([earlierMarker]),
    });
    const url = "http://127.0.0.1/api/voice/cloud/keys";
    const token = "access-token";
    const verify = (request: HttpServerRequest.HttpServerRequest) =>
      verifyRequestDpopProof({
        request,
        expectedThumbprint: key.thumbprint,
        expectedAccessToken: token,
      }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));
    const nextRequest = () =>
      HttpServerRequest.fromWeb(
        new Request(url, {
          headers: { host: "127.0.0.1", dpop: key.sign({ method: "GET", url, token, iat: 0 }) },
        }),
      );

    const usedByEarlierProcess = yield* Effect.flip(verify(nextRequest()));
    expect(usedByEarlierProcess).toMatchObject({ dpopFailureReason: "replay" });

    const fresh = nextRequest();
    yield* verify(fresh);
    const replayed = yield* Effect.flip(verify(fresh));
    expect(replayed).toMatchObject({ dpopFailureReason: "replay" });
    expect(created).toEqual([]);

    yield* Deferred.succeed(markerWrite, undefined);
    yield* Deferred.await(markerWritten);
    expect(created).toHaveLength(1);
  }).pipe(
    Effect.provideService(DpopReplayGuard, {
      consumed: new Map(),
      earlierMarkers: undefined,
      earlierMarkersUntil: 0,
      nextSweepAt: 0,
    }),
    Effect.provide(NodePlatformCrypto.layer),
  ),
);
