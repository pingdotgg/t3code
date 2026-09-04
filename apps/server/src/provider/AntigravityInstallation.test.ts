import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import {
  makeAntigravityInstallation,
  type AntigravityExecutable,
  type AntigravityInstallation,
  type AntigravityInstallationOptions,
} from "./AntigravityInstallation.ts";
import { ANTIGRAVITY_AUTH_BROWSER_MARKER } from "./antigravityAuthSupport.ts";
import type { AntigravityReleaseAsset } from "./antigravityRelease.ts";

const serverContents = "antigravity runtime\n";
const harnessContents = "local harness\n";
const previousReleaseId = "1".repeat(64);
const previousVersion = "fixture-old";
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Small ZIPs made with Python's zipfile module. The unsafe entries are intentional.
const zipFixtures = {
  complete:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  missingHarness:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAABAAEAQAAAAEQAAAAAAA==",
  duplicate:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAABhZ3lfYWNwX3NlcnZlci5wYXJLzCvJTC9KLMssqVQoKgVyclO5AFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdcxMv6BQAAAAUAAAAEgAAAAAAAAAAAAAA7YFEAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsFBgAAAAACAAIAgAAAAIgAAAAAAA==",
  traversal:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAAVAAAALi5cYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABUAAAAAAAAAAAAAAO2BAAAAAC4uXGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUcAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCGAAAAigAAAAAA",
  symlink:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAAD/oUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  oversizedMember:
    "UEsDBBQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuSoAUEsDBBQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsy8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl0WGThFFQAAABUAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5wYXJQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAFQAAAAAAAAAAAAAA7YFFAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsUEsFBgAAAAACAAIAgwAAAIgAAAAAAA==",
  windows:
    "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhly8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5leGVQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAGQAAAAAAAAAAAAAA7YFEAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAAAgACAIcAAACLAAAAAAA=",
};

const completeArchive = Buffer.from(zipFixtures.complete, "base64");

function releaseAsset(archive: Uint8Array = completeArchive, platform: NodeJS.Platform = "linux") {
  return {
    version: "fixture-new",
    url: "https://dl.google.com/antigravity-test.zip",
    sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.byteLength,
    executable: {
      name: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
      bytes: Buffer.byteLength(serverContents),
    },
    harness: {
      name: platform === "win32" ? "localharness_external.exe" : "localharness_external",
      bytes: Buffer.byteLength(harnessContents),
    },
  } satisfies AntigravityReleaseAsset;
}

const writeRelease = Effect.fn("test.writeAntigravityRelease")(function* (
  managedDirectory: string,
  asset: AntigravityReleaseAsset,
  active = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(managedDirectory, "versions", asset.sha256);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, asset.executable.name), serverContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(path.join(directory, asset.harness.name), harnessContents, {
    mode: 0o755,
  });
  yield* fs.writeFileString(
    path.join(directory, ".install-complete.json"),
    encodeJsonString({
      releaseId: asset.sha256,
      version: asset.version,
      executable: asset.executable,
      harness: asset.harness,
    }),
  );
  if (active) {
    yield* fs.writeFileString(
      path.join(managedDirectory, "active.json"),
      encodeJsonString({ releaseId: asset.sha256 }),
    );
  }
});

interface HarnessOptions {
  readonly baseDir?: string;
  readonly asset?: AntigravityReleaseAsset | null;
  readonly archive?: Buffer;
  readonly body?: Stream.Stream<Uint8Array> | undefined;
  readonly contentLength?: number;
  readonly contentEncoding?: string;
  readonly platform?: NodeJS.Platform;
  readonly path?: string;
  readonly previous?: boolean;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly validate?: AntigravityInstallationOptions["validate"];
  readonly useDefaultValidation?: boolean;
}

