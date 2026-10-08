import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import * as RelayClient from "./relayClient.ts";

// The suite runs the linux code path against the real filesystem, checking
// POSIX exec bits that NTFS never reports; the win32 branch skips that check.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const layerHostRuntime = (env: Record<string, string> = {}, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0, output = "") {
  const stdout = output ? Stream.make(new TextEncoder().encode(output)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: stdout,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

// Answers `cloudflared version` with the version recorded for that path, which
// defaults to the pinned release; tests change it to simulate other binaries.
const layerSpawner = (commands: Array<string>, versions: Record<string, string> = {}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) {
          commands.push("piped-command");
          return makeHandle();
        }
        commands.push(command.command);
        if (command.args[0] === "version") {
          const version = versions[command.command] ?? RelayClient.CLOUDFLARED_VERSION;
          return makeHandle(0, `cloudflared version ${version} (built 2026-01-01-00:00 UTC)\n`);
        }
        return makeHandle();
      }),
    ),
  );

const writeExecutable = (filePath: string, contents = "cloudflared") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(filePath.slice(0, filePath.lastIndexOf("/")), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(filePath, contents);
    yield* fileSystem.chmod(filePath, 0o755);
  });

type RelayClientTestServices =
  | Layer.Success<ReturnType<typeof layerHostRuntime> | typeof NodeServices.layer>
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

const managedPathFor = (baseDir: string, version: string) =>
  `${baseDir}/tools/cloudflared/${version}/linux-x64/cloudflared`;

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: code === "EBUSY" ? "Busy" : code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(code), { code }),
  });

type InstallRename = "staging" | "activation";

/**
 * Fails the first `failures` staging or activation renames with `code`, as Windows does while
 * another process holds the file. Staging moves the binary to a `.tmp` name beside its final path.
 */
const makeLockedRenames = (
  fileSystem: FileSystem.FileSystem,
  input: { readonly rename: InstallRename; readonly failures: number; readonly code: string },
) =>
  Effect.gen(function* () {
    const firstAttempt = yield* Deferred.make<void>();
    const renames = { attempts: 0 };
    const locked = FileSystem.make({
      ...fileSystem,
      rename: (from, to) =>
        Effect.suspend(() => {
          if ((to.endsWith(".tmp") ? "staging" : "activation") !== input.rename) {
            return fileSystem.rename(from, to);
          }
          renames.attempts += 1;
          return renames.attempts <= input.failures
            ? Deferred.succeed(firstAttempt, undefined).pipe(
                Effect.andThen(Effect.fail(renameError(input.code, to))),
              )
            : fileSystem.rename(from, to);
        }),
    });
    return { locked, renames, firstAttempt };
  });

const testBinary = new TextEncoder().encode("test-cloudflared-binary");
const testReleaseAsset = {
  url: "https://example.test/cloudflared",
  sha256: Hex.encode(sha256(testBinary)),
  archive: "binary",
} as const;

const layerInstallRuntime = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    NodeServices.layer,
    layerHttpClient(testBinary),
    layerSpawner([]),
    layerHostRuntime({ PATH: "" }, platform),
  );

const managedDirectory = (baseDir: string, platform: NodeJS.Platform) =>
  `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/${platform}-x64`;

