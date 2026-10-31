import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";

const layer = (http: HttpClient.HttpClient) =>
  DictationArtifacts.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dictation-artifacts-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("removing a model reclaims installed files and abandoned staging", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const destination = service.paths("whisper-turbo").model;
    for (const directory of [destination, `${destination}.tmp`]) {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${directory}/partial`, "model bytes");
    }
    yield* service.remove("whisper-turbo");
    assert.strictEqual(yield* fs.exists(destination), false);
    assert.strictEqual(yield* fs.exists(`${destination}.tmp`), false);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.never))), Effect.scoped),
);

it.effect("recovers abandoned staging and cleans an integrity failure", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const staging = `${service.paths("parakeet-v3").runtime}.tmp`;
    yield* fs.makeDirectory(staging, { recursive: true });
    yield* fs.writeFileString(`${staging}/abandoned`, "partial download");
    const error = yield* service.install("parakeet-v3", () => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    assert.strictEqual(error.message, "The dictation download failed integrity verification.");
    assert.strictEqual(yield* fs.exists(staging), false);
    assert.strictEqual((yield* service.inspect).runtime._tag, "not-installed");
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("corrupt"))),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("cancels a pending download and removes its staging files", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* DictationArtifacts.DictationArtifacts;
      const fs = yield* FileSystem.FileSystem;
      const staging = `${service.paths("parakeet-v3").runtime}.tmp`;
      const downloading = yield* service
        .install("parakeet-v3", () => Effect.void)
        .pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(downloading);
      assert.strictEqual(yield* fs.exists(staging), false);
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);