const makeHarness = Effect.fn("test.makeAntigravityInstallation")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-test-" }));
  const platform = options.platform ?? "linux";
  const archive = options.archive ?? completeArchive;
  const asset = options.asset === undefined ? releaseAsset(archive, platform) : options.asset;
  const managedDirectory = path.join(baseDir, "tools", "antigravity-acp", `${platform}-x64`);
  if (options.previous) {
    yield* writeRelease(managedDirectory, {
      ...releaseAsset(archive, platform),
      sha256: previousReleaseId,
      version: previousVersion,
    });
  }
  const stagingReleased = yield* Deferred.make<void>();
  const requests: string[] = [];
  const validations: Array<{ executable: AntigravityExecutable; version: string }> = [];
  const installationFs = options.fileSystem ?? fs;
  const trackedFs = FileSystem.FileSystem.of({
    ...installationFs,
    makeTempDirectoryScoped: (settings) =>
      settings?.prefix === ".install-"
        ? Effect.acquireRelease(installationFs.makeTempDirectory(settings), (directory) =>
            fs
              .remove(directory, { recursive: true, force: true })
              .pipe(Effect.orDie, Effect.andThen(Deferred.succeed(stagingReleased, undefined))),
          )
        : installationFs.makeTempDirectoryScoped(settings),
  });
  const installation = yield* makeAntigravityInstallation({
    baseDir,
    releaseAsset: asset,
    ...(options.useDefaultValidation
      ? {}
      : {
          validate: (executable: AntigravityExecutable, version: string) =>
            Effect.sync(() => validations.push({ executable, version })).pipe(
              Effect.andThen(options.validate?.(executable, version) ?? Effect.void),
            ),
        }),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(HostProcessEnvironment, { PATH: options.path ?? "" }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              headers: {
                ...(options.contentLength === undefined
                  ? {}
                  : { "content-length": String(options.contentLength) }),
                ...(options.contentEncoding === undefined
                  ? {}
                  : { "content-encoding": options.contentEncoding }),
              },
            }),
          );
          return Object.defineProperty(response, "stream", {
            value:
              options.body ??
              Stream.make(
                archive.subarray(0, 31),
                archive.subarray(31, 149),
                archive.subarray(149),
              ),
          });
        }),
      ),
    ),
  );
  return { installation, fs, path, baseDir, requests, validations, stagingReleased };
});

