// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import type { HttpClientError } from "effect/http";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import type { SpeechModel } from "./model.ts";

export type ModelFile = Pick<SpeechModel, "id" | "filename" | "revision" | "size" | "sha256"> & {
  /** Groups a multi-file model's repository paths under one local directory. */
  readonly directory?: string;
};

class SpeechModelDownloadError extends Schema.TaggedError<SpeechModelDownloadError>()(
  "SpeechModelDownloadError",
  {
    modelId: Schema.String,
    reason: Schema.Literals(["status", "range", "size", "verification"]),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Speech model download failed: ${this.reason}${this.status === undefined ? "" : ` ${this.status}`}.`;
  }
}

type SpeechModelDownloadProgress = {
  readonly onProgress?: (downloaded: number) => void;
  readonly onVerificationStart?: () => void;
};

export class SpeechModelStore extends Context.Service<
  SpeechModelStore,
  {
    /** Cheap size check for status polls; never hashes the file. */
    readonly isReady: (model: ModelFile) => Effect.Effect<boolean>;
    /** The installed file once its SHA-256 has been verified, hashing it on first use. */
    readonly installedPath: (model: ModelFile) => Effect.Effect<string | undefined>;
    readonly download: (
      model: ModelFile,
      progress?: SpeechModelDownloadProgress,
    ) => Effect.Effect<
      string,
      SpeechModelDownloadError | PlatformError | HttpClientError.HttpClientError
    >;
    readonly remove: (model: ModelFile) => Effect.Effect<void, PlatformError>;
  }
>()("t3/speech/SpeechModelStore") {}

const DOWNLOAD_ATTEMPTS = 3;
const PARTIAL_FILENAME =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const directory = path.join(config.stateDir, "speech", "models");
  // The server already owns this state directory; no download can be active before the store opens.
  for (const name of yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))) {
    if (PARTIAL_FILENAME.test(name)) {
      yield* fs.remove(path.join(directory, name), { force: true }).pipe(Effect.ignore);
    }
  }
  const modelPath = (model: ModelFile) =>
    path.join(directory, model.directory ?? "", model.filename);
  // Files whose digest failed, by identity, so status polls stop calling them ready.
  const corrupt = new Map<string, string>();

  const identity = (model: ModelFile, info: FileSystem.File.Info) =>
    [
      model.sha256,
      info.size,
      Option.getOrUndefined(info.mtime)?.getTime(),
      info.dev,
      Option.getOrUndefined(info.ino),
    ].join(":");

  const statFile = (file: string) => fs.stat(file).pipe(Effect.orElseSucceed(() => undefined));

  const expectedFile = (model: ModelFile, file: string) =>
    statFile(file).pipe(
      Effect.map((info) =>
        info?.type === "File" && Number(info.size) === model.size ? info : undefined,
      ),
    );

  const digestMatches = Effect.fn("SpeechModelStore.digest")(
    function* (model: ModelFile, file: string) {
      const hash = NodeCrypto.createHash("sha256");
      yield* fs
        .stream(file)
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => void hash.update(chunk))));
      return hash.digest("hex") === model.sha256;
    },
    Effect.orElseSucceed(() => false),
  );

  // A verified file is trusted while its size, mtime, device and inode are unchanged.
  const verifiedPath = Effect.fn("SpeechModelStore.verifiedPath")(function* (
    model: ModelFile,
    file: string,
    onVerificationStart?: () => void,
  ) {
    const info = yield* expectedFile(model, file);
    if (!info) return undefined;
    const marker = identity(model, info);
    if (corrupt.get(file) === marker) return undefined;
    const recorded = yield* fs
      .readFileString(`${file}.verified`)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (recorded === marker) return file;
    onVerificationStart?.();
    const valid = yield* digestMatches(model, file);
    if (!valid) corrupt.set(file, marker);
    const current = yield* expectedFile(model, file);
    if (!valid || !current || identity(model, current) !== marker) return undefined;
    yield* fs.writeFileString(`${file}.verified`, marker, { mode: 0o600 }).pipe(Effect.ignore);
    return file;
  });

  const fetchInto = Effect.fn("SpeechModelStore.fetch")(function* (
    model: ModelFile,
    url: string,
    partialPath: string,
    offset: number,
    onProgress?: (downloaded: number) => void,
  ) {
    const request = HttpClientRequest.get(url).pipe(
      offset > 0 ? HttpClientRequest.setHeader("Range", `bytes=${offset}-`) : (r) => r,
    );
    const response = yield* http.execute(request);
    const resumed = offset > 0 && response.status === 206;
    if (!resumed && response.status !== 200)
      return yield* new SpeechModelDownloadError({
        modelId: model.id,
        reason: "status",
        status: response.status,
      });
    if (resumed) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers["content-range"] ?? "");
      if (
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) !== model.size - 1 ||
        Number(range[3]) !== model.size
      )
        return yield* new SpeechModelDownloadError({ modelId: model.id, reason: "range" });
    }
    const start = resumed ? offset : 0;
    const contentLength = response.headers["content-length"];
    if (
      contentLength !== undefined &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) !== model.size - start
    )
      return yield* new SpeechModelDownloadError({ modelId: model.id, reason: "size" });
    let downloaded = start;
    onProgress?.(downloaded);
    yield* response.stream.pipe(
      Stream.tap((chunk) => {
        downloaded += chunk.byteLength;
        if (downloaded > model.size)
          return Effect.fail(new SpeechModelDownloadError({ modelId: model.id, reason: "size" }));
        onProgress?.(downloaded);
        return Effect.void;
      }),
      Stream.run(fs.sink(partialPath, { flag: resumed ? "a" : "w", mode: 0o600 })),
    );
    return downloaded;
  });

  const download: SpeechModelStore["Service"]["download"] = Effect.fn("SpeechModelStore.download")(
    function* (model, progress = {}) {
      yield* Effect.annotateCurrentSpan({ modelId: model.id });
      const finalPath = modelPath(model);
      yield* fs.makeDirectory(path.dirname(finalPath), { recursive: true });
      if (yield* verifiedPath(model, finalPath, progress.onVerificationStart)) return finalPath;
      // Partials stay at the top level, where startup cleanup looks for them.
      const partialPath = path.join(
        directory,
        `${path.basename(model.filename)}.${yield* random.uuidV4()}.part`,
      );
      const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${model.filename}`;
      return yield* Effect.gen(function* () {
        for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
          const offset = Number((yield* statFile(partialPath))?.size ?? 0);
          if (offset === model.size) break;
          // Transport and disk failures resume from the partial file; a bad response does not.
          const downloaded = yield* fetchInto(
            model,
            url,
            partialPath,
            offset,
            progress.onProgress,
          ).pipe(
            Effect.catchIf(
              (error) => attempt < DOWNLOAD_ATTEMPTS && error._tag !== "SpeechModelDownloadError",
              () => Effect.succeed(-1),
            ),
          );
          if (downloaded === model.size) break;
        }
        progress.onVerificationStart?.();
        const complete = yield* expectedFile(model, partialPath);
        if (!complete || !(yield* digestMatches(model, partialPath)))
          return yield* new SpeechModelDownloadError({ modelId: model.id, reason: "verification" });
        yield* fs.rename(partialPath, finalPath);
        // Rename changes file metadata, so record the verified file's final identity.
        const info = yield* fs.stat(finalPath);
        yield* fs
          .writeFileString(`${finalPath}.verified`, identity(model, info), { mode: 0o600 })
          .pipe(Effect.ignore);
        return finalPath;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : fs.remove(partialPath, { force: true }).pipe(Effect.ignore),
        ),
      );
    },
  );

  return SpeechModelStore.of({
    isReady: Effect.fn("SpeechModelStore.isReady")((model) =>
      expectedFile(model, modelPath(model)).pipe(
        Effect.map(
          (info) => info !== undefined && corrupt.get(modelPath(model)) !== identity(model, info),
        ),
      ),
    ),
    installedPath: Effect.fn("SpeechModelStore.installedPath")((model) =>
      verifiedPath(model, modelPath(model)),
    ),
    download,
    remove: Effect.fn("SpeechModelStore.remove")(function* (model) {
      const file = modelPath(model);
      yield* fs.remove(file, { force: true });
      yield* fs.remove(`${file}.verified`, { force: true });
    }),
  });
});

export const layer = Layer.effect(SpeechModelStore, make);
