import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { type AntigravityReleaseAsset } from "./antigravityRelease.ts";

const serverContents = "antigravity runtime\n";
const harnessContents = "local harness\n";
const previousReleaseId = "1".repeat(64);
const previousVersion = "fixture-old";
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

// Linux platform mocks cannot enforce POSIX exec bits on NTFS; use the host platform.
const hostPlatform: NodeJS.Platform =
  HostProcess.Platform.defaultValue() === "win32" ? "win32" : "linux";
const completeArchive = Buffer.from(
  hostPlatform === "win32" ? zipFixtures.windows : zipFixtures.complete,
  "base64",
);
const executableName = hostPlatform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
const harnessName =
  hostPlatform === "win32" ? "localharness_external.exe" : "localharness_external";

const releaseAsset = Effect.fn("test.antigravityReleaseAsset")(function* (
  archive: Uint8Array = completeArchive,
  platform: NodeJS.Platform = hostPlatform,
) {
  const digest = yield* Digest.Digest;
  return {
    version: "fixture-new",
    url: "https://dl.google.com/antigravity-test.zip",
    sha256: Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie)),
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
});

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
  readonly arch?: NodeJS.Architecture;
  readonly path?: string;
  readonly previous?: boolean;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly validate?: AntigravityInstallation.AntigravityInstallationOptions["validate"];
  readonly useDefaultValidation?: boolean;
  readonly connectTimeout?: boolean;
  readonly manifest?: Effect.Effect<ModelManifest.ModelManifestData>;
  readonly native?: boolean;
  readonly nativeVersion?: string;
  readonly nativeManifest?: (manifest: { version: string; url: string; sha512: string }) => unknown;
  readonly beforeManifest?: Effect.Effect<void>;
  readonly updateChecksEnabled?: Effect.Effect<boolean>;
}