const terminalState = (installation: AntigravityInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const expectPreviousRelease = Effect.fn("test.expectPreviousAntigravityRelease")(function* (
  installation: AntigravityInstallation["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* installation.resolve();
  expect(resolved.version).toBe(previousVersion);
  expect(resolved.managedVersionDirectory).toBe(
    path.join(installation.managedDirectory, "versions", previousReleaseId),
  );
  expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
  expect(yield* fs.readFileString(resolved.harnessPath)).toBe(harnessContents);
  expect((yield* installation.state).installedVersion).toBe(previousVersion);
});

it.layer(NodeServices.layer)("Antigravity installation", (it) => {
  it.effect("verifies both files before activating a streamed download", () =>
    Effect.gen(function* () {
      const enteredValidation = yield* Deferred.make<void>();
      const finishValidation = yield* Deferred.make<void>();
      const { installation, fs, path, validations, requests, stagingReleased } = yield* makeHarness(
        {
          previous: true,
          validate: () =>
            Deferred.succeed(enteredValidation, undefined).pipe(
              Effect.andThen(Deferred.await(finishValidation)),
            ),
        },
      );
      const initial = yield* installation.changes.pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(initial).toMatchObject({ phase: "idle", installedVersion: previousVersion });
      const started = yield* installation.start;
      expect(started).toMatchObject({ phase: "downloading", downloadedBytes: 0 });
      yield* Deferred.await(enteredValidation);
      yield* expectPreviousRelease(installation);
      const validation = validations[0];
      expect(validation?.version).toBe("fixture-new");
      if (!validation) return yield* Effect.die("Expected runtime validation.");
      expect(yield* fs.readFileString(validation.executable.executablePath)).toBe(serverContents);
      expect(yield* fs.readFileString(validation.executable.harnessPath)).toBe(harnessContents);

      yield* Deferred.succeed(finishValidation, undefined);
      expect(yield* terminalState(installation)).toMatchObject({
        phase: "succeeded",
        operationId: started.operationId,
        downloadedBytes: completeArchive.byteLength,
        installedVersion: "fixture-new",
      });
      yield* Deferred.await(stagingReleased);
      const selected = yield* installation.resolve();
      expect(selected).toMatchObject({ source: "managed", version: "fixture-new" });
      expect(path.dirname(selected.harnessPath)).toBe(path.dirname(selected.executablePath));
      expect(yield* fs.readFileString(selected.executablePath)).toBe(serverContents);
      expect(yield* fs.readFileString(selected.harnessPath)).toBe(harnessContents);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        expect.arrayContaining([previousReleaseId, releaseAsset().sha256]),
      );
      expect(requests).toEqual([releaseAsset().url]);
    }),
  );

  it.effect.each([
    {
      name: "the expected release",
      agentName: "antigravity-acp",
      version: "fixture-new",
      valid: true,
    },
    { name: "a different agent", agentName: "other-agent", version: "fixture-new", valid: false },
    {
      name: "a different version",
      agentName: "antigravity-acp",
      version: "other-version",
      valid: false,
    },
  ])("validates $name with initialize only and removes the disposable profile", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const encoder = new TextEncoder();
      const decodeRequest = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Union([Schema.String, Schema.Number]),
            method: Schema.String,
          }),
        ),
      );
      const methods: string[] = [];
      const profiles = new Set<string>();
      let closedRuntimes = 0;
      const spawner = ChildProcessSpawner.make(
        Effect.fn("test.spawnAntigravityValidator")(function* (command) {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("Expected one validation process.");
          }
          const profile = command.options.env?.GEMINI_HOME;
          if (!profile) return yield* Effect.die("Expected a disposable validation profile.");
          profiles.add(profile);
          const helper = command.args[0] === "-e";
          const output = yield* Queue.unbounded<Uint8Array>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
            Effect.asVoid,
          );
          yield* Effect.addFinalizer(() =>
            terminate.pipe(
              Effect.andThen(Queue.shutdown(output)),
              Effect.andThen(
                Effect.sync(() => {
                  if (!helper) closedRuntimes += 1;
                }),
              ),
            ),
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(helper ? 1 : 2),
            exitCode: helper
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () => terminate,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach((bytes: Uint8Array) =>
              Effect.gen(function* () {
                const request = yield* decodeRequest(new TextDecoder().decode(bytes)).pipe(
                  Effect.orDie,
                );
                methods.push(request.method);
                yield* Queue.offer(
                  output,
                  encoder.encode(
                    `${encodeJsonString({
                      jsonrpc: "2.0",
                      id: request.id,
                      ...(request.method === "initialize"
                        ? {
                            result: {
                              protocolVersion: 1,
                              agentInfo: { name: testCase.agentName, version: testCase.version },
                              agentCapabilities: {
                                loadSession: true,
                                sessionCapabilities: { resume: {} },
                                auth: { logout: {} },
                              },
                              authMethods: [{ id: "oauth-personal", name: "Google" }],
                            },
                          }
                        : {
                            error: {
                              code: -32601,
                              message: "Validation must not sign in or create sessions.",
                            },
                          }),
                    })}\n`,
                  ),
                );
              }),
            ),
            stdout: helper ? Stream.empty : Stream.fromQueue(output),
            stderr: helper
              ? Stream.make(
                  encoder.encode(
                    `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${encodeJsonString(command.args.at(-1))}\n`,
                  ),
                )
              : Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const { installation, stagingReleased } = yield* makeHarness({
        previous: true,
        useDefaultValidation: true,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe(
        testCase.valid ? "succeeded" : "failed",
      );
      yield* Deferred.await(stagingReleased);
      expect(methods).toEqual(["initialize"]);
      expect(closedRuntimes).toBe(1);
      expect(profiles.size).toBe(1);
      for (const profile of profiles) {
        expect(yield* fs.exists(profile)).toBe(false);
      }
      if (testCase.valid) {
        expect((yield* installation.resolve()).version).toBe("fixture-new");
      } else {
        yield* expectPreviousRelease(installation);
      }
    }),
  );

  it.effect("accepts an encoded Content-Length when the body is compressed", () =>
    Effect.gen(function* () {
      // dl.google.com gzips the archive and reports the encoded size. The decoded
      // stream is still checked byte for byte and by hash.
      const { installation, validations } = yield* makeHarness({
        contentLength: completeArchive.byteLength - 1_000,
        contentEncoding: "gzip",
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("succeeded");
      expect(validations).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "checksum mismatch", asset: { ...releaseAsset(), sha256: "2".repeat(64) } },
    { name: "short download", archive: completeArchive.subarray(0, -1), asset: releaseAsset() },
    {
      name: "oversized download",
      archive: Buffer.concat([completeArchive, Buffer.from("extra")]),
      asset: releaseAsset(),
    },
    { name: "wrong Content-Length", contentLength: completeArchive.byteLength + 1 },
    { name: "missing harness", archive: Buffer.from(zipFixtures.missingHarness, "base64") },
    { name: "duplicate executable", archive: Buffer.from(zipFixtures.duplicate, "base64") },
    { name: "path traversal", archive: Buffer.from(zipFixtures.traversal, "base64") },
    { name: "symbolic link", archive: Buffer.from(zipFixtures.symlink, "base64") },
    { name: "oversized member", archive: Buffer.from(zipFixtures.oversizedMember, "base64") },
  ])("rejects $name before runtime validation", (options) =>
    Effect.gen(function* () {
      const { installation, validations, stagingReleased, fs, path } = yield* makeHarness({
        ...options,
        previous: true,
      });
      yield* installation.start;
      const state = yield* terminalState(installation);
      expect(state.phase).toBe("failed");
      expect(state.message).toBeTruthy();
      expect(validations).toEqual([]);
      yield* Deferred.await(stagingReleased);
      yield* expectPreviousRelease(installation);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        [previousReleaseId],
      );
    }),
  );

  it.effect.each(["download", "extract", "active pointer"] as const)(
    "preserves the old runtime after an ENOSPC error during %s",
    (stage) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const noSpace = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "write",
          description: "ENOSPC: no space left on device",
        });
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          sink: (target, options) =>
            (stage === "download" && target.endsWith("download.zip")) ||
            (stage === "extract" && target.endsWith("agy_acp_server.par"))
              ? fs.sink(target, options).pipe(Sink.mapInputEffect(() => Effect.fail(noSpace)))
              : fs.sink(target, options),
          writeFileString: (target, content, options) =>
            stage === "active pointer" && target.endsWith("contents.tmp")
              ? Effect.fail(noSpace)
              : fs.writeFileString(target, content, options),
        });
        const { installation, stagingReleased, path } = yield* makeHarness({
          previous: true,
          fileSystem,
        });
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("failed");
        yield* Deferred.await(stagingReleased);
        yield* expectPreviousRelease(installation);
        expect(
          (yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).some(
            (name) => name.startsWith(".install-"),
          ),
        ).toBe(false);
        expect(yield* fs.readDirectory(installation.managedDirectory)).toEqual([
          "active.json",
          "versions",
        ]);
      }),
  );

  it.effect.each(["downloading", "extracting", "verifying"] as const)(
    "cancels during %s and waits for open resources to close",
    (phase) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const barrier = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        const { installation, stagingReleased, path, validations } = yield* makeHarness({
          previous: true,
          body:
            phase === "downloading"
              ? Stream.concat(
                  Stream.make(completeArchive.subarray(0, 31)),
                  Stream.fromEffect(barrier.pipe(Effect.as(completeArchive.subarray(31)))),
                )
              : undefined,
          validate: phase === "verifying" ? () => barrier : undefined,
          fileSystem: FileSystem.FileSystem.of({
            ...fs,
            sink: (target, options) =>
              phase === "extracting" && target.endsWith("agy_acp_server.par")
                ? fs
                    .sink(target, options)
                    .pipe(
                      Sink.mapInputEffect((chunk: Uint8Array) => barrier.pipe(Effect.as(chunk))),
                    )
                : fs.sink(target, options),
          }),
        });
        const started = yield* installation.start;
        yield* Deferred.await(entered);
        expect((yield* installation.state).phase).toBe(phase);
        expect(
          (yield* installation.cancel(started.operationId ?? "missing-operation-id")).phase,
        ).toBe("cancelled");
        yield* Deferred.await(interrupted);
        yield* Deferred.await(stagingReleased);
        yield* expectPreviousRelease(installation);
        expect(validations).toHaveLength(phase === "verifying" ? 1 : 0);
        expect(
          yield* fs.readDirectory(path.join(installation.managedDirectory, "versions")),
        ).toEqual([previousReleaseId]);
      }),
  );

  it.effect.each([
    { name: "the committed install", restart: false },
    { name: "a newer install", restart: true },
  ])("does not fail $name when old pointer cleanup fails", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const nextValidationStarted = yield* Deferred.make<void>();
      const releaseNextValidation = yield* Deferred.make<void>();
      const firstWorker = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const cleanupError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        description: "EPERM: pointer temp directory is in use",
      });
      let firstPointer = true;
      let validationCount = 0;
      const { installation, stagingReleased } = yield* makeHarness({
        previous: true,
        validate: () => {
          validationCount += 1;
          return validationCount === 2
            ? Deferred.succeed(nextValidationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseNextValidation)),
              )
            : Effect.void;
        },
        fileSystem: FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectoryScoped: (settings) => {
            if (settings?.prefix !== "active.json." || !firstPointer) {
              return fs.makeTempDirectoryScoped(settings);
            }
            firstPointer = false;
            return Effect.fiber.pipe(
              Effect.tap((worker) => Deferred.succeed(firstWorker, worker)),
              Effect.andThen(
                Effect.acquireRelease(fs.makeTempDirectory(settings), () =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCleanup)),
                    Effect.andThen(Effect.die(cleanupError)),
                  ),
                ),
              ),
            );
          },
        }),
      });
      yield* Effect.gen(function* () {
        const first = yield* installation.start;
        yield* Deferred.await(cleanupStarted);
        expect(yield* installation.state).toMatchObject({
          operationId: first.operationId,
          phase: "succeeded",
          installedVersion: "fixture-new",
        });
        const current = testCase.restart ? yield* installation.start : first;
        if (testCase.restart) yield* Deferred.await(nextValidationStarted);

        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.await(yield* Deferred.await(firstWorker));
        yield* Deferred.await(stagingReleased);
        expect(yield* installation.state).toMatchObject({
          operationId: current.operationId,
          phase: testCase.restart ? "verifying" : "succeeded",
          installedVersion: "fixture-new",
        });
        expect((yield* installation.resolve()).version).toBe("fixture-new");

        yield* Deferred.succeed(releaseNextValidation, undefined);
        expect(yield* terminalState(installation)).toMatchObject({
          operationId: current.operationId,
          phase: "succeeded",
          installedVersion: "fixture-new",
        });
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseCleanup, undefined).pipe(
            Effect.andThen(Deferred.succeed(releaseNextValidation, undefined)),
          ),
        ),
      );
    }),
  );

  it.effect(
    "shares one install across callers and keeps it alive after the caller scope closes",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { installation, requests, stagingReleased } = yield* makeHarness({
          body: Stream.fromEffect(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(completeArchive),
            ),
          ),
        });
        const callerScope = yield* Scope.make();
        const started = yield* installation.start.pipe(Scope.provide(callerScope));
        yield* Deferred.await(entered);
        yield* Scope.close(callerScope, Exit.void);
        const concurrent = yield* Effect.all([installation.start, installation.start], {
          concurrency: "unbounded",
        });
        expect(concurrent.map((state) => state.operationId)).toEqual([
          started.operationId,
          started.operationId,
        ]);
        expect(
          yield* installation.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        ).toMatchObject({ phase: "downloading", operationId: started.operationId });
        yield* Deferred.succeed(release, undefined);
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        yield* Deferred.await(stagingReleased);

        const next = yield* installation.start;
        expect(next.operationId).not.toBe(started.operationId);
        expect(
          yield* installation
            .cancel(started.operationId ?? "missing-operation-id")
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "cancel" });
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect("honors explicit paths and reports invalid overrides without falling back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-path-test-" });
      const externalDirectory = path.join(baseDir, "external");
      const externalExecutable = path.join(externalDirectory, "agy_acp_server.par");
      const externalHarness = path.join(externalDirectory, "localharness_external");
      yield* fs.makeDirectory(externalDirectory);
      yield* fs.writeFileString(externalExecutable, "external server", { mode: 0o755 });
      yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
      const { installation } = yield* makeHarness({
        baseDir,
        path: externalDirectory,
        previous: true,
      });
      yield* expectPreviousRelease(installation);
      expect(yield* installation.resolve(undefined, { PATH: externalDirectory })).toMatchObject({
        source: "managed",
        version: previousVersion,
      });
      expect(yield* installation.resolve(externalExecutable)).toMatchObject({
        executablePath: externalExecutable,
        source: "override",
        managedVersionDirectory: null,
      });
      expect(yield* installation.resolve("agy_acp_server.par")).toMatchObject({
        source: "override",
      });
      yield* fs.remove(externalHarness);
      expect(yield* installation.resolve(externalExecutable).pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      expect(
        yield* installation.resolve(path.join(baseDir, "missing")).pipe(Effect.flip),
      ).toMatchObject({
        operation: "resolve",
      });
      yield* expectPreviousRelease(installation);
      yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
      yield* installation.remove();
      expect(yield* installation.resolve()).toMatchObject({
        source: "path",
        executablePath: externalExecutable,
      });
      const isolated = yield* makeHarness({ baseDir });
      expect(yield* isolated.installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      expect(
        yield* isolated.installation.resolve(undefined, { PATH: externalDirectory }),
      ).toMatchObject({
        source: "path",
        executablePath: externalExecutable,
      });
      expect(
        yield* isolated.installation.resolve("agy_acp_server.par", { PATH: externalDirectory }),
      ).toMatchObject({ source: "override", executablePath: externalExecutable });
    }),
  );

  it.effect("keeps leased releases available while new sessions resolve the new release", () =>
    Effect.gen(function* () {
      const { installation, fs, stagingReleased } = yield* makeHarness({ previous: true });
      const processScope = yield* Scope.make();
      const oldExecutable = yield* installation.acquire().pipe(Scope.provide(processScope));
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      yield* Deferred.await(stagingReleased);
      const current = yield* installation.resolve();
      expect(current.version).toBe("fixture-new");
      expect(current.executablePath).not.toBe(oldExecutable.executablePath);
      expect(yield* fs.readFileString(oldExecutable.executablePath)).toBe(serverContents);
      expect(yield* installation.remove().pipe(Effect.flip)).toMatchObject({ operation: "remove" });
      yield* Scope.close(processScope, Exit.void);
      yield* installation.remove();
      expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    }),
  );

  it.effect(
    "removes an incomplete active release before reinstalling without a PATH fallback",
    () =>
      Effect.gen(function* () {
        const { installation, baseDir, fs, path } = yield* makeHarness({ previous: true });
        const previous = yield* installation.resolve();
        yield* fs.remove(previous.harnessPath);
        const externalDirectory = path.join(baseDir, "external");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(
          path.join(externalDirectory, "agy_acp_server.par"),
          "external server",
          {
            mode: 0o755,
          },
        );
        yield* fs.writeFileString(
          path.join(externalDirectory, "localharness_external"),
          "external harness",
          {
            mode: 0o755,
          },
        );
        const restarted = yield* makeHarness({ baseDir, path: externalDirectory });
        expect(yield* restarted.installation.state).toMatchObject({
          phase: "failed",
          installedVersion: null,
          canRemove: true,
        });
        expect(yield* restarted.installation.resolve().pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });
        yield* restarted.installation.remove();
        expect(yield* restarted.installation.state).toMatchObject({
          phase: "idle",
          canRemove: false,
        });
        expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
        yield* restarted.installation.start;
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "fixture-new",
          canRemove: true,
        });
        yield* Deferred.await(restarted.stagingReleased);
        expect((yield* restarted.installation.resolve()).source).toBe("managed");
      }),
  );

  it.effect(
    "blocks removal of custom managed paths and leaves external executables and profiles intact",
    () =>
      Effect.gen(function* () {
        const { installation, fs, path, baseDir } = yield* makeHarness({ previous: true });
        const managed = yield* installation.resolve();
        const externalDirectory = path.join(baseDir, "external");
        const profileDirectory = path.join(baseDir, "providers", "antigravity", "profile");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.makeDirectory(profileDirectory, { recursive: true });
        const externalExecutable = path.join(externalDirectory, "agy_acp_server.par");
        const externalHarness = path.join(externalDirectory, "localharness_external");
        const profilePath = path.join(profileDirectory, "preferences.json");
        yield* fs.writeFileString(externalExecutable, "external server", { mode: 0o755 });
        yield* fs.writeFileString(externalHarness, "external harness", { mode: 0o755 });
        yield* fs.writeFileString(profilePath, "{}");
        expect(
          yield* installation.remove([managed.executablePath]).pipe(Effect.flip),
        ).toMatchObject({
          operation: "remove",
        });
        yield* expectPreviousRelease(installation);
        yield* installation.remove([externalExecutable]);
        expect(yield* installation.state).toMatchObject({
          phase: "idle",
          operationId: null,
          installedVersion: null,
        });
        expect(yield* fs.readFileString(externalExecutable)).toBe("external server");
        expect(yield* fs.readFileString(externalHarness)).toBe("external harness");
        expect(yield* fs.readFileString(profilePath)).toBe("{}");
      }),
  );

  it.effect(
    "reuses an immutable Windows release and preserves the pointer when rename is denied",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const archive = Buffer.from(zipFixtures.windows, "base64");
        const asset = releaseAsset(archive, "win32");
        let denyPointerRename = true;
        const renameTargets: string[] = [];
        const { installation, requests, validations } = yield* makeHarness({
          previous: true,
          platform: "win32",
          archive,
          fileSystem: FileSystem.FileSystem.of({
            ...fs,
            rename: (source, target) => {
              renameTargets.push(target);
              return denyPointerRename
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: target,
                      description: "EPERM: file is in use",
                    }),
                  )
                : fs.rename(source, target);
            },
          }),
        });
        yield* writeRelease(installation.managedDirectory, asset, false);
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("failed");
        yield* expectPreviousRelease(installation);
        expect(renameTargets).toEqual([path.join(installation.managedDirectory, "active.json")]);

        denyPointerRename = false;
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        expect((yield* installation.resolve()).version).toBe("fixture-new");
        expect(requests).toEqual([]);
        expect(validations).toHaveLength(2);
        expect(renameTargets).toEqual([
          path.join(installation.managedDirectory, "active.json"),
          path.join(installation.managedDirectory, "active.json"),
        ]);
      }),
  );

  it.effect("reports unsupported hosts without downloading or changing state", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({ asset: null, platform: "darwin" });
      expect(yield* installation.start.pipe(Effect.flip)).toMatchObject({ operation: "start" });
      expect(yield* installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      expect(yield* installation.state).toMatchObject({ phase: "idle", operationId: null });
      expect(requests).toEqual([]);
    }),
  );
});
