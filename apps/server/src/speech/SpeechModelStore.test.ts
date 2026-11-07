import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const bytes = Uint8Array.from({ length: 64 }, (_, index) => (index * 7) % 256);
const SPLIT = 20;

const harness = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const model = {
    id: "fixture/speech-model",
    revision: "a".repeat(40),
    filename: "model.gguf",
    size: bytes.length,
    sha256: Hex.encode(yield* digest.digest(Digest.sha256, bytes).pipe(Effect.orDie)),
  };
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(config.stateDir, "speech", "models");
  const stale = path.join(directory, model.filename);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFile(stale, new Uint8Array(bytes.length));
  const bodyStarted = yield* Deferred.make<void>();
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Error("reset") }),
    });
  const bodies = {
    current: (
      request: HttpClientRequest.HttpClientRequest,
    ): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
      Stream.fail(transportFailure(request)),
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      const body = bodies.current(request);
      const resumed = request.headers["range"] === `bytes=${SPLIT}-`;
      return Object.defineProperty(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: resumed ? 206 : 200,
            headers: resumed
              ? {
                  "content-range": `bytes ${SPLIT}-${bytes.length - 1}/${bytes.length}`,
                  "content-length": String(bytes.length - SPLIT),
                }
              : { "content-length": String(bytes.length) },
          }),
        ),
        "stream",
        {
          value: Stream.concat(
            Stream.fromEffect(Deferred.succeed(bodyStarted, undefined)).pipe(Stream.drain),
            body,
          ),
        },
      );
    }),
  );
  const openStore = SpeechModelStore.SpeechModelStore.pipe(
    Effect.provide(
      SpeechModelStore.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ),
  );
  const store = yield* openStore;
  return {
    model,
    directory,
    stale,
    fs,
    requests,
    bodies,
    transportFailure,
    bodyStarted,
    store,
    openStore,
  };
});

const dependencies = ServerConfig.layerTest("/tmp", { prefix: "speech-model-store-" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("resumes an interrupted transfer, replaces a corrupt same-size file, and marks it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.bodies.current = (request) =>
      request.headers["range"]
        ? Stream.succeed(bytes.subarray(SPLIT))
        : Stream.concat(
            Stream.succeed(bytes.subarray(0, SPLIT)),
            Stream.fail(h.transportFailure(request)),
          );
    expect(yield* h.store.isReady(h.model)).toBe(true);
    expect(yield* h.store.installedPath(h.model)).toBeUndefined();
    expect(yield* h.store.isReady(h.model)).toBe(false);
    expect(yield* h.store.hasOwnedFile(h.model)).toBe(true);

    const progress: number[] = [];
    const installed = yield* h.store.download(h.model, {
      onProgress: (downloaded) => progress.push(downloaded),
    });
    expect(installed).toBe(h.stale);
    expect(h.requests.map((request) => request.headers["range"])).toEqual([
      undefined,
      `bytes=${SPLIT}-`,
    ]);
    const pinnedUrl = `https://huggingface.co/${h.model.id}/resolve/${h.model.revision}/${h.model.filename}`;
    expect(h.requests.map((request) => request.url)).toEqual([pinnedUrl, pinnedUrl]);
    expect(progress.at(0)).toBe(0);
    expect(progress.at(-1)).toBe(bytes.length);
    expect([...(yield* h.fs.readFile(installed))]).toEqual([...bytes]);
    expect((yield* h.fs.readDirectory(h.directory)).sort()).toEqual([
      "model.gguf",
      "model.gguf.verified",
    ]);
    expect(yield* h.store.isReady(h.model)).toBe(true);
    expect(yield* h.store.installedPath(h.model)).toBe(installed);
    const requestsBeforeReuse = h.requests.length;
    expect(yield* h.store.download(h.model)).toBe(installed);
    expect(h.requests).toHaveLength(requestsBeforeReuse);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("rejects a same-size download whose SHA-256 differs from the catalog", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.bodies.current = () => Stream.succeed(new Uint8Array(bytes.length));
    const result = yield* Effect.result(h.store.download(h.model));
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "verification" } });
    expect(yield* h.fs.readDirectory(h.directory)).toEqual(["model.gguf"]);
    expect(yield* h.store.installedPath(h.model)).toBeUndefined();
  }).pipe(Effect.provide(dependencies)),
);

it.effect("cleans only download partials on cancellation or restart", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.bodies.current = () => Stream.concat(Stream.succeed(bytes.subarray(0, SPLIT)), Stream.never);
    const fiber = yield* h.store.download(h.model).pipe(Effect.forkChild);
    yield* Deferred.await(h.bodyStarted);
    yield* Fiber.interrupt(fiber);
    expect(yield* h.fs.readDirectory(h.directory)).toEqual(["model.gguf"]);
    expect([...(yield* h.fs.readFile(h.stale))]).toEqual([...new Uint8Array(bytes.length)]);
    const orphan = `${h.stale}.f660de6c-e172-4146-8ffe-d3c32eb48cd4.part`;
    yield* h.fs.writeFile(orphan, bytes.subarray(0, SPLIT));
    yield* h.fs.writeFileString(`${h.stale}.notes.part`, "not a download");
    yield* h.openStore;
    expect((yield* h.fs.readDirectory(h.directory)).sort()).toEqual([
      "model.gguf",
      "model.gguf.notes.part",
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("reuses verified external models without writing to or removing their folder", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const path = yield* Path.Path;
    const external = path.join(h.directory, "external");
    const file = path.join(external, h.model.filename);
    yield* h.fs.makeDirectory(external);
    yield* h.fs.writeFile(file, bytes);
    yield* h.fs.remove(h.stale);
    const invalid = path.join(h.directory, "invalid");
    yield* h.fs.makeDirectory(invalid);
    yield* h.fs.writeFile(path.join(invalid, h.model.filename), new Uint8Array(bytes.length));
    expect(yield* h.store.installedPath(h.model, [invalid, external])).toBe(file);
    yield* h.fs.writeFile(h.stale, bytes);
    expect(yield* h.store.installedPath(h.model, [external])).toBe(h.stale);
    yield* h.fs.remove(h.stale);
    expect(yield* h.store.isReady(h.model, [external])).toBe(true);
    expect(yield* h.store.installedPath(h.model, [external])).toBe(file);
    expect(yield* h.store.download(h.model, {}, [external])).toBe(file);
    expect(h.requests).toHaveLength(0);
    yield* h.store.remove(h.model);
    expect(yield* h.fs.readDirectory(external)).toEqual([h.model.filename]);
    expect(yield* h.store.isReady(h.model)).toBe(false);
    yield* h.fs.writeFile(file, new Uint8Array(bytes.length));
    expect(yield* h.store.installedPath(h.model, [external])).toBeUndefined();
    expect(yield* h.store.isReady(h.model, [external])).toBe(false);
  }).pipe(Effect.provide(dependencies)),
);
