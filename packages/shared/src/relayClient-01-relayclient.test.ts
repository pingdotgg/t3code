import { sha256 } from "@noble/hashes/sha2";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "./HostProcess.ts";

import * as RelayClient from "./relayClient.ts";

// POSIX exec-bit checks do not apply on NTFS.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const layerHostRuntime = (env: Record<string, string> = {}, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, env),
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
  | Layer.Success<
      ReturnType<typeof layerHostRuntime> | typeof NodeServices.layer | typeof NodeCrypto.layer
    >
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
    NodeCrypto.layer,
    layerHttpClient(testBinary),
    layerSpawner([]),
    layerHostRuntime({ PATH: "" }, platform),
  );



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
          rename: (from, to) =>
            fileSystem
              .rename(from, to)
              .pipe(
                Effect.tapError(() =>
                  to === lockPath ? Deferred.succeed(contended, undefined) : Effect.void,
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
          NodeCrypto.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime({ PATH: "" }),
        ),
      ),
    ),
  );
  it.effect.each(["live owner", "recent legacy"] as const)("keeps a lock with a %s", (kind) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const owner = `${process.pid}-still-running`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      if (kind === "live owner") {
        yield* fileSystem.makeDirectory(lockPath);
        yield* fileSystem.writeFileString(`${lockPath}/${owner}`, "");
      } else {
        yield* fileSystem.writeFileString(lockPath, "");
      }
      const written = yield* fileSystem.stat(lockPath);
      yield* TestClock.setTime(
        Option.getOrThrow(written.mtime).getTime() + (kind === "live owner" ? 3_600_000 : 6_000),
      );
      const waiting = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });
      const installing = yield* manager.install.pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(installing);
      if (kind === "live owner") {
        expect(yield* fileSystem.readDirectory(lockPath)).toEqual([owner]);
      } else {
        expect(yield* fileSystem.readFileString(lockPath)).toBe("");
      }
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );
  it.effect.skipIf(windowsHost)("replaces an install lock left by an exited installer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(lockPath);
      yield* fileSystem.writeFileString(`${lockPath}/2147483647-exited-installer`, "");
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });

      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );
  it.effect.skipIf(windowsHost)("replaces an empty install lock left by an exited installer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      yield* fileSystem.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(lockPath, "");
      const written = yield* fileSystem.stat(lockPath);
      const mtime = Option.getOrThrow(written.mtime).getTime();
      // File mtimes use wall time; advance the test clock past legacy expiry.
      yield* TestClock.setTime(mtime + 60 * 60 * 1_000);
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: testReleaseAsset,
      });

      expect(yield* manager.install).toMatchObject({ status: "available" });
      expect(yield* fileSystem.exists(lockPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
  );
  it.effect("keeps a replacement lock when a stale contender resumes cleanup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const lockPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared.lock`;
      const abandoned = "2147483647-exited-installer";
      const replacement = `${process.pid}-replacement`;
      yield* fileSystem.makeDirectory(lockPath, { recursive: true });
      yield* fileSystem.writeFileString(`${lockPath}/${abandoned}`, "");
      const checked = yield* Deferred.make<void>();
      let replaced = false;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({ baseDir }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readDirectory: (path) =>
            fileSystem.readDirectory(path).pipe(
              Effect.tap((entries) =>
                Effect.gen(function* () {
                  if (path !== lockPath) return;
                  if (replaced) {
                    expect(entries).toEqual([replacement]);
                    yield* Deferred.succeed(checked, undefined);
                    return;
                  }
                  replaced = true;
                  yield* fileSystem.rename(lockPath, `${lockPath}.old`);
                  yield* fileSystem.makeDirectory(lockPath);
                  yield* fileSystem.writeFileString(`${lockPath}/${replacement}`, "");
                }),
              ),
            ),
        }),
      );
      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Fiber.interrupt(installing);
      expect(yield* fileSystem.readDirectory(lockPath)).toEqual([replacement]);
    }).pipe(Effect.scoped, Effect.provide(layerInstallRuntime("linux"))),
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
          NodeCrypto.layer,
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
          rename: (from, to) =>
            fileSystem
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  to === lockPath && pauseWrite
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
          NodeCrypto.layer,
          layerHttpClient(new TextEncoder().encode("test-binary")),
          layerSpawner([]),
          layerHostRuntime({ PATH: "" }),
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
            NodeCrypto.layer,
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
          NodeCrypto.layer,
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
      expect(commands).toHaveLength(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });
  it.effect("observes hydrated PATH changes after the manager has been constructed", () => {
    const platform = windowsHost ? "win32" : "linux";
    const executableName = windowsHost ? "cloudflared.exe" : "cloudflared";
    const configEnv = { PATH: "" };
    const hostEnv = { PATH: "" };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const binDir = `${baseDir}/bin`;
      const executablePath = `${binDir}/${executableName}`;
      const resolvedExecutablePath = windowsHost
        ? executablePath.replaceAll("/", "\\")
        : executablePath;
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
      });

      const resolveWithStaleConfig = manager.resolve.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: configEnv }),
        ),
        Effect.provideService(HostProcess.Environment, hostEnv),
      );

      expect(yield* resolveWithStaleConfig).toEqual({
        status: "missing",
        version: RelayClient.CLOUDFLARED_VERSION,
      });

      yield* fileSystem.makeDirectory(binDir);
      yield* fileSystem.writeFileString(executablePath, "cloudflared");
      if (!windowsHost) yield* fileSystem.chmod(executablePath, 0o755);
      hostEnv.PATH = binDir;

      expect(yield* resolveWithStaleConfig).toEqual({
        status: "available",
        executablePath: resolvedExecutablePath,
        source: "path",
        version: RelayClient.CLOUDFLARED_VERSION,
      });

      const resolveWithOverride = manager.resolve.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { PATH: "", T3CODE_CLOUDFLARED_PATH: executablePath },
          }),
        ),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      );
      expect(yield* resolveWithOverride).toEqual({
        status: "available",
        executablePath,
        source: "override",
        version: RelayClient.CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          layerHttpClient(new Uint8Array()),
          layerSpawner([]),
          layerHostRuntime(configEnv, platform),
        ),
      ),
    );
  });
});

