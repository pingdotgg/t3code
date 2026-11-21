// @effect-diagnostics nodeBuiltinImport:off - hashes a small archive fixture.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { FetchHttpClient } from "effect/http";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Config from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PiperRuntime from "./PiperRuntime.ts";
import * as Artifacts from "./piperArtifacts.ts";

it.effect(
  "installs a verified runtime atomically and cleans failed or cancelled installation attempts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bytes = new TextEncoder().encode("archive fixture");
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(Artifacts, "piperArtifact").mockReturnValue({
            filename: "python.tar.gz",
            url: "https://python.example/fixture.tar.gz",
            wheelUrl: "https://piper.example/fixture.whl",
            wheelSha256: "fixture",
            size: bytes.length,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          }),
        ),
        (artifact) => Effect.sync(() => artifact.mockRestore()),
      );
      let block = false;
      const extracting = yield* Deferred.make<void>();
      const run = (input: ProcessRunner.ProcessRunInput) =>
        Effect.gen(function* () {
          if (input.command === "tar") {
            const staging = input.args[input.args.indexOf("-C") + 1]!;
            yield* fs.makeDirectory(path.join(staging, "python", "bin"), { recursive: true });
            yield* fs.writeFile(path.join(staging, "python", "bin", "python3"), bytes);
            if (block) {
              yield* Deferred.succeed(extracting, undefined);
              return yield* Effect.never;
            }
          }
          return {
            code: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }).pipe(Effect.orDie);
      let corrupt = false;
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(corrupt ? "bad archive" : bytes),
      );
      let failFilesystem = false;
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "mkdir",
        description: "denied",
      });
      const context = yield* Layer.build(
        PiperRuntime.layer.pipe(
          Layer.provide(
            Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              makeDirectory: (...args) =>
                failFilesystem ? Effect.fail(denied) : fs.makeDirectory(...args),
              remove: (...args) => (failFilesystem ? Effect.fail(denied) : fs.remove(...args)),
            }),
          ),
          Layer.provide(Config.ServerConfig.layerTest(".", { prefix: "t3-piper-runtime-" })),
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
          Layer.provide(FetchHttpClient.layer),
        ),
      );
      const runtime = Context.get(context, PiperRuntime.PiperRuntime);
      const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect((yield* runtime.status).state).toBe("not-installed");
      failFilesystem = true;
      expect(yield* Effect.flip(runtime.install)).toMatchObject({
        operation: "create-directory",
        cause: denied,
      });
      expect(yield* Effect.flip(runtime.remove)).toMatchObject({
        operation: "remove",
        cause: denied,
      });
      failFilesystem = false;
      fetch.mockRejectedValueOnce(new Error("network unavailable"));
      expect(yield* Effect.flip(provided(runtime.install))).toMatchObject({
        _tag: "PiperRuntimeOperationError",
        cause: { _tag: "HttpClientError" },
      });
      expect((yield* provided(runtime.install)).state).toBe("ready");
      const binary = yield* runtime.executable;
      expect(yield* fs.exists(binary)).toBe(true);
      yield* provided(runtime.install);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((yield* runtime.remove).state).toBe("not-installed");
      corrupt = true;
      expect(yield* Effect.flip(provided(runtime.install))).toMatchObject({
        reason: "unavailable",
      });
      expect(yield* fs.exists(binary)).toBe(false);
      corrupt = false;
      let chunks = 0;
      const cancelled = vi.fn();
      fetch.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(bytes);
                if (++chunks === 3) controller.close();
              },
              cancel: cancelled,
            },
            { highWaterMark: 0 },
          ),
        ),
      );
      expect(yield* Effect.flip(provided(runtime.install))).toMatchObject({
        _tag: "PiperRuntimeOperationError",
        cause: { _tag: "SpeechBodyTooLarge" },
      });
      expect(cancelled).toHaveBeenCalledOnce();
      expect(chunks).toBe(2);
      block = true;
      const pending = yield* provided(runtime.install).pipe(Effect.forkChild);
      yield* Deferred.await(extracting);
      expect((yield* runtime.status).state).toBe("installing");
      expect((yield* runtime.cancel).state).toBe("not-installed");
      yield* Fiber.join(pending);
      expect(yield* fs.exists(binary)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provideService(HostProcess.LinuxLibc, "gnu"),
    ),
);

it.effect("offers no download for unsupported architecture or libc", () =>
  Effect.gen(function* () {
    expect(Artifacts.piperArtifact("linux", "x64", "musl")).toBeNull();
    expect(Artifacts.piperArtifact("win32", "arm64")).toBeNull();
    expect(Artifacts.piperArtifact("linux", "x64", "gnu")).not.toBeNull();
    expect(Artifacts.piperArtifact("darwin", "arm64")).not.toBeNull();
    const context = yield* Layer.build(
      PiperRuntime.layer.pipe(
        Layer.provide(Config.ServerConfig.layerTest(".", { prefix: "t3-piper-runtime-" })),
        Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
        Layer.provide(FetchHttpClient.layer),
      ),
    );
    const runtime = Context.get(context, PiperRuntime.PiperRuntime);
    expect((yield* runtime.status).state).toBe("unsupported");
    expect(yield* Effect.flip(runtime.install)).toMatchObject({ reason: "unavailable" });
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
  ),
);
