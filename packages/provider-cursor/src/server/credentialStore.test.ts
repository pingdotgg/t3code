import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as Layer from "effect/Layer";
import { makeCursorCredentialStore } from "./credentialStore.ts";

const layerHost = Layer.provideMerge(layerTestProviderHost(), NodeServices.layer);

const legacyCredentials = {
  version: 1 as const,
  backendUrl: "https://api.cursor.com",
  apiKey: "test-only-legacy-key",
  createdAtMs: 100,
};
// The SDK's FileCredentialStore writes pretty-printed JSON.
const legacyFileText = `{
  "version": 1,
  "backendUrl": "https://api.cursor.com",
  "apiKey": "test-only-legacy-key",
  "createdAtMs": 100
}`;

it.effect.each([
  {
    name: "imports a legacy sign-in",
    legacy: legacyFileText,
    stored: undefined,
    expected: "test-only-legacy-key",
  },
  {
    name: "keeps a newer stored sign-in",
    legacy: legacyFileText,
    stored: legacyFileText.replace("test-only-legacy-key", "test-only-current-key"),
    expected: "test-only-current-key",
  },
  {
    name: "replaces a damaged stored sign-in",
    legacy: legacyFileText,
    stored: "damaged",
    expected: "test-only-legacy-key",
  },
  {
    name: "discards a damaged legacy file",
    legacy: "damaged",
    stored: undefined,
    expected: undefined,
  },
])("$name and deletes the legacy file", ({ legacy, stored, expected }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacyFile = path.join(yield* fileSystem.makeTempDirectoryScoped(), "cursor.json");
    yield* fileSystem.writeFileString(legacyFile, legacy);
    const host = yield* ProviderHost.ProviderHost;
    const instanceId = ProviderInstanceId.make("personal");
    if (stored !== undefined) {
      yield* (yield* host.credentials("cursor", instanceId)).set(new TextEncoder().encode(stored));
    }
    const migrated = yield* makeCursorCredentialStore(instanceId, legacyFile);
    assert.strictEqual((yield* Effect.tryPromise(() => migrated.store.load()))?.apiKey, expected);
    assert.isFalse(yield* fileSystem.exists(legacyFile));
  }).pipe(Effect.scoped, Effect.provide(layerHost)),
);

it.effect(
  "restores SDK credentials in a new controller and keeps another account when signing out",
  () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const makeStore = (id: string) => makeCursorCredentialStore(ProviderInstanceId.make(id));
      const personal = yield* makeStore("personal");
      const work = yield* makeStore("work");
      const credentials = {
        version: 1 as const,
        backendUrl: "https://api.cursor.com",
        apiKey: "test-only-key",
        createdAtMs: 100,
        apiKeyExpiresAtMs: 1000,
        email: "test@example.com",
      };
      yield* Effect.tryPromise(() => personal.store.save(credentials));
      yield* Effect.tryPromise(() =>
        work.store.save({ ...credentials, apiKey: "test-only-work-key" }),
      );
      const restored = yield* makeStore("personal");
      assert.deepEqual(yield* Effect.tryPromise(() => restored.store.load()), credentials);
      yield* (yield* host.credentials("cursor", "personal")).set(
        new TextEncoder().encode("damaged credential"),
      );
      assert.isUndefined(yield* Effect.tryPromise(() => restored.store.load()));
      yield* Effect.tryPromise(() => restored.store.save(credentials));
      yield* Effect.tryPromise(() => restored.store.clear());
      assert.isUndefined(yield* Effect.tryPromise(() => personal.store.load()));
      assert.strictEqual(
        (yield* Effect.tryPromise(() => work.store.load()))?.apiKey,
        "test-only-work-key",
      );
    }).pipe(Effect.provide(layerHost)),
);
