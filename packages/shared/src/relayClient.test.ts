import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import {
  RelayClientInstallError,
  CLOUDFLARED_VERSION,
  makeCloudflaredRelayClient,
} from "./relayClient.ts";

// The suite runs the linux code path against the real filesystem, checking
// POSIX exec bits that NTFS never reports; the win32 branch skips that check.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const hostRuntimeLayer = (env: Record<string, string> = {}, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0, output = "") {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(output)),
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

const makeSpawnerLayer = (commands: Array<string>, versions: Record<string, string> = {}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        // The pinned Windows executable rejects --version but accepts the version subcommand.
        if (!ChildProcess.isStandardCommand(command)) return makeHandle();
        return makeHandle(
          command.args.includes("--version") ? 1 : 0,
          `cloudflared version ${versions[command.command] ?? CLOUDFLARED_VERSION} (built test)\n`,
        );
      }),
    ),
  );

describe("RelayClient", () => {
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
        const manager = yield* makeCloudflaredRelayClient({
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
          version: CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeHttpClientLayer(new Uint8Array()),
            makeSpawnerLayer([]),
            hostRuntimeLayer(),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "downloads, verifies, and installs the managed executable despite PATH",
    () => {
      const env = { PATH: "" };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const binDir = `${baseDir}/bin`;
        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(`${binDir}/cloudflared`, "old cloudflared");
        yield* fileSystem.chmod(`${binDir}/cloudflared`, 0o755);
        env.PATH = binDir;
        const bytes = new TextEncoder().encode("test-cloudflared-binary");
        const manager = yield* makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: {
            url: "https://example.test/cloudflared",
            sha256: Encoding.encodeHex(sha256(bytes)),
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
        const managedPath = `${baseDir}/tools/cloudflared/${CLOUDFLARED_VERSION}/linux-x64/cloudflared`;
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
            hostRuntimeLayer(env),
          ),
        ),
      );
    },
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
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
          hostRuntimeLayer(),
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
      const manager = yield* makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Encoding.encodeHex(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          makeHttpClientLayer(bytes),
          makeSpawnerLayer(commands),
          hostRuntimeLayer(),
        ),
      ),
    );
  });

  it.effect.skipIf(windowsHost)(
    "requires the managed release even when PATH has cloudflared",
    () => {
      const commands: Array<string> = [];
      const env = { PATH: "" };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const binDir = `${baseDir}/bin`;
        const executablePath = `${binDir}/cloudflared`;
        const manager = yield* makeCloudflaredRelayClient({
          baseDir,
        });

        expect(yield* manager.resolve).toEqual({
          status: "missing",
          version: CLOUDFLARED_VERSION,
        });

        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(executablePath, "cloudflared");
        yield* fileSystem.chmod(executablePath, 0o755);
        env.PATH = binDir;

        expect(yield* manager.resolve).toEqual({ status: "missing", version: CLOUDFLARED_VERSION });
        expect(commands).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeHttpClientLayer(new Uint8Array()),
            makeSpawnerLayer(commands),
            hostRuntimeLayer(env),
          ),
        ),
      );
    },
  );

  it.effect.skipIf(windowsHost)(
    "uses only compatible PATH binaries without a managed asset",
    () => {
      const env = { PATH: "" };
      const versions: Record<string, string> = {};
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const oldDir = `${baseDir}/old`;
        const newDir = `${baseDir}/new`;
        yield* fileSystem.makeDirectory(oldDir);
        yield* fileSystem.makeDirectory(newDir);
        const oldPath = `${oldDir}/cloudflared`;
        const newPath = `${newDir}/cloudflared`;
        versions[oldPath] = "2023.8.2";
        versions[newPath] = "2025.6.1";
        for (const executablePath of [oldPath, newPath]) {
          yield* fileSystem.writeFileString(executablePath, "cloudflared");
          yield* fileSystem.chmod(executablePath, 0o755);
        }
        const manager = yield* makeCloudflaredRelayClient({ baseDir });
        env.PATH = oldDir;
        expect(yield* manager.resolve).toEqual({
          status: "unsupported",
          platform: "freebsd",
          arch: "x64",
          version: CLOUDFLARED_VERSION,
        });
        env.PATH = `${oldDir}:${newDir}`;
        expect(yield* manager.resolve).toEqual({
          status: "available",
          executablePath: newPath,
          source: "path",
          version: "2025.6.1",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeHttpClientLayer(new Uint8Array()),
            makeSpawnerLayer([], versions),
            hostRuntimeLayer(env, "freebsd"),
          ),
        ),
      );
    },
  );

  it.effect.skipIf(windowsHost)(
    "rejects an outdated override and reports a valid override's version",
    () => {
      const env = { PATH: "", T3CODE_CLOUDFLARED_PATH: "" };
      const versions: Record<string, string> = {};
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const executablePath = `${baseDir}/cloudflared`;
        yield* fileSystem.writeFileString(executablePath, "cloudflared");
        yield* fileSystem.chmod(executablePath, 0o755);
        env.T3CODE_CLOUDFLARED_PATH = executablePath;
        const manager = yield* makeCloudflaredRelayClient({ baseDir });

        versions[executablePath] = "2023.8.2";
        expect(yield* manager.resolve).toEqual({ status: "missing", version: CLOUDFLARED_VERSION });
        const error = yield* manager.install.pipe(Effect.flip);
        expect(error.reason).toBe("override_missing");

        versions[executablePath] = "2025.6.1";
        expect(yield* manager.resolve).toEqual({
          status: "available",
          executablePath,
          source: "override",
          version: "2025.6.1",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeHttpClientLayer(new Uint8Array()),
            makeSpawnerLayer([], versions),
            hostRuntimeLayer(env),
          ),
        ),
      );
    },
  );
});
