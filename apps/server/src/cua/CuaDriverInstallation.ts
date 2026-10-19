// @effect-diagnostics nodeBuiltinImport:off -- Effect has no incremental digest.
import * as NodeStream from "@effect/platform-node/NodeStream";
import { cuaDriverRelease, type CuaDriverRelease } from "@t3tools/shared/cuaDriverRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";

import { openZipArchive } from "../zipArchive.ts";

export class CuaDriverInstallError extends Schema.TaggedError<CuaDriverInstallError>()(
  "CuaDriverInstallError",
  {
    stage: Schema.Literals(["platform", "download", "integrity", "extract", "publish"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Cua Driver installation failed during ${this.stage}.`;
  }

  static wrap(stage: CuaDriverInstallError["stage"], cause: unknown) {
    return isInstallError(cause) ? cause : new CuaDriverInstallError({ stage, cause });
  }
}

const isInstallError = Schema.is(CuaDriverInstallError);

class CuaDriverInstallation extends Context.Service<
  CuaDriverInstallation,
  { readonly executable: Effect.Effect<string, CuaDriverInstallError> }
>()("t3/cua/CuaDriverInstallation") {}

export const makeCuaDriverInstallation = Effect.fn("CuaDriverInstallation.make")(
  function* (options: { readonly baseDir: string; readonly release?: CuaDriverRelease | null }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const release =
      options.release === undefined ? cuaDriverRelease(platform, arch) : options.release;
    const installRoot = path.join(options.baseDir, "tools", "cua-driver");
    const gate = yield* Semaphore.make(1);

    const complete = Effect.fnUntraced(
      function* (directory: string, release: CuaDriverRelease) {
        for (const name of new Set([release.executable, ...release.requiredFiles])) {
          const info = yield* fs.stat(path.join(directory, name));
          if (
            info.type !== "File" ||
            info.size === 0n ||
            (name === release.executable && platform !== "win32" && (info.mode & 0o111) === 0)
          )
            return false;
        }
        return true;
      },
      Effect.orElseSucceed(() => false),
    );

    const download = Effect.fn("CuaDriverInstallation.download")(
      function* (release: CuaDriverRelease, archivePath: string) {
        const response = yield* http
          .execute(HttpClientRequest.get(release.url))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const hash = NodeCrypto.createHash("sha256");
        let bytes = 0;
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              bytes += chunk.byteLength;
              if (bytes > release.bytes) {
                return Effect.fail(new CuaDriverInstallError({ stage: "integrity" }));
              }
              hash.update(chunk);
              return Effect.void;
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        );
        if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) {
          return yield* new CuaDriverInstallError({ stage: "integrity" });
        }
      },
      Effect.timeout("10 minutes"),
      Effect.mapError((cause) => CuaDriverInstallError.wrap("download", cause)),
    );

    const safeName = (name: string) =>
      !/[\\:\p{Cc}]/u.test(name) &&
      name
        .replace(/\/$/u, "")
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..");

    const extractTar = Effect.fn("CuaDriverInstallation.extractTar")(
      function* (archivePath: string, destination: string) {
        const run = (args: ReadonlyArray<string>) =>
          spawner.string(ChildProcess.make("tar", args, { stdin: "ignore", stderr: "ignore" }));
        const names = (yield* run(["-tzf", archivePath])).trimEnd().split(/\r?\n/u);
        const types = (yield* run(["-tvzf", archivePath])).trimEnd().split(/\r?\n/u);
        if (
          names.length > 1_000 ||
          names.length !== types.length ||
          new Set(names).size !== names.length ||
          !names.every(safeName) ||
          types.some((line) => line[0] !== "-" && line[0] !== "d")
        )
          return yield* new CuaDriverInstallError({ stage: "extract" });
        // Reject links before tar can use one to redirect a later member outside staging.
        yield* fs.makeDirectory(destination);
        yield* run(["-xzf", archivePath, "-C", destination]);
      },
      Effect.mapError((cause) => CuaDriverInstallError.wrap("extract", cause)),
    );

    const extractZip = Effect.fn("CuaDriverInstallation.extractZip")(
      function* (archivePath: string, destination: string) {
        const archive = yield* openZipArchive(
          archivePath,
          (_detail, cause) => new CuaDriverInstallError({ stage: "extract", cause }),
        );
        if (archive.entryCount > 1_000)
          return yield* new CuaDriverInstallError({ stage: "extract" });
        yield* fs.makeDirectory(destination);
        for (;;) {
          const entry = yield* archive.next;
          if (entry === null) break;
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            !safeName(entry.fileName) ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            (type !== 0 && type !== 0x8000 && type !== 0x4000)
          )
            return yield* new CuaDriverInstallError({ stage: "extract" });
          const target = path.join(destination, entry.fileName);
          if (entry.fileName.endsWith("/")) {
            yield* fs.makeDirectory(target, { recursive: true });
          } else {
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* Effect.gen(function* () {
              const readable = yield* archive.streamEntry(entry);
              yield* NodeStream.fromReadable({
                evaluate: () => readable,
                onError: (cause) => new CuaDriverInstallError({ stage: "extract", cause }),
              }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
            }).pipe(Effect.scoped);
          }
        }
      },
      Effect.scoped,
      Effect.mapError((cause) => CuaDriverInstallError.wrap("extract", cause)),
    );

    const install = Effect.fn("CuaDriverInstallation.install")(
      function* (release: CuaDriverRelease) {
        const destination = path.join(installRoot, release.version);
        const executable = path.join(destination, release.executable);
        if (yield* complete(destination, release)) return executable;
        yield* fs.makeDirectory(installRoot, { recursive: true });
        // A sibling staging directory makes publication atomic on the same filesystem.
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: installRoot,
          prefix: ".install-",
        });
        const archivePath = path.join(staging, release.archiveName);
        const unpacked = path.join(staging, "driver");
        yield* download(release, archivePath);
        yield* release.format === "zip"
          ? extractZip(archivePath, unpacked)
          : extractTar(archivePath, unpacked);
        if (!(yield* complete(unpacked, release))) {
          return yield* new CuaDriverInstallError({ stage: "extract" });
        }
        if (yield* complete(destination, release)) return executable;
        yield* fs.remove(destination, { recursive: true, force: true });
        yield* fs
          .rename(unpacked, destination)
          .pipe(
            Effect.catch((cause) =>
              Effect.flatMap(complete(destination, release), (exists) =>
                exists ? Effect.void : Effect.fail(cause),
              ),
            ),
          );
        return executable;
      },
      Effect.scoped,
      Effect.mapError((cause) => CuaDriverInstallError.wrap("publish", cause)),
    );

    const executable = gate.withPermit(
      Effect.suspend(() =>
        release === null
          ? Effect.fail(new CuaDriverInstallError({ stage: "platform" }))
          : install(release),
      ),
    );
    return CuaDriverInstallation.of({ executable });
  },
);
