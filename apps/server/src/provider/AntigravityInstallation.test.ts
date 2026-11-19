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
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { type AntigravityCliReleaseAsset } from "./antigravityCliRelease.ts";

const serverContents = "antigravity runtime\n";
const previousReleaseId = "1".repeat(64);
const previousVersion = "1.5.3";
const assetVersion = "1.5.5";
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// One regular member, `antigravity`, holding serverContents.
const cliTarball = Buffer.from(
  "H4sIAAAAAAACE+3RMQ7CQAwEQNe8Ik8wgYj3XIFQCiiOCxK/56CJRA9CYqZZrxsXLpc2n2q5ze0en5LdYZpe2b1n5rhf5+d+m+MuY8j4guXaSu3n4z+V9f9DXXo5HzcBAAAAAAAAAADAz3sA56lbdQAoAAA=",
  "base64",
);

// Linux platform mocks cannot enforce POSIX exec bits on NTFS; use the host platform.
const hostPlatform: NodeJS.Platform =
  HostProcess.Platform.defaultValue() === "win32" ? "win32" : "linux";
const completeArchive = hostPlatform === "win32" ? Buffer.from(serverContents) : cliTarball;
const executableName = hostPlatform === "win32" ? "agy.exe" : "antigravity";

const releaseAsset = Effect.fn("test.antigravityReleaseAsset")(function* (
  archive: Uint8Array = completeArchive,
  platform: NodeJS.Platform = hostPlatform,
) {
  const digest = yield* Digest.Digest;
  return {
    version: assetVersion,
    url: "https://storage.googleapis.com/antigravity-test",
    sha512: Hex.encode(yield* digest.digest(Digest.sha512, archive).pipe(Effect.orDie)),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  } satisfies AntigravityCliReleaseAsset;
});

const writeRelease = Effect.fn("test.writeAntigravityRelease")(function* (
  managedDirectory: string,
  release: { readonly releaseId: string; readonly version: string; readonly name: string },
  active = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(managedDirectory, "versions", release.releaseId);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, release.name), serverContents, { mode: 0o755 });
  yield* fs.writeFileString(
    path.join(directory, ".install-complete.json"),
    encodeJsonString({
      releaseId: release.releaseId,
      version: release.version,
      executable: { name: release.name, bytes: Buffer.byteLength(serverContents) },
    }),
  );
  if (active) {
    yield* fs.writeFileString(
      path.join(managedDirectory, "active.json"),
      encodeJsonString({ releaseId: release.releaseId }),
    );
  }
});

const assetRelease = (asset: AntigravityCliReleaseAsset) => ({
  releaseId: asset.sha512.slice(0, 64),
  version: asset.version,
  name: asset.executable.name,
});

