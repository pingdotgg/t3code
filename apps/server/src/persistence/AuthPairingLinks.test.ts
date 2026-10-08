import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthPairingLinks from "./AuthPairingLinks.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = AuthPairingLinks.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-10-07T12:00:00.000Z");
const pairingLink = {
  id: "test-pairing-link",
  credential: "test-pairing-credential",
  method: "one-time-token",
  scopes: ["orchestration:read"],
  subject: "test-client",
  label: null,
  proofKeyThumbprint: null,
  createdAt: DateTime.makeUnsafe("2026-10-07T11:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-10-07T13:00:00.000Z"),
} satisfies AuthPairingLinks.CreateAuthPairingLinkInput;
const consumeInput = {
  credential: pairingLink.credential,
  proofKeyThumbprint: null,
  consumedAt: now,
  now,
};

describe("AuthPairingLinkRepository.consumeAvailable", () => {
  it.effect("consumes once when requested scopes are omitted", () =>
    Effect.gen(function* () {
      const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
      yield* repository.create(pairingLink);

      const consumed = yield* repository.consumeAvailable(consumeInput);
      assert.ok(Option.isSome(consumed));
      assert.equal(consumed.value.id, pairingLink.id);
      assert.deepStrictEqual(consumed.value.consumedAt, now);
      assert.ok(Option.isNone(yield* repository.consumeAvailable(consumeInput)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a scope mismatch available and consumes matching scopes once", () =>
    Effect.gen(function* () {
      const repository = yield* AuthPairingLinks.AuthPairingLinkRepository;
      yield* repository.create(pairingLink);

      const mismatch = yield* repository.consumeAvailable({
        ...consumeInput,
        requestedScopes: ["access:write"],
      });
      assert.ok(Option.isNone(mismatch));
      const available = yield* repository.getByCredential({ credential: pairingLink.credential });
      assert.ok(Option.isSome(available));
      assert.equal(available.value.consumedAt, null);

      const matchingInput = {
        ...consumeInput,
        requestedScopes: pairingLink.scopes,
      };
      const consumed = yield* repository.consumeAvailable(matchingInput);
      assert.ok(Option.isSome(consumed));
      assert.equal(consumed.value.id, pairingLink.id);
      assert.deepStrictEqual(consumed.value.consumedAt, now);
      assert.ok(Option.isNone(yield* repository.consumeAvailable(matchingInput)));
    }).pipe(Effect.provide(layer)),
  );
});
