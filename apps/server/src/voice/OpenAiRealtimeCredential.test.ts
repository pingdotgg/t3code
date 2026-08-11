import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OpenAiRealtimeCredential from "./OpenAiRealtimeCredential.ts";

function makeCredentialLayer(input?: {
  readonly environmentApiKey?: string;
  readonly storedApiKey?: string;
}) {
  let stored = Option.fromUndefinedOr(
    input?.storedApiKey === undefined ? undefined : new TextEncoder().encode(input.storedApiKey),
  );
  const calls: Array<{ readonly operation: "get" | "set" | "remove"; readonly name: string }> = [];
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        calls.push({ operation: "get", name });
        return stored;
      }),
    set: (name, value) =>
      Effect.sync(() => {
        calls.push({ operation: "set", name });
        stored = Option.some(Uint8Array.from(value));
      }),
    create: () => Effect.die(new Error("unused")),
    getOrCreateRandom: () => Effect.die(new Error("unused")),
    remove: (name) =>
      Effect.sync(() => {
        calls.push({ operation: "remove", name });
        stored = Option.none();
      }),
  });
  const env =
    input?.environmentApiKey === undefined ? {} : { OPENAI_API_KEY: input.environmentApiKey };
  const layer = OpenAiRealtimeCredential.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { calls, layer };
}

it.effect("uses the fixed stored credential before the OPENAI_API_KEY fallback", () => {
  const { calls, layer } = makeCredentialLayer({
    storedApiKey: "stored-key",
    environmentApiKey: "environment-key",
  });

  return Effect.gen(function* () {
    const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
    const resolved = Option.getOrThrow(yield* credential.resolve);

    assert.strictEqual(resolved.source, "stored");
    assert.strictEqual(Redacted.value(resolved.apiKey), "stored-key");
    assert.deepStrictEqual(calls, [
      {
        operation: "get",
        name: OpenAiRealtimeCredential.OPENAI_REALTIME_API_KEY_SECRET,
      },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("falls back to OPENAI_API_KEY without exposing it in credential status", () => {
  const { layer } = makeCredentialLayer({ environmentApiKey: " environment-key " });

  return Effect.gen(function* () {
    const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;

    assert.deepStrictEqual(yield* credential.status, {
      configured: true,
      source: "environment",
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "sets and removes only the fixed secret key, then reveals the environment fallback",
  () => {
    const { calls, layer } = makeCredentialLayer({ environmentApiKey: "environment-key" });

    return Effect.gen(function* () {
      const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
      yield* credential.set(Redacted.make(" stored-key "));
      assert.deepStrictEqual(yield* credential.status, { configured: true, source: "stored" });

      yield* credential.remove;
      assert.deepStrictEqual(yield* credential.status, {
        configured: true,
        source: "environment",
      });
      assert.deepStrictEqual(
        calls.filter((call) => call.operation !== "get"),
        [
          {
            operation: "set",
            name: OpenAiRealtimeCredential.OPENAI_REALTIME_API_KEY_SECRET,
          },
          {
            operation: "remove",
            name: OpenAiRealtimeCredential.OPENAI_REALTIME_API_KEY_SECRET,
          },
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects corrupt stored credentials without echoing their contents", () => {
  const corrupt = `secret-that-must-not-appear-${"x".repeat(4_097)}`;
  const { layer } = makeCredentialLayer({ storedApiKey: corrupt });

  return Effect.gen(function* () {
    const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
    const error = yield* Effect.flip(credential.resolve);

    assert.strictEqual(error.reason, "invalid_stored_value");
    assert.notInclude(String(error), "secret-that-must-not-appear");
  }).pipe(Effect.provide(layer));
});

it.effect("persists the credential through the real fixed-key secret store", () => {
  const storeLayer = ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-secret-test-" })),
  );
  const layer = Layer.merge(
    OpenAiRealtimeCredential.layer.pipe(Layer.provide(storeLayer)),
    storeLayer,
  ).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
    const store = yield* ServerSecretStore.ServerSecretStore;
    yield* credential.set(Redacted.make("real-stored-key"));

    const persisted = Option.getOrThrow(
      yield* store.get(OpenAiRealtimeCredential.OPENAI_REALTIME_API_KEY_SECRET),
    );
    assert.strictEqual(new TextDecoder().decode(persisted), "real-stored-key");
  }).pipe(Effect.provide(layer));
});
