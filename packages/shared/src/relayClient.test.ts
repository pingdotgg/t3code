import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  RelayClientInstallError,
  CLOUDFLARED_VERSION,
  makeCloudflaredRelayClient,
  resolveManagedCloudflaredPath,
} from "./relayClient.ts";

const emptyConfigProvider = () => ConfigProvider.fromEnv({ env: {} });

function makeHandle(exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const makeHttpClientLayer = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const makeSpawnerLayer = (commands: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        return makeHandle();
      }),
    ),
  );

const lockedFileInfo: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
};

const fileSystemError = (tag: "AlreadyExists" | "NotFound", method: string, path: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: tag === "AlreadyExists" ? "File already exists" : "No such file or directory",
  });

const makeLockedFileSystemLayer = (attempts: { count: number }) =>
  FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    remove: () => Effect.void,
    stat: (path) =>
      path.endsWith(".lock")
        ? Effect.succeed(lockedFileInfo)
        : Effect.fail(fileSystemError("NotFound", "stat", path)),
    writeFileString: (path) =>
      Effect.gen(function* () {
        attempts.count += 1;
        return yield* Effect.fail(fileSystemError("AlreadyExists", "writeFileString", path));
      }),
  });

describe("RelayClient", () => {
  it.effect("resolves explicit overrides before managed and PATH executables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const overridePath = `${baseDir}/override-cloudflared`;
      yield* fileSystem.writeFileString(overridePath, "override");
      yield* fileSystem.chmod(overridePath, 0o755);
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        configProvider: () =>
          ConfigProvider.fromEnv({
            env: {
              PATH: "",
              T3CODE_CLOUDFLARED_PATH: overridePath,
            },
          }),
      });

      expect(yield* manager.resolve).toEqual({
        status: "available",
        executablePath: overridePath,
        source: "override",
        version: CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new Uint8Array()),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("downloads, verifies, validates, and atomically installs the managed executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const bytes = new TextEncoder().encode("test-cloudflared-binary");
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const progress: Array<string> = [];
      const installed = yield* manager.installWithProgress((event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
      );
      const managedPath = resolveManagedCloudflaredPath({
        baseDir,
        platform: "linux",
        arch: "x64",
      });
      expect(installed).toEqual({
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
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
          makeHttpClientLayer(new TextEncoder().encode("test-cloudflared-binary")),
          makeSpawnerLayer([]),
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
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new TextEncoder().encode("tampered")),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );

  it.effect("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, makeHttpClientLayer(bytes), makeSpawnerLayer(commands)),
      ),
    );
  });

  it.effect("fails with install_locked after the lock retry schedule is exhausted", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    const attempts = { count: 0 };
    return Effect.gen(function* () {
      const baseDir = "/tmp/t3-cloudflared-test-locked";
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      const install = yield* manager.install.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(10));
      const error = yield* Fiber.join(install);

      assert.ok(error instanceof RelayClientInstallError);
      assert.equal(error.reason, "install_locked");
      assert.equal(attempts.count, 100);
      assert.equal(commands.length, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeLockedFileSystemLayer(attempts),
          TestClock.layer(),
          makeHttpClientLayer(bytes),
          makeSpawnerLayer(commands),
        ),
      ),
    );
  });

  it.effect("removes stale install locks before downloading the managed executable", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-stale-lock-",
      });
      const managedPath = resolveManagedCloudflaredPath({
        baseDir,
        platform: "linux",
        arch: "x64",
      });
      const lockPath = `${managedPath}.lock`;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(path.dirname(managedPath), { recursive: true });
      yield* fileSystem.writeFileString(lockPath, "stale");
      yield* fileSystem.utimes(lockPath, 0, 0);
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
        configProvider: emptyConfigProvider,
      });

      yield* TestClock.adjust(Duration.minutes(6));
      const installed = yield* manager.install;

      assert.deepStrictEqual(installed, {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      });
      assert.equal(commands.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestClock.layer(),
          makeHttpClientLayer(bytes),
          makeSpawnerLayer(commands),
        ),
      ),
    );
  });

  it.effect("observes PATH changes after the manager has been constructed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const binDir = `${baseDir}/bin`;
      const executablePath = `${binDir}/cloudflared`;
      let path = "";
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        platform: "linux",
        arch: "x64",
        configProvider: () => ConfigProvider.fromEnv({ env: { PATH: path } }),
      });

      expect(yield* manager.resolve).toEqual({
        status: "missing",
        version: CLOUDFLARED_VERSION,
      });

      yield* fileSystem.makeDirectory(binDir);
      yield* fileSystem.writeFileString(executablePath, "cloudflared");
      yield* fileSystem.chmod(executablePath, 0o755);
      path = binDir;

      expect(yield* manager.resolve).toEqual({
        status: "available",
        executablePath,
        source: "path",
        version: CLOUDFLARED_VERSION,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(new Uint8Array()),
          makeSpawnerLayer([]),
        ),
      ),
    ),
  );
});
