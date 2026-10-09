// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { cuaDriverRelease, type CuaDriverRelease } from "@t3tools/shared/cuaDriverRelease";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";

export class CuaDriverInstallError extends Schema.TaggedError<CuaDriverInstallError>()(
  "CuaDriverInstallError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallError = Schema.is(CuaDriverInstallError);
const wrapFailure = (detail: string) => (cause: unknown) =>
  isInstallError(cause) ? cause : new CuaDriverInstallError({ detail, cause });

/**
 * The pinned Cua Driver for a server that runs without the desktop app. The
 * desktop bundles the same release in its resources; a standalone `t3` server
 * downloads it into T3's home the first time a session needs it.
 */
export class CuaDriverInstallation extends Context.Service<
  CuaDriverInstallation,
  {
    /** Path of the installed executable, installing it first when missing. */
    readonly executable: Effect.Effect<string, CuaDriverInstallError>;
  }
>()("t3/cua/CuaDriverInstallation") {}

export const makeCuaDriverInstallation = Effect.fn("CuaDriverInstallation.make")(
  function* (options: { readonly baseDir: string; readonly release?: CuaDriverRelease | null }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const release =
      options.release === undefined ? cuaDriverRelease(platform, arch) : options.release;
    const installRoot = path.join(options.baseDir, "tools", "cua-driver");
    const gate = yield* Semaphore.make(1);

    // The version directory appears by one rename of a fully unpacked tree, so
    // its executable is the complete-install marker.
    const installed = (release: CuaDriverRelease) => {
      const executable = path.join(installRoot, release.version, release.executable);
      return fs.exists(executable).pipe(
        Effect.map((exists) => (exists ? Option.some(executable) : Option.none<string>())),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    };

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
                return Effect.fail(
                  new CuaDriverInstallError({
                    detail: "The Cua Driver download was larger than the pinned release.",
                  }),
                );
              }
              hash.update(chunk);
              return Effect.void;
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        );
        if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) {
          return yield* new CuaDriverInstallError({
            detail:
              "The Cua Driver download failed its size or SHA-256 check. Nothing was installed.",
          });
        }
      },
      Effect.timeout("10 minutes"),
      Effect.mapError(
        wrapFailure(
          "Could not download Cua Driver from GitHub. Check this machine's network access.",
        ),
      ),
    );

    const unsafeEntry = new CuaDriverInstallError({
      detail: "The Cua Driver archive contains an unexpected or unsafe entry.",
    });
    const isSafeRelative = (relative: string) => {
      const parts = relative.replace(/\/$/u, "").split("/");
      return (
        relative.length > 0 &&
        !relative.startsWith("/") &&
        !relative.includes("\\") &&
        parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"))
      );
    };

    // Linux and macOS archives are flat tarballs; `tar` lists them first so an
    // entry outside the destination never reaches the disk.
    const extractTar = Effect.fn("CuaDriverInstallation.extractTar")(function* (
      archivePath: string,
      destination: string,
    ) {
      const run = (args: ReadonlyArray<string>) =>
        spawner
          .string(ChildProcess.make("tar", args, { stdin: "ignore", stderr: "ignore" }))
          .pipe(Effect.mapError(wrapFailure("Could not unpack Cua Driver with tar.")));
      const names = (yield* run(["-tzf", archivePath])).trim().split("\n");
      const types = (yield* run(["-tvzf", archivePath])).trim().split("\n");
      if (
        names.length > 1_000 ||
        names.length !== types.length ||
        types.some((line) => !["-", "d"].includes(line[0] ?? "")) ||
        !names.every(isSafeRelative)
      ) {
        return yield* unsafeEntry;
      }
      yield* fs.makeDirectory(destination);
      yield* run(["-xzf", archivePath, "-C", destination]);
    });

    const extractZip = Effect.fn("CuaDriverInstallation.extractZip")(function* (
      archivePath: string,
      destination: string,
    ) {
      const archive = yield* openZipArchive(
        archivePath,
        (detail, cause) => new CuaDriverInstallError({ detail, cause }),
      );
      yield* fs.makeDirectory(destination);
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        if (!isSafeRelative(entry.fileName) || (entry.generalPurposeBitFlag & 1) !== 0) {
          return yield* unsafeEntry;
        }
        const target = path.join(destination, entry.fileName);
        if (entry.fileName.endsWith("/")) {
          yield* fs.makeDirectory(target, { recursive: true });
          continue;
        }
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* Effect.gen(function* () {
          const readable = yield* archive.streamEntry(entry);
          yield* EffectNodeStream.fromReadable<Uint8Array, CuaDriverInstallError>({
            evaluate: () => readable,
            onError: wrapFailure("Could not unpack Cua Driver."),
          }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
        }).pipe(Effect.scoped);
      }
    }, Effect.scoped);

    const install = Effect.fn("CuaDriverInstallation.install")(
      function* (release: CuaDriverRelease) {
        yield* fs.makeDirectory(installRoot, { recursive: true });
        // Staging shares the install root's filesystem so publishing is one rename.
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
        for (const file of release.requiredFiles) {
          if (!(yield* fs.exists(path.join(unpacked, file)))) {
            return yield* new CuaDriverInstallError({
              detail: `The Cua Driver archive is missing ${file}.`,
            });
          }
        }
        const destination = path.join(installRoot, release.version);
        yield* fs.remove(destination, { recursive: true, force: true });
        yield* fs.rename(unpacked, destination);
        // Older versions are never in use once this one is published.
        for (const name of yield* fs.readDirectory(installRoot)) {
          if (name !== release.version && !name.startsWith(".install-")) {
            yield* fs.remove(path.join(installRoot, name), { recursive: true, force: true });
          }
        }
        return path.join(destination, release.executable);
      },
      Effect.scoped,
      Effect.mapError(wrapFailure("Could not save Cua Driver in T3's home directory.")),
    );

    const executable = gate.withPermit(
      Effect.gen(function* () {
        if (release === null) {
          return yield* new CuaDriverInstallError({
            detail: `Cua publishes no driver for ${platform}-${arch}.`,
          });
        }
        const existing = yield* installed(release);
        if (Option.isSome(existing)) return existing.value;
        yield* Effect.logInfo("Installing Cua Driver.", { version: release.version });
        return yield* install(release);
      }),
    );

    return CuaDriverInstallation.of({ executable });
  },
);

export const layer = Layer.effect(
  CuaDriverInstallation,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeCuaDriverInstallation({ baseDir: config.baseDir });
  }),
);