const makeHarness = Effect.fn("test.makeAntigravityInstallation")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-test-" }));
  const platform = options.platform ?? hostPlatform;
  const arch = options.arch ?? "x64";
  const archive = options.archive ?? completeArchive;
  const asset =
    options.asset === undefined ? yield* releaseAsset(archive, platform) : options.asset;
  const managedDirectory = path.join(baseDir, "tools", "antigravity-acp", `${platform}-${arch}`);
  if (options.previous) {
    yield* writeRelease(managedDirectory, {
      ...(yield* releaseAsset(archive, platform)),
      sha256: previousReleaseId,
      version: previousVersion,
    });
  }
  const stagingReleased = yield* Deferred.make<void>();
  const requests: string[] = [];
  const validations: Array<{
    executable: AntigravityInstallation.AntigravityExecutable;
    version: string;
  }> = [];
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
  const installation = yield* AntigravityInstallation.makeAntigravityInstallation({
    baseDir,
    ...(options.native ? {} : { releaseAsset: asset }),
    ...(options.updateChecksEnabled === undefined
      ? {}
      : { updateChecksEnabled: options.updateChecksEnabled }),
    ...(options.useDefaultValidation
      ? {}
      : {
          validate: (executable: AntigravityInstallation.AntigravityExecutable, version: string) =>
            Effect.sync(() => validations.push({ executable, version })).pipe(
              Effect.andThen(options.validate?.(executable, version) ?? Effect.void),
            ),
        }),
  }).pipe(
    options.spawner
      ? Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner)
      : (effect) => effect,
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, arch),
    Effect.provideService(HostProcess.Environment, { PATH: options.path ?? "" }),
    Effect.provideService(ModelManifest.ModelManifest, {
      current: options.manifest ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshOnDemand: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.suspend(() => {
          requests.push(request.url);
          if (request.url.includes("/manifests/")) {
            return Effect.gen(function* () {
              yield* options.beforeManifest ?? Effect.void;
              const version = options.nativeVersion ?? "1.5.7";
              const folder = platform === "win32" ? "windows-x64" : "linux-x64";
              const manifest = {
                version,
                url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-123/${folder}/cli_${platform === "win32" ? "windows_x64.exe" : "linux_x64.tar.gz"}`,
                sha512: Hex.encode(yield* digest.digest(Digest.sha512, archive).pipe(Effect.orDie)),
              };
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(options.nativeManifest?.(manifest) ?? manifest)),
              );
            });
          }
          if (options.connectTimeout) {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("Connect Timeout Error (attempted address: dl.google.com:443)"),
                }),
              }),
            );
          }
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
          return Effect.succeed(
            Object.defineProperty(response, "stream", {
              value:
                options.body ??
                Stream.make(
                  archive.subarray(0, 31),
                  archive.subarray(31, 149),
                  archive.subarray(149),
                ),
            }),
          );
        }),
      ),
    ),
  );
  return { installation, fs, path, baseDir, requests, validations, stagingReleased };
});

const terminalState = (installation: AntigravityInstallation.AntigravityInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const expectPreviousRelease = Effect.fn("test.expectPreviousAntigravityRelease")(function* (
  installation: AntigravityInstallation.AntigravityInstallation["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* installation.resolve();
  expect(resolved.version).toBe(previousVersion);
  expect(resolved.managedVersionDirectory).toBe(
    path.join(installation.managedDirectory, "versions", previousReleaseId),
  );
  expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
  expect(yield* fs.readFileString(resolved.harnessPath!)).toBe(harnessContents);
  expect((yield* installation.state).installedVersion).toBe(previousVersion);
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Antigravity installation", (it) => {
  it.effect.each([...new Set(["win32", hostPlatform])] as NodeJS.Platform[])(
    "migrates the legacy managed runtime to the native CLI on %s and retains the old release",
    (platform) =>
      Effect.gen(function* () {
        const archive =
          platform === "win32"
            ? Buffer.from(serverContents)
            : Buffer.from(
                "H4sIAAAAAAACE+3RMQ7CQAwEQNe8Ik8wgYj3XIFQCiiOCxK/56CJRA9CYqZZrxsXLpc2n2q5ze0en5LdYZpe2b1n5rhf5+d+m+MuY8j4guXaSu3n4z+V9f9DXXo5HzcBAAAAAAAAAADAz3sA56lbdQAoAAA=",
                "base64",
              );
        const { installation, validations, requests, fs, baseDir, stagingReleased } =
          yield* makeHarness({ native: true, archive, platform, previous: true });
        yield* installation.start;
        expect(yield* terminalState(installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        yield* Deferred.await(stagingReleased);
        const resolved = yield* installation.resolve();
        expect(resolved).toMatchObject({ source: "managed", version: "1.5.7", harnessPath: null });
        expect(validations[0]?.executable.harnessPath).toBeNull();
        expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
        expect(requests.some((url) => url.includes("/manifests/"))).toBe(true);
        const restarted = yield* makeHarness({
          baseDir,
          native: true,
          archive,
          platform,
          nativeVersion: "1.5.6",
        });
        expect(yield* restarted.installation.start).toMatchObject({
          phase: "verifying",
          message: "Checking the installed runtime.",
        });
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        expect(restarted.requests.filter((url) => url.includes("storage.googleapis.com"))).toEqual(
          [],
        );
        expect((yield* restarted.installation.resolve()).executablePath).toBe(
          resolved.executablePath,
        );
      }),
  );

  // These tar fixtures exercise the POSIX extraction path; Windows downloads one executable.
  it.effect.skipIf(hostPlatform === "win32")(
    "rejects unsafe native tar members before activation",
    () =>
      Effect.gen(function* () {
        for (const archive of [
          "H4sIAAAAAAACE+3OMQqDQBAFUI/iCYxZJPdZMIRtFHQN5PYOKbW2EN5j4P9iYCZPtXyW/C3111ylD69h+Gc45rk/U4r1NnXdI2be6lrG90XPbWvNS5xvAAAAAAAAAAAA4D523kNDtgAoAAA=",
          "H4sIAAAAAAACE+3RMQ7CMBAEQNe8Ii8IBhzxHhcIpYDCcSLxewwNiJ4IiZlmb6+54vp+m691PJe8jPUWviI2x2F4ZvOZMe7Ta37sdzGlQ+hiWME81Vza+fCf3p7flbmVy2kTAAAAAAAAAAAA+Hl3jhn2/wAoAAA=",
          "H4sIAAAAAAACE+3TPQrCQBAG0K09RY4wRoPn2UJCClOsG8Hbu6YJ2CtI3mvmp5li+PJcp7Hkx1Sf6VuiuQzDWpvPGtGft/69P0Z/itRF+oHlXnNp59M+5e3/XVnacLseEnv8v/zLv/wDAAAAAAAAAPyZF/c+VksAKAAA",
        ]) {
          const { installation, validations } = yield* makeHarness({
            native: true,
            archive: Buffer.from(archive, "base64"),
            platform: "linux",
            previous: true,
          });
          yield* installation.start;
          expect((yield* terminalState(installation)).phase).toBe("failed");
          expect(validations).toEqual([]);
          yield* expectPreviousRelease(installation);
        }
      }),
  );

  it.effect.each([true, false])(
    "respects background update checks (%s) while allowing explicit installation",
    (enabled) =>
      Effect.gen(function* () {
        const { installation, requests } = yield* makeHarness({
          native: true,
          archive: Buffer.from(serverContents),
          platform: "win32",
          updateChecksEnabled: Effect.succeed(enabled),
        });
        yield* installation.checkForUpdate;
        if (enabled) {
          yield* installation.changes.pipe(
            Stream.filter((value) => value.version === "1.5.7"),
            Stream.runHead,
          );
          yield* installation.state;
          expect(requests).toHaveLength(1);
        } else {
          yield* installation.changes.pipe(Stream.runHead);
          expect(requests).toEqual([]);
        }
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
      }),
  );

  it.effect("keeps withdrawn native releases from activating or launching", () =>
    Effect.gen(function* () {
      let withdrawn = false;
      const manifest = Effect.sync(() =>
        withdrawn
          ? ({
              ...ModelManifest.BUNDLED_MODEL_MANIFEST,
              compatibility: [
                {
                  driver: "antigravity",
                  t3CodeRange: ">=0.0.42",
                  ranges: [{ range: ">=1.5.7", status: "broken" }],
                },
              ],
            } satisfies ModelManifest.ModelManifestData)
          : ModelManifest.BUNDLED_MODEL_MANIFEST,
      );
      const first = yield* makeHarness({
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
        previous: true,
        manifest,
        validate: () =>
          Effect.sync(() => {
            withdrawn = true;
          }),
      });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).phase).toBe("failed");
      yield* expectPreviousRelease(first.installation);
      withdrawn = false;
      const retry = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
        manifest,
      });
      yield* retry.installation.start;
      expect((yield* terminalState(retry.installation)).phase).toBe("succeeded");
      withdrawn = true;
      expect(yield* retry.installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      expect(yield* retry.installation.start.pipe(Effect.flip)).toMatchObject({
        operation: "start",
      });
      const recovery = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.6",
        archive: Buffer.from("recovery runtime"),
        platform: "win32",
        manifest,
      });
      yield* recovery.installation.checkForUpdate;
      expect(yield* recovery.installation.state).toMatchObject({
        installedVersion: "1.5.7",
        version: "1.5.6",
      });
      yield* recovery.installation.start;
      expect(yield* terminalState(recovery.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.6",
      });
    }),
  );

  it.effect("discovers subsequent native releases from Google's CLI channel", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness({
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
      });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).phase).toBe("succeeded");
      const initialPath = (yield* first.installation.resolve()).executablePath;
      const next = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.8",
        archive: Buffer.from("next runtime"),
        platform: "win32",
      });
      yield* next.installation.start;
      expect(yield* terminalState(next.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.8",
      });
      const nextPath = (yield* next.installation.resolve()).executablePath;
      expect(nextPath).not.toBe(initialPath);
      const republished = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.8",
        archive: Buffer.from("republished runtime"),
        platform: "win32",
      });
      yield* republished.installation.start;
      expect((yield* terminalState(republished.installation)).phase).toBe("succeeded");
      expect((yield* republished.installation.resolve()).executablePath).not.toBe(nextPath);
      const offline = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeManifest: () => ({}),
        archive: Buffer.from("unused"),
        platform: "win32",
      });
      yield* offline.installation.start;
      expect(yield* terminalState(offline.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.8",
      });
      expect(offline.requests.filter((url) => url.includes("storage.googleapis.com"))).toEqual([]);
    }),
  );

  it.effect.each([
    {
      name: "invalid checksum",
      change: (manifest: { version: string; url: string; sha512: string }) => ({
        ...manifest,
        sha512: "0".repeat(128),
      }),
    },
    {
      name: "foreign download",
      change: (manifest: { version: string; url: string; sha512: string }) => ({
        ...manifest,
        url: "https://example.com/agy.exe",
      }),
    },
  ])("rejects a native $name and preserves the legacy release", ({ change }) =>
    Effect.gen(function* () {
      const { installation, validations } = yield* makeHarness({
        native: true,
        nativeManifest: change,
        archive: Buffer.from(serverContents),
        platform: "win32",
        previous: true,
      });
      const result = yield* Effect.result(installation.start);
      if (result._tag === "Success")
        expect((yield* terminalState(installation)).phase).toBe("failed");
      expect(validations).toEqual([]);
      yield* expectPreviousRelease(installation);
    }),
  );

  it.effect("reports missing Node before downloading the standalone provider runtime", () =>
    Effect.gen(function* () {
      const { installation, requests, validations } = yield* makeHarness();
      yield* installation.start;
      expect(yield* terminalState(installation)).toMatchObject({
        phase: "failed",
        message: expect.stringContaining("Install Node.js"),
      });
      expect(requests).toEqual([]);
      expect(validations).toEqual([]);
    }).pipe(Effect.provideService(HostProcess.IsExecutable, true)),
  );

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
      expect(yield* fs.readFileString(validation.executable.harnessPath!)).toBe(harnessContents);

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
      expect(path.dirname(selected.harnessPath!)).toBe(path.dirname(selected.executablePath));
      expect(yield* fs.readFileString(selected.executablePath)).toBe(serverContents);
      expect(yield* fs.readFileString(selected.harnessPath!)).toBe(harnessContents);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        expect.arrayContaining([previousReleaseId, (yield* releaseAsset()).sha256]),
      );
      expect(requests).toEqual([(yield* releaseAsset()).url]);
    }),
  );

  it.effect("accepts an encoded Content-Length when the body is compressed", () =>
    Effect.gen(function* () {
      // dl.google.com reports the gzip-encoded size; byte and hash checks use the decoded stream.
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
    { name: "checksum mismatch", completeAsset: { sha256: "2".repeat(64) } },
    { name: "short download", archive: completeArchive.subarray(0, -1), completeAsset: {} },
    {
      name: "oversized download",
      archive: Buffer.concat([completeArchive, Buffer.from("extra")]),
      completeAsset: {},
    },
    { name: "wrong Content-Length", contentLength: completeArchive.byteLength + 1 },
    { name: "missing harness", archive: Buffer.from(zipFixtures.missingHarness, "base64") },
    { name: "duplicate executable", archive: Buffer.from(zipFixtures.duplicate, "base64") },
    { name: "path traversal", archive: Buffer.from(zipFixtures.traversal, "base64") },
    { name: "symbolic link", archive: Buffer.from(zipFixtures.symlink, "base64") },
    { name: "oversized member", archive: Buffer.from(zipFixtures.oversizedMember, "base64") },
  ])("rejects $name before runtime validation", ({ completeAsset, ...options }) =>
    Effect.gen(function* () {
      const asset =
        completeAsset === undefined ? undefined : { ...(yield* releaseAsset()), ...completeAsset };
      const { installation, validations, stagingReleased, fs, path } = yield* makeHarness({
        ...options,
        ...(asset === undefined ? {} : { asset }),
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

  it.effect(
    "names the connection failure instead of disk space when the download cannot connect",
    () =>
      Effect.gen(function* () {
        const { installation, validations } = yield* makeHarness({ connectTimeout: true });
        yield* installation.start;
        const state = yield* terminalState(installation);
        expect(state.phase).toBe("failed");
        expect(state.message).not.toMatch(/disk space/i);
        expect(state.message).toMatch(/connect|network|download/i);
        expect(validations).toEqual([]);
      }),
  );

  // The runtime's own abort is a real process; Windows has no POSIX sh.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "explains that the linux-arm64 runtime needs 4 KiB pages when it aborts on a 16 KiB kernel",
    () =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Google's linux-arm64 build aborts like this on Asahi and Raspberry Pi 5 kernels.
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) &&
          String(command.command).endsWith(executableName)
            ? realSpawner.spawn(
                ChildProcess.make(
                  "sh",
                  [
                    "-c",
                    "echo 'F1111 11:50:12.383176 page-size.cc:19] Check failed: sysconf(_SC_PAGE_SIZE) == kPageSize (16384 vs. 4096) Compile-time page size does not match runtime page size' >&2; kill -ABRT $$",
                  ],
                  { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
                ),
              )
            : realSpawner.spawn(command),
        );
        const { installation } = yield* makeHarness({
          arch: "arm64",
          useDefaultValidation: true,
          spawner,
        });
        yield* installation.start;
        const state = yield* terminalState(installation);
        expect(state.phase).toBe("failed");
        expect(state.message).toMatch(/page/i);
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses a 16 KiB-page linux-arm64 kernel before downloading the runtime",
    () =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.command === "getconf"
            ? realSpawner.spawn(ChildProcess.make("sh", ["-c", "echo 16384"], command.options))
            : realSpawner.spawn(command),
        );
        const { installation, requests } = yield* makeHarness({ arch: "arm64", spawner });
        yield* installation.start;
        const state = yield* terminalState(installation);
        expect(state.phase).toBe("failed");
        expect(state.message).toMatch(/4 KiB/);
        expect(requests).toEqual([]);
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
            (stage === "extract" && target.endsWith(executableName))
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
              phase === "extracting" && target.endsWith(executableName)
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

  // A simulated Mac install needs POSIX execute bits, which Windows files lack.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "re-signs the Intel Mac runtime ad hoc and records the signed sizes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const signed: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command))
              return yield* Effect.die("Unexpected spawn.");
            const args = command.args.map(String);
            signed.push([String(command.command), ...args]);
            // codesign rewrites the signature, which changes each file's size.
            for (const file of args.slice(3)) {
              yield* fs.writeFileString(file, "signature", { flag: "a" });
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(900_000_301),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
          }).pipe(Effect.orDie),
        );
        const { installation, validations } = yield* makeHarness({
          platform: "darwin",
          arch: "x64",
          spawner,
        });
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        const validated = validations[0]?.executable;
        expect(signed).toEqual([
          [
            "/usr/bin/codesign",
            "--force",
            "--sign",
            "-",
            validated?.executablePath,
            validated?.harnessPath,
          ],
        ]);
        const selected = yield* installation.resolve();
        expect(yield* fs.readFileString(selected.executablePath)).toBe(
          `${serverContents}signature`,
        );
      }),
  );

  // The mocked Linux PATH walk needs POSIX paths; Windows temp paths contain colons.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "accepts the agy CLI without a harness sibling but still requires one for other binaries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-agy-cli-test-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const cliDirectory = path.join(baseDir, "cli");
        yield* fs.makeDirectory(cliDirectory);
        const cli = path.join(cliDirectory, "antigravity");
        const alias = path.join(cliDirectory, "agy");
        const other = path.join(cliDirectory, "custom-acp");
        yield* fs.writeFileString(cli, "cli", { mode: 0o755 });
        yield* fs.symlink(cli, alias);
        yield* fs.writeFileString(other, "other", { mode: 0o755 });
        const { installation } = yield* makeHarness({ baseDir });

        expect(yield* installation.resolve(cli)).toMatchObject({
          executablePath: cli,
          harnessPath: null,
          source: "override",
          version: null,
        });
        expect(yield* installation.resolve(alias)).toMatchObject({
          executablePath: alias,
          harnessPath: null,
        });
        expect(yield* installation.resolve("agy", { PATH: cliDirectory })).toMatchObject({
          executablePath: alias,
          harnessPath: null,
        });
        expect(yield* installation.resolve(other).pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });

        // Version-manager shims dispatch by their invoked name, so the shim path is what runs.
        const shims = path.join(baseDir, "shims");
        const mise = path.join(baseDir, "mise");
        yield* fs.makeDirectory(shims);
        yield* fs.writeFileString(mise, "mise", { mode: 0o755 });
        yield* fs.symlink(mise, path.join(shims, "agy"));
        expect(yield* installation.resolve("agy", { PATH: shims })).toMatchObject({
          executablePath: path.join(shims, "agy"),
          harnessPath: null,
        });

        const { installation: windows } = yield* makeHarness({ baseDir, platform: "win32" });
        for (const name of ["agy.EXE", "agy.cmd"]) {
          const windowsDirectory = path.join(baseDir, `windows-${name}`);
          yield* fs.makeDirectory(windowsDirectory);
          yield* fs.writeFileString(path.join(windowsDirectory, name), "cli");
          const selected = yield* windows.resolve("agy", { PATH: windowsDirectory });
          expect(selected.harnessPath).toBeNull();
          expect((yield* fs.realPath(selected.executablePath)).toLowerCase()).toBe(
            (yield* fs.realPath(path.join(windowsDirectory, name))).toLowerCase(),
          );
        }
      }),
  );

  // The mocked Linux PATH walk needs POSIX paths; Windows temp paths contain colons.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "honors explicit paths and reports invalid overrides without falling back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-agy-path-test-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const externalDirectory = path.join(baseDir, "external");
        const externalExecutable = path.join(externalDirectory, executableName);
        const externalHarness = path.join(externalDirectory, harnessName);
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
        expect(yield* installation.resolve(executableName)).toMatchObject({
          source: "override",
        });
        expect(
          yield* installation
            .resolve(`~/external/${executableName}`)
            .pipe(Effect.provideService(HostProcess.HomeDirectory, baseDir)),
        ).toMatchObject({ source: "override", executablePath: externalExecutable });
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
          yield* isolated.installation.resolve(executableName, { PATH: externalDirectory }),
        ).toMatchObject({ source: "override", executablePath: externalExecutable });

        const incompleteDirectory = path.join(baseDir, "incomplete");
        yield* fs.makeDirectory(incompleteDirectory);
        yield* fs.writeFileString(path.join(incompleteDirectory, executableName), "no harness", {
          mode: 0o755,
        });
        const shadowedPath = { PATH: `${incompleteDirectory}:${externalDirectory}` };
        expect(yield* isolated.installation.resolve(undefined, shadowedPath)).toMatchObject({
          source: "path",
          executablePath: externalExecutable,
        });
        expect(yield* isolated.installation.resolve(executableName, shadowedPath)).toMatchObject({
          source: "override",
          executablePath: externalExecutable,
        });
      }),
  );

  it.effect("keeps leased releases available while new sessions resolve the new release", () =>
    Effect.gen(function* () {
      const manifestEntered = yield* Deferred.make<void>();
      const releaseManifest = yield* Deferred.make<void>();
      const { installation, fs, stagingReleased } = yield* makeHarness({
        native: true,
        platform: "win32",
        archive: Buffer.from(serverContents),
        previous: true,
        beforeManifest: Deferred.succeed(manifestEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseManifest)),
        ),
      });
      const processScope = yield* Scope.make();
      const oldExecutable = yield* installation.acquire().pipe(Scope.provide(processScope));
      const starting = yield* installation.start.pipe(Effect.forkScoped);
      yield* Deferred.await(manifestEntered);
      const concurrent = yield* installation.acquire().pipe(Scope.provide(processScope));
      expect(concurrent.executablePath).toBe(oldExecutable.executablePath);
      yield* Deferred.succeed(releaseManifest, undefined);
      yield* Fiber.join(starting);
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      yield* Deferred.await(stagingReleased);
      const current = yield* installation.resolve();
      expect(current.version).toBe("1.5.7");
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
        yield* fs.remove(previous.harnessPath!);
        const externalDirectory = path.join(baseDir, "external");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(path.join(externalDirectory, executableName), "external server", {
          mode: 0o755,
        });
        yield* fs.writeFileString(path.join(externalDirectory, harnessName), "external harness", {
          mode: 0o755,
        });
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
        const externalExecutable = path.join(externalDirectory, executableName);
        const externalHarness = path.join(externalDirectory, harnessName);
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
        const asset = yield* releaseAsset(archive, "win32");
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
