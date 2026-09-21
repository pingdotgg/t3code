import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { makeProviderCredentialStore } from "./ProviderCredentialStore.ts";

it.effect("isolates provider bindings and preserves opaque credentials", () =>
  Effect.gen(function* () {
    const data = new Map<string, Uint8Array>();
    const secretStore = ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(data.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          data.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          data.delete(name);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const a = yield* makeProviderCredentialStore("cursor", "../../personal").pipe(
      Effect.provideService(ServerSecretStore, secretStore),
    );
    const b = yield* makeProviderCredentialStore("cursor", "work").pipe(
      Effect.provideService(ServerSecretStore, secretStore),
    );
    const c = yield* makeProviderCredentialStore("other", "../../personal").pipe(
      Effect.provideService(ServerSecretStore, secretStore),
    );
    const bytes = Uint8Array.from([0, 255, 128, 1]);
    yield* a.set(bytes);
    assert.deepStrictEqual(Option.getOrThrow(yield* a.get), bytes);
    assert.isTrue(Option.isNone(yield* b.get));
    assert.isTrue(Option.isNone(yield* c.get));
    assert.isFalse(a.binding.key.includes("/"));
    yield* a.remove;
    assert.isTrue(Option.isNone(yield* a.get));
  }),
);