interface HarnessOptions {
  readonly baseDir?: string;
  readonly asset?: AntigravityCliReleaseAsset | null;
  readonly archive?: Buffer;
  readonly body?: Stream.Stream<Uint8Array> | undefined;
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
      releaseId: previousReleaseId,
      version: previousVersion,
      name: platform === "win32" ? "agy.exe" : "antigravity",
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
          const response = HttpClientResponse.fromWeb(request, new Response(null));
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
  expect((yield* installation.state).installedVersion).toBe(previousVersion);
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Antigravity installation", (it) => {
  it.effect.each([...new Set(["win32", hostPlatform])] as NodeJS.Platform[])(
    "replaces a managed runtime from before the Antigravity CLI on %s",
    (platform) =>
      Effect.gen(function* () {
        const archive = platform === "win32" ? Buffer.from(serverContents) : cliTarball;
        const { installation, validations, requests, fs, path, baseDir, stagingReleased } =
          yield* makeHarness({ native: true, archive, platform });
        // A 1.4.x install recorded agy_acp_server with its localharness_external sibling.
        const legacyId = "2".repeat(64);
        const legacyDirectory = path.join(installation.managedDirectory, "versions", legacyId);
        yield* fs.makeDirectory(legacyDirectory, { recursive: true });
        yield* fs.writeFileString(
          path.join(legacyDirectory, "agy_acp_server.par"),
          serverContents,
          {
            mode: 0o755,
          },
        );
        yield* fs.writeFileString(
          path.join(legacyDirectory, ".install-complete.json"),
          encodeJsonString({
            releaseId: legacyId,
            version: "1.4.5",
            executable: { name: "agy_acp_server.par", bytes: Buffer.byteLength(serverContents) },
            harness: { name: "localharness_external", bytes: 1 },
          }),
        );
        yield* fs.writeFileString(
          path.join(installation.managedDirectory, "active.json"),
          encodeJsonString({ releaseId: legacyId }),
        );
        expect(yield* installation.resolve().pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
          detail: expect.stringContaining("Update it in Antigravity setup"),
        });
        yield* installation.start;
        expect(yield* terminalState(installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        yield* Deferred.await(stagingReleased);
        const resolved = yield* installation.resolve();
        expect(resolved).toMatchObject({ source: "managed", version: "1.5.7" });
        expect(validations).toHaveLength(1);
        expect(yield* fs.exists(legacyDirectory)).toBe(false);
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
  ])("rejects a native $name and preserves the previous release", ({ change }) =>
    Effect.gen(function* () {
      const { installation, validations, requests } = yield* makeHarness({
        native: true,
        nativeManifest: change,
        archive: Buffer.from(serverContents),
        platform: "win32",
        previous: true,
      });
      const result = yield* Effect.result(installation.start);
      // Without an acceptable release, start re-verifies the installed one.
      if (result._tag === "Success") yield* terminalState(installation);
      expect(validations.map(({ version }) => version)).not.toContain("1.5.7");
      expect(requests.some((url) => url.startsWith("https://example.com"))).toBe(false);
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

  it.effect("verifies the executable before activating a streamed download", () =>
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
      expect(validation?.version).toBe(assetVersion);
      if (!validation) return yield* Effect.die("Expected runtime validation.");
      expect(yield* fs.readFileString(validation.executable.executablePath)).toBe(serverContents);

      yield* Deferred.succeed(finishValidation, undefined);
      expect(yield* terminalState(installation)).toMatchObject({
        phase: "succeeded",
        operationId: started.operationId,
        installedVersion: assetVersion,
      });
      yield* Deferred.await(stagingReleased);
      const selected = yield* installation.resolve();
      expect(selected).toMatchObject({ source: "managed", version: assetVersion });
      expect(yield* fs.readFileString(selected.executablePath)).toBe(serverContents);
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        [assetRelease(yield* releaseAsset()).releaseId],
      );
      expect(requests).toEqual([(yield* releaseAsset()).url]);
    }),
  );

  it.effect.each([
    { name: "checksum mismatch", completeAsset: { sha512: "2".repeat(128) } },
    { name: "short download", archive: completeArchive.subarray(0, -1), completeAsset: {} },
    {
      name: "oversized download",
      archive: Buffer.concat([completeArchive, Buffer.from("extra")]),
      completeAsset: {},
    },
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

  it.effect.each(["downloaded", "existing", "concurrent"] as const)(
    "reports a verification timeout for a %s runtime without changing the active release",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const asset = yield* releaseAsset();
        const entered = yield* Deferred.make<void>();
        let verificationCount = 0;
        const { installation, stagingReleased, requests, validations } = yield* makeHarness({
          previous: true,
          asset,
          fileSystem: FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              source === "concurrent" && path.basename(path.dirname(to)) === "versions"
                ? writeRelease(path.dirname(path.dirname(to)), assetRelease(asset), false).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "AlreadyExists",
                          module: "FileSystem",
                          method: "rename",
                          pathOrDescriptor: to,
                        }),
                      ),
                    ),
                  )
                : fs.rename(from, to),
          }),
          validate: () =>
            Effect.suspend(() =>
              source === "concurrent" && verificationCount++ === 0
                ? Effect.void
                : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            ),
        });
        if (source === "existing") {
          yield* writeRelease(installation.managedDirectory, assetRelease(asset), false);
        }
        yield* installation.start;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("90 seconds");
        expect(yield* terminalState(installation)).toMatchObject({
          phase: "failed",
          message:
            "Antigravity runtime verification timed out after 90 seconds. Check this environment's server logs for startup errors, then retry installation.",
        });
        if (source !== "existing") yield* Deferred.await(stagingReleased);
        yield* expectPreviousRelease(installation);
        expect(requests).toHaveLength(source === "existing" ? 0 : 1);
        expect(validations).toHaveLength(source === "concurrent" ? 2 : 1);
      }),
  );

  // Windows hosts copy the downloaded executable, so no extraction stream exists there.
  it.effect.each(
    hostPlatform === "win32"
      ? (["download", "active pointer"] as const)
      : (["download", "extract", "active pointer"] as const),
  )("preserves the old runtime after an ENOSPC error during %s", (stage) =>
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
          (stage === "download" && target.endsWith("download")) ||
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

  it.effect.each(
    hostPlatform === "win32"
      ? (["downloading", "verifying"] as const)
      : (["downloading", "extracting", "verifying"] as const),
  )("cancels during %s and waits for open resources to close", (phase) =>
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
                  .pipe(Sink.mapInputEffect((chunk: Uint8Array) => barrier.pipe(Effect.as(chunk))))
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
      expect(yield* fs.readDirectory(path.join(installation.managedDirectory, "versions"))).toEqual(
        [previousReleaseId],
      );
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
          installedVersion: assetVersion,
        });
        const current = testCase.restart ? yield* installation.start : first;
        if (testCase.restart) yield* Deferred.await(nextValidationStarted);

        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.await(yield* Deferred.await(firstWorker));
        yield* Deferred.await(stagingReleased);
        expect(yield* installation.state).toMatchObject({
          operationId: current.operationId,
          phase: testCase.restart ? "verifying" : "succeeded",
          installedVersion: assetVersion,
        });
        expect((yield* installation.resolve()).version).toBe(assetVersion);

        yield* Deferred.succeed(releaseNextValidation, undefined);
        expect(yield* terminalState(installation)).toMatchObject({
          operationId: current.operationId,
          phase: "succeeded",
          installedVersion: assetVersion,
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

  // The mocked Linux PATH walk needs POSIX paths; Windows temp paths contain colons.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "accepts only the agy CLI as a custom or PATH executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-agy-cli-test-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const cliDirectory = path.join(baseDir, 'cli" ');
        yield* fs.makeDirectory(cliDirectory);
        const siblingDirectory = path.join(baseDir, 'cli"');
        yield* fs.makeDirectory(siblingDirectory);
        yield* fs.writeFileString(path.join(siblingDirectory, "agy"), "other cli", { mode: 0o755 });
        const cli = path.join(cliDirectory, "antigravity");
        const alias = path.join(cliDirectory, "agy");
        const other = path.join(cliDirectory, "custom-acp");
        yield* fs.writeFileString(cli, "cli", { mode: 0o755 });
        yield* fs.symlink(cli, alias);
        yield* fs.writeFileString(other, "other", { mode: 0o755 });
        const { installation } = yield* makeHarness({ baseDir });

        expect(yield* installation.resolve(cli)).toMatchObject({
          executablePath: cli,
          source: "override",
          version: null,
        });
        expect(yield* installation.resolve(alias)).toMatchObject({
          executablePath: alias,
        });
        expect(yield* installation.resolve("agy", { PATH: cliDirectory })).toMatchObject({
          executablePath: alias,
        });
        expect(yield* installation.resolve(undefined, { PATH: cliDirectory })).toMatchObject({
          executablePath: alias,
          source: "path",
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
        });

        const { installation: windows } = yield* makeHarness({ baseDir, platform: "win32" });
        for (const name of ["agy.EXE", "agy.cmd"]) {
          const windowsDirectory = path.join(baseDir, `windows-${name}`);
          yield* fs.makeDirectory(windowsDirectory);
          yield* fs.writeFileString(path.join(windowsDirectory, name), "cli");
          const selected = yield* windows.resolve("agy", { PATH: `"${windowsDirectory}"` });
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
        const externalExecutable = path.join(externalDirectory, "agy");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(externalExecutable, "external cli", { mode: 0o755 });
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
        expect(yield* installation.resolve("agy")).toMatchObject({ source: "override" });
        expect(
          yield* installation
            .resolve("~/external/agy")
            .pipe(Effect.provideService(HostProcess.HomeDirectory, baseDir)),
        ).toMatchObject({ source: "override", executablePath: externalExecutable });
        expect(
          yield* installation.resolve(path.join(baseDir, "missing")).pipe(Effect.flip),
        ).toMatchObject({
          operation: "resolve",
        });
        yield* expectPreviousRelease(installation);
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
          yield* isolated.installation.resolve("agy", { PATH: externalDirectory }),
        ).toMatchObject({ source: "override", executablePath: externalExecutable });
      }),
  );

  it.effect("keeps leased releases available while new sessions resolve the new release", () =>
    Effect.gen(function* () {
      const manifestEntered = yield* Deferred.make<void>();
      const releaseManifest = yield* Deferred.make<void>();
      const { installation, fs, baseDir, stagingReleased } = yield* makeHarness({
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
      yield* makeHarness({ native: true, platform: "win32", baseDir });
      expect(yield* fs.exists(oldExecutable.managedVersionDirectory!)).toBe(false);
      expect(yield* fs.readFileString(current.executablePath)).toBe(serverContents);
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
        yield* fs.remove(previous.executablePath);
        const externalDirectory = path.join(baseDir, "external");
        yield* fs.makeDirectory(externalDirectory);
        yield* fs.writeFileString(path.join(externalDirectory, "agy"), "external cli", {
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
          installedVersion: assetVersion,
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
        const externalExecutable = path.join(externalDirectory, "agy");
        const profilePath = path.join(profileDirectory, "preferences.json");
        yield* fs.writeFileString(externalExecutable, "external cli", { mode: 0o755 });
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
        expect(yield* fs.readFileString(externalExecutable)).toBe("external cli");
        expect(yield* fs.readFileString(profilePath)).toBe("{}");
      }),
  );

  it.effect(
    "reuses an immutable Windows release and preserves the pointer when rename is denied",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const archive = Buffer.from(serverContents);
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
        yield* writeRelease(installation.managedDirectory, assetRelease(asset), false);
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("failed");
        yield* expectPreviousRelease(installation);
        expect(renameTargets).toEqual([path.join(installation.managedDirectory, "active.json")]);

        denyPointerRename = false;
        yield* installation.start;
        expect((yield* terminalState(installation)).phase).toBe("succeeded");
        expect((yield* installation.resolve()).version).toBe(assetVersion);
        expect(requests).toEqual([]);
        expect(validations).toHaveLength(2);
        expect(renameTargets).toEqual([
          path.join(installation.managedDirectory, "active.json"),
          path.join(installation.managedDirectory, "active.json"),
        ]);
      }),
  );

  it.effect("publishes a Windows release once a transient EPERM on the release rename clears", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const archive = Buffer.from(zipFixtures.windows, "base64");
      const releaseRenameDenied = yield* Deferred.make<void>();
      let releaseRenameDenials = 3;
      const { installation } = yield* makeHarness({
        platform: "win32",
        archive,
        fileSystem: FileSystem.FileSystem.of({
          ...fs,
          rename: (source, target) =>
            Effect.suspend(() => {
              if (
                path.basename(path.dirname(target)) !== "versions" ||
                releaseRenameDenials === 0
              ) {
                return fs.rename(source, target);
              }
              releaseRenameDenials -= 1;
              return Deferred.succeed(releaseRenameDenied, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: source,
                      description: "EPERM: operation not permitted, rename",
                    }),
                  ),
                ),
              );
            }),
        }),
      });
      yield* installation.start;
      const terminal = yield* terminalState(installation).pipe(Effect.forkChild);
      yield* Deferred.await(releaseRenameDenied);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(terminal)).toMatchObject({
        phase: "succeeded",
        installedVersion: "fixture-new",
      });
      expect((yield* installation.resolve()).version).toBe("fixture-new");
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