describe("RelayClient", () => {
  it.effect("cancels a contended install without removing the other installer's lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const directory = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64`;
      const lockPath = `${directory}/cloudflared.lock`;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(lockPath, "other-installer");
      const contended = yield* Deferred.make<void>();
      const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          writeFileString: (path, contents, options) =>
            fileSystem
              .writeFileString(path, contents, options)
              .pipe(
                Effect.tapError(() =>
                  path === lockPath ? Deferred.succeed(contended, undefined) : Effect.void,
                ),
              ),
        }),
      );
      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(contended);
      yield* Fiber.interrupt(installing);
      expect(yield* fileSystem.readFileString(lockPath)).toBe("other-installer");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime({ PATH: "" }),
        ),
      ),
    ),
  );

  it.effect("releases the install lock when a download is cancelled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const downloading = yield* Deferred.make<void>();
      const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
      const installing = yield* manager
        .installWithProgress((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(downloading);
      expect(yield* fileSystem.exists(lockPath)).toBe(true);
      yield* Fiber.interrupt(installing);
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime({ PATH: "" }),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)("releases a lock acquired while installation is cancelled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const acquired = yield* Deferred.make<void>();
      const completeWrite = yield* Deferred.make<void>();
      let pauseWrite = true;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("test-binary"))),
          archive: "binary",
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          writeFileString: (path, contents, options) =>
            fileSystem
              .writeFileString(path, contents, options)
              .pipe(
                Effect.tap(() =>
                  path === lockPath && pauseWrite
                    ? Deferred.succeed(acquired, undefined).pipe(
                        Effect.andThen(Deferred.await(completeWrite)),
                      )
                    : Effect.void,
                ),
              ),
        }),
      );

      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      const cancelling = yield* Fiber.interrupt(installing).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(completeWrite, undefined);
      yield* Fiber.join(cancelling);
      expect(yield* fileSystem.exists(lockPath)).toBe(false);

      pauseWrite = false;
      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new TextEncoder().encode("test-binary")),
          layerSpawner([]),
          layerHostRuntime({ PATH: "" }),
        ),
      ),
    ),
  );
  it.effect.skipIf(windowsHost)(
    "resolves explicit overrides before managed and PATH executables",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const overridePath = `${baseDir}/override-cloudflared`;
        yield* fileSystem.writeFileString(overridePath, "override");
        yield* fileSystem.chmod(overridePath, 0o755);
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(
          yield* manager.resolve.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({
                env: { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath },
              }),
            ),
          ),
        ).toEqual({
          status: "available",
          executablePath: overridePath,
          source: "override",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "downloads, verifies, validates, and atomically installs the managed executable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const bytes = new TextEncoder().encode("test-cloudflared-binary");
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: {
            url: "https://example.test/cloudflared",
            sha256: Hex.encode(sha256(bytes)),
            archive: "binary",
          },
        });

        const progress: Array<string> = [];
        const installed = yield* manager.installWithProgress((event) =>
          Effect.sync(() => {
            if (event.type === "progress") {
              progress.push(event.stage);
            }
          }),
        );
        const managedPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared`;
        expect(installed).toEqual({
          status: "available",
          executablePath: managedPath,
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
        expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
          "test-cloudflared-binary",
        );
        expect(progress).toEqual([
          "checking",
          "waiting_for_lock",
          "downloading",
          "verifying",
          "installing",
          "validating",
          "activating",
        ]);
        expect(yield* manager.resolve).toEqual(installed);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new TextEncoder().encode("test-cloudflared-binary")),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClient.RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
      expect(
        yield* fileSystem.exists(
          `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`,
        ),
      ).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new TextEncoder().encode("tampered")),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      // The first install validates the download once; the second, after waiting
      // its turn, probes the activated binary and reuses it instead of downloading.
      expect(commands).toHaveLength(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });

  it.effect.skipIf(windowsHost)(
    "observes PATH changes after the manager has been constructed",
    () => {
      const env = { PATH: "" };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const binDir = `${baseDir}/bin`;
        const executablePath = `${binDir}/cloudflared`;
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(yield* manager.resolve).toEqual({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        });

        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(executablePath, "cloudflared");
        yield* fileSystem.chmod(executablePath, 0o755);
        env.PATH = binDir;

        expect(yield* manager.resolve).toEqual({
          status: "available",
          executablePath,
          source: "path",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(env),
          ),
        ),
      );
    },
  );

  describe("version selection", () => {
    const run = <A, E>(
      body: (baseDir: string) => Effect.Effect<A, E, RelayClientTestServices>,
      options: { readonly versions?: Record<string, string> } = {},
    ) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        return yield* body(baseDir);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([], options.versions),
            layerHostRuntime({ PATH: "" }),
          ),
        ),
      );

    it.effect.skipIf(windowsHost)("skips a PATH binary older than the minimum version", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const oldPath = `${baseDir}/old/cloudflared`;
            const newPath = `${baseDir}/new/cloudflared`;
            yield* writeExecutable(oldPath);
            yield* writeExecutable(newPath);
            versions[oldPath] = "2023.8.2";
            versions[newPath] = RelayClient.CLOUDFLARED_MIN_VERSION;
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const env = { PATH: `${baseDir}/old:${baseDir}/new` };
            expect(
              yield* manager.resolve.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env }),
                ),
              ),
            ).toEqual({
              status: "available",
              executablePath: newPath,
              source: "path",
              version: RelayClient.CLOUDFLARED_MIN_VERSION,
            });
          }),
        { versions },
      );
    });

    it.effect.skipIf(windowsHost)("reports an outdated override as missing", () => {
      const versions: Record<string, string> = {};
      return run(
        (baseDir) =>
          Effect.gen(function* () {
            const overridePath = `${baseDir}/override/cloudflared`;
            yield* writeExecutable(overridePath);
            versions[overridePath] = "2025.6.0";
            const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
            const env = { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath };
            const withEnv = Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env }),
            );
            expect(yield* manager.resolve.pipe(withEnv)).toEqual({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            });
            const error = yield* manager.install.pipe(withEnv, Effect.flip);
            expect(error.reason).toBe("override_missing");
          }),
        { versions },
      );
    });

    it.effect.skipIf(windowsHost)(
      "prefers the pinned release, then the newest older managed release, then PATH",
      () => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const pathBinary = `${baseDir}/bin/cloudflared`;
              const older = managedPathFor(baseDir, "2025.9.0");
              const newer = managedPathFor(baseDir, "2026.1.0");
              const pinned = managedPathFor(baseDir, RelayClient.CLOUDFLARED_VERSION);
              // A newer server sharing this base dir owns this folder.
              const newerServer = managedPathFor(baseDir, "2099.1.0");
              versions[newerServer] = "2099.1.0";
              yield* writeExecutable(newerServer);
              versions[pathBinary] = "2026.9.3";
              versions[older] = "2025.9.0";
              versions[newer] = "2026.1.0";
              yield* writeExecutable(pathBinary);
              yield* writeExecutable(older);
              yield* writeExecutable(newer);
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
              const resolveWith = manager.resolve.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: { PATH: `${baseDir}/bin` } }),
                ),
              );

              expect(yield* resolveWith).toMatchObject({ source: "managed", version: "2026.1.0" });

              yield* writeExecutable(pinned);
              expect(yield* resolveWith).toMatchObject({
                executablePath: pinned,
                source: "managed",
                version: RelayClient.CLOUDFLARED_VERSION,
              });

              yield* manager.pruneManagedVersions;
              expect(
                (yield* fileSystem.readDirectory(`${baseDir}/tools/cloudflared`)).sort(),
              ).toEqual(["2026.1.0", RelayClient.CLOUDFLARED_VERSION, "2099.1.0"]);

              // The kept older release still outranks PATH; PATH is the last resort.
              yield* fileSystem.remove(pinned);
              expect(yield* resolveWith).toMatchObject({ source: "managed", version: "2026.1.0" });
              yield* fileSystem.remove(`${baseDir}/tools/cloudflared/2026.1.0`, {
                recursive: true,
              });
              expect(yield* resolveWith).toMatchObject({ source: "path", version: "2026.9.3" });
            }),
          { versions },
        );
      },
    );

    it.effect.skipIf(windowsHost)(
      "keeps a self-updated managed binary as a fallback but still installs the pin",
      () => {
        const versions: Record<string, string> = {};
        return run(
          (baseDir) =>
            Effect.gen(function* () {
              const pinned = managedPathFor(baseDir, RelayClient.CLOUDFLARED_VERSION);
              versions[pinned] = "2026.9.3";
              yield* writeExecutable(pinned);
              const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir });
              const resolved = yield* manager.resolve;
              expect(resolved).toEqual({
                status: "available",
                executablePath: pinned,
                source: "managed",
                version: "2026.9.3",
              });
              expect(
                resolved.status === "available" && RelayClient.isPinnedManagedRelayClient(resolved),
              ).toBe(false);
            }),
          { versions },
        );
      },
    );
  });

  it("orders and parses cloudflared versions", () => {
    expect(
      RelayClient.parseCloudflaredVersionOutput(
        "cloudflared version 2026.5.2 (built 2026-05-20-10:00 UTC)",
      ),
    ).toBe("2026.5.2");
    expect(RelayClient.parseCloudflaredVersionOutput("Incorrect Usage")).toBeNull();
    expect(RelayClient.compareCloudflaredVersions("2025.10.0", "2025.6.1")).toBeGreaterThan(0);
    expect(RelayClient.compareCloudflaredVersions("2023.8.2", "2025.6.1")).toBeLessThan(0);
  });

  it.effect.each([
    ["staging", "EBUSY"],
    ["activation", "EACCES"],
  ] as const)("retries %s on Windows while another process holds the binary", ([rename, code]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const { locked, renames, firstAttempt } = yield* makeLockedRenames(fileSystem, {
        rename,
        failures: 2,
        code,
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked));

      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(firstAttempt);
      yield* TestClock.adjust("1 second");
      const installed = yield* Fiber.join(installing);

      expect(renames.attempts).toBe(3);
      expect(new TextDecoder().decode(yield* fileSystem.readFile(installed.executablePath))).toBe(
        "test-cloudflared-binary",
      );
      expect(yield* fileSystem.readDirectory(managedDirectory(baseDir, "win32"))).toEqual([
        "cloudflared.exe",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("win32"))),
  );

  it.effect.each([
    ["staging", "EPERM", "Could not stage the relay client."],
    ["activation", "EBUSY", "Could not activate the relay client."],
  ] as const)("gives up on a Windows %s lock that does not clear", ([rename, code, message]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const { locked, renames, firstAttempt } = yield* makeLockedRenames(fileSystem, {
        rename,
        failures: Infinity,
        code,
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked));

      const installing = yield* manager.install.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(firstAttempt);
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(installing);

      expect(error.message).toBe(message);
      expect(renames.attempts).toBe(41);
      // Nothing is installed, and the staged copy, download folder, and install lock are gone.
      expect(yield* fileSystem.readDirectory(managedDirectory(baseDir, "win32"))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("win32"))),
  );

  it.effect.each([
    ["linux", "EBUSY"],
    ["win32", "EXDEV"],
  ] as const)("fails staging at once on %s for %s", ([platform, code]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const { locked, renames } = yield* makeLockedRenames(fileSystem, {
        rename: "staging",
        failures: Infinity,
        code,
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      }).pipe(Effect.provideService(FileSystem.FileSystem, locked));

      const error = yield* manager.install.pipe(Effect.flip);

      expect(error.message).toBe("Could not stage the relay client.");
      expect(renames.attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime(platform))),
  );
});
