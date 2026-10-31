import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import {
  DictationError,
  type DictationInstallState,
  type DictationModelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import { models, runtimeFor } from "./models.ts";
import { createIntegrityHash } from "./integrity.ts";
import { readTar } from "./tar.ts";

export class DictationArtifacts extends Context.Service<
  DictationArtifacts,
  {
    readonly supported: boolean;
    readonly paths: (model: DictationModelId) => { runtime: string; model: string };
    readonly inspect: Effect.Effect<
      {
        runtime: DictationInstallState;
        models: ReadonlyMap<DictationModelId, DictationInstallState>;
      },
      DictationError
    >;
    readonly install: (
      model: DictationModelId,
      progress: (
        artifact: "runtime" | DictationModelId,
        state: DictationInstallState,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    readonly remove: (model: DictationModelId) => Effect.Effect<void, DictationError>;
  }
>()("t3/dictation/DictationArtifacts") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const mutations = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "dictation");
  const runtime = runtimeFor(yield* HostProcess.Platform, yield* HostProcess.Architecture);
  const paths = (model: DictationModelId) => ({
    runtime: path.join(root, "runtime", runtime?.directory ?? "unsupported"),
    model: path.join(root, "models", model),
  });
  const io = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: "Could not access dictation files.",
            cause,
          }),
      ),
    );
  const size = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      io,
    );
  const inspect = Effect.gen(function* () {
    let runtimeComplete = runtime !== null;
    let runtimeSize = 0;
    for (const name of runtime?.nativeFiles ?? []) {
      const actual = yield* size(path.join(paths("parakeet-v3").runtime, name));
      runtimeComplete &&= actual !== null && actual > 0;
      runtimeSize += actual ?? 0;
    }
    const installed = new Map<DictationModelId, DictationInstallState>();
    for (const id of Object.keys(models) as DictationModelId[]) {
      let complete = true;
      let bytes = 0;
      for (const file of models[id].files) {
        const actual = yield* size(path.join(paths(id).model, file.name));
        complete &&= actual === file.bytes;
        bytes += actual ?? 0;
      }
      installed.set(
        id,
        complete ? { _tag: "installed", sizeBytes: bytes } : { _tag: "not-installed" },
      );
    }
    return {
      runtime: !runtimeComplete
        ? { _tag: "not-installed" as const }
        : { _tag: "installed" as const, sizeBytes: runtimeSize },
      models: installed,
    };
  });

  // Downloads stream to temporary files. The AbortSignal and finalizer own partial-file cleanup.
  const download = Effect.fnUntraced(function* (
    url: string,
    destination: string,
    algorithm: "sha256" | "sha512",
    expected: string,
    maxBytes: number,
    progress: (received: number, total: number) => Effect.Effect<void>,
  ) {
    const response = yield* http.get(url).pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: "Could not download dictation files.",
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new DictationError({
              reason: "install-failed",
              message: "The dictation download timed out.",
            }),
          ),
      }),
    );
    if (response.status !== 200)
      return yield* new DictationError({
        reason: "install-failed",
        message: "The dictation download was unavailable.",
      });
    const total = Number(response.headers["content-length"]) || maxBytes;
    const file = yield* io(fs.open(destination, { flag: "wx" }));
    const hash = createIntegrityHash(algorithm);
    let received = 0;
    yield* response.stream.pipe(
      Stream.timeout("30 seconds"),
      Stream.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: "The dictation download was interrupted.",
            cause,
          }),
      ),
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          received += bytes.length;
          if (received > maxBytes)
            return yield* new DictationError({
              reason: "install-failed",
              message: "The dictation download exceeded its expected size.",
            });
          hash.update(bytes);
          yield* io(file.writeAll(bytes));
          yield* progress(received, total);
        }),
      ),
    );
    if (hash.digest(algorithm === "sha512" ? "base64" : "hex") !== expected)
      return yield* new DictationError({
        reason: "install-failed",
        message: "The dictation download failed integrity verification.",
      });
    return received;
  }, Effect.scoped);

  const atomicInstall = Effect.fnUntraced(function* (
    destination: string,
    write: (temporary: string) => Effect.Effect<void, DictationError, Scope.Scope>,
  ) {
    const temporary = `${destination}.tmp`;
    yield* io(fs.makeDirectory(path.dirname(destination), { recursive: true }));
    // A previous process may have exited before its staging finalizer ran.
    yield* io(fs.remove(temporary, { recursive: true, force: true }));
    yield* Effect.acquireRelease(io(fs.makeDirectory(temporary)), () =>
      fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    yield* write(temporary);
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.rename(temporary, destination));
  });

  const install: DictationArtifacts["Service"]["install"] = Effect.fnUntraced(
    function* (model, progress) {
      if (!runtime)
        return yield* new DictationError({
          reason: "unsupported-platform",
          message: "Local dictation is unavailable on this platform.",
        });
      let lastProgress = -Infinity;
      const report: typeof progress = Effect.fn("DictationArtifacts.reportProgress")(
        function* (artifact, state) {
          const now = yield* Clock.currentTimeMillis;
          if (now - lastProgress >= 250) {
            yield* progress(artifact, state);
            lastProgress = now;
          }
        },
      );
      const current = yield* inspect;
      if (current.runtime._tag !== "installed") {
        yield* progress("runtime", { _tag: "installing", receivedBytes: 0, totalBytes: 0 });
        yield* atomicInstall(paths(model).runtime, (temporary) =>
          Effect.gen(function* () {
            const archive = path.join(temporary, "runtime.tgz");
            yield* download(
              runtime.url,
              archive,
              "sha512",
              runtime.integrity,
              128 * 1024 * 1024,
              (receivedBytes, totalBytes) =>
                report("runtime", { _tag: "installing", receivedBytes, totalBytes }),
            );
            const compressed = yield* io(fs.readFile(archive));
            const expanded = yield* Effect.tryPromise({
              try: () =>
                NodeUtil.promisify(NodeZlib.gunzip)(compressed, {
                  maxOutputLength: 512 * 1024 * 1024,
                }),
              catch: (cause) =>
                new DictationError({
                  reason: "install-failed",
                  message: "The dictation runtime archive was invalid.",
                  cause,
                }),
            });
            const files = yield* Effect.try({
              try: () => readTar(expanded),
              catch: (cause) =>
                new DictationError({
                  reason: "install-failed",
                  message: "The dictation runtime archive was invalid.",
                  cause,
                }),
            });
            if (
              !runtime.nativeFiles.every((name) =>
                files.some((file) => file.path === name && file.bytes.length > 0),
              )
            )
              return yield* new DictationError({
                reason: "install-failed",
                message: "The dictation runtime addon was missing.",
              });
            for (const file of files) {
              const target = path.join(temporary, file.path);
              yield* io(fs.makeDirectory(path.dirname(target), { recursive: true }));
              yield* io(fs.writeFile(target, file.bytes));
            }
            yield* io(fs.remove(archive));
          }),
        );
        yield* progress("runtime", (yield* inspect).runtime);
      } else yield* progress("runtime", current.runtime);
      const existingModel = current.models.get(model);
      if (existingModel?._tag === "installed") {
        yield* progress(model, existingModel);
        return;
      }
      const totalBytes = models[model].files.reduce((total, file) => total + file.bytes, 0);
      yield* progress(model, { _tag: "installing", receivedBytes: 0, totalBytes });
      yield* atomicInstall(paths(model).model, (temporary) =>
        Effect.gen(function* () {
          let completed = 0;
          for (const file of models[model].files) {
            completed += yield* download(
              file.url,
              path.join(temporary, file.name),
              "sha256",
              file.sha256,
              file.bytes,
              (received) =>
                report(model, {
                  _tag: "installing",
                  receivedBytes: completed + received,
                  totalBytes,
                }),
            );
          }
        }),
      );
      yield* progress(model, { _tag: "installed", sizeBytes: totalBytes });
    },
    Effect.scoped,
    mutations.withPermit,
  );
  const remove = Effect.fnUntraced(function* (model: DictationModelId) {
    const destination = paths(model).model;
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.remove(`${destination}.tmp`, { recursive: true, force: true }));
  });
  return DictationArtifacts.of({ supported: runtime !== null, paths, inspect, install, remove });
});

export const layer = Layer.effect(DictationArtifacts, make);
