import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import { Deferred, Effect } from "effect";

import { loadAuthAccessSnapshot } from "./authAccessSnapshot.ts";

it.effect("loads pairing links and client sessions concurrently", () =>
  Effect.gen(function* () {
    const pairingLinksStarted = yield* Deferred.make<void>();
    const clientSessionsStarted = yield* Deferred.make<void>();

    const snapshot = yield* loadAuthAccessSnapshot(
      {
        listPairingLinks: () =>
          Deferred.succeed(pairingLinksStarted, undefined).pipe(
            Effect.andThen(Deferred.await(clientSessionsStarted)),
            Effect.as([]),
          ),
        listClientSessions: () =>
          Deferred.succeed(clientSessionsStarted, undefined).pipe(
            Effect.andThen(Deferred.await(pairingLinksStarted)),
            Effect.as([]),
          ),
      },
      AuthSessionId.make("current-session"),
    ).pipe(Effect.timeout("1 second"));

    assert.deepStrictEqual(snapshot, {
      pairingLinks: [],
      clientSessions: [],
    });
  }),
);
