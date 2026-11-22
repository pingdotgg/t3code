import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe, expect, it } from "vite-plus/test";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import { SecretStorePersistError } from "./ServerSecretStore.ts";
import { DpopReplayGuard, mapDpopReplayStoreError, verifyRequestDpopProof } from "./dpop.ts";
import { makeDpopKey } from "./dpop.testkit.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
      expect(error.dpopFailureReason).toBe("replay");
    }
  });
});

describe("verifyRequestDpopProof", () => {
  effectIt.effect("rejects a replay without waiting on the marker write", () =>
    Effect.gen(function* () {
      const markerWrite = yield* Deferred.make<void>();
      const markerWritten = yield* Deferred.make<void>();
      const created: Array<string> = [];
      const secretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: (name) =>
          created.length === 0
            ? Effect.sync(() => void created.push(name))
            : Deferred.await(markerWrite).pipe(
                Effect.andThen(Effect.sync(() => void created.push(name))),
                Effect.andThen(Deferred.succeed(markerWritten, undefined)),
              ),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: () => Effect.void,
      });
      const key = makeDpopKey();
      const url = "http://127.0.0.1/api/voice/cloud/keys";
      const token = "access-token";
      const requestAt = (iat: number) =>
        HttpServerRequest.fromWeb(
          new Request(url, {
            headers: { host: "127.0.0.1", dpop: key.sign({ method: "GET", url, token, iat }) },
          }),
        );
      const verify = (request: HttpServerRequest.HttpServerRequest) =>
        verifyRequestDpopProof({
          request,
          expectedThumbprint: key.thumbprint,
          expectedAccessToken: token,
        }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore));

      // An earlier process could have accepted this one, so it waits on its marker.
      yield* verify(requestAt(0));
      expect(created).toHaveLength(1);

      yield* TestClock.setTime(1_000_000);
      const later = requestAt(1_000);
      yield* verify(later);
      expect(created).toHaveLength(1);
      const replayed = yield* Effect.flip(verify(later));
      expect(replayed).toMatchObject({ dpopFailureReason: "replay" });

      yield* Deferred.succeed(markerWrite, undefined);
      yield* Deferred.await(markerWritten);
      expect(created).toHaveLength(2);
    }).pipe(
      Effect.provideService(DpopReplayGuard, {
        consumed: new Map(),
        diskCheckedThroughIat: undefined,
        nextSweepAt: 0,
      }),
      Effect.provide(NodeCrypto.layer),
    ),
  );
});
