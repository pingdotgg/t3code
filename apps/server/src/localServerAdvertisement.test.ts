import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, LocalServerAdvertisement } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { startLocalServerAdvertisement } from "./localServerAdvertisement.ts";
import * as LocalServerDiscoveryState from "./localServerDiscoveryState.ts";

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServerAdvertisement));

const testEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-local")),
  getDescriptor: Effect.succeed({
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local server",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.28",
    capabilities: { repositoryIdentity: true },
  }),
});

const makeConfig = Effect.fn(function* (
  runtimeDirectory: string,
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
) {
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(runtimeDirectory, runtimeDirectory)),
  );
  return ServerConfig.ServerConfig.of({
    ...baseConfig,
    host: "127.0.0.1",
    startupPresentation: "headless",
    ...overrides,
  });
});

const runAdvertisement = Effect.fn(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly runtimeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly scope: Scope.Scope;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const discoveryState = yield* LocalServerDiscoveryState.LocalServerDiscoveryState;
  let advertisement = startLocalServerAdvertisement({
    listeningAddress: {
      _tag: "TcpAddress",
      hostname: "127.0.0.1",
      port: 3773,
    } satisfies HttpServer.Address,
    platform: input.platform ?? "linux",
    xdgRuntimeDirectory: input.runtimeDirectory,
  }).pipe(
    Effect.provideService(ServerConfig.ServerConfig, input.config),
    Effect.provideService(ServerEnvironment.ServerEnvironment, testEnvironment),
    Scope.provide(input.scope),
  );
  if (input.fileSystem !== undefined) {
    advertisement = advertisement.pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    );
  }
  yield* advertisement;
  return discoveryState;
});

it.effect("publishes a private, credential-free loopback advertisement exactly once", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-server-advertisement-test-",
    });
    const config = yield* makeConfig(runtimeDirectory);
    const advertisementScope = yield* Scope.make();

    const discoveryState = yield* runAdvertisement({
      config,
      runtimeDirectory,
      scope: advertisementScope,
    });

    const directory = path.join(runtimeDirectory, "t3code", "servers");
    const entries = yield* fileSystem.readDirectory(directory);
    assert.strictEqual(entries.length, 1);
    const recordPath = path.join(directory, entries[0]!);
    expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
    expect((yield* fileSystem.stat(recordPath)).mode & 0o777).toBe(0o600);

    const contents = yield* fileSystem.readFileString(recordPath);
    // The record must never carry a credential, so assert on the raw JSON too:
    // a schema decode would silently drop an excess property.
    expect(contents).not.toContain("pairingUrl");
    expect(contents).not.toContain("token");
    const record = yield* decodeRecord(contents);
    expect(record).toMatchObject({
      version: 1,
      pid: process.pid,
      httpBaseUrl: "http://127.0.0.1:3773/",
      environmentId: "environment-local",
      label: "Local server",
    });
    expect(recordPath).toBe(path.join(directory, `${record.instanceId}.json`));

    // Discovery is now active for the pairing endpoint.
    const active = yield* discoveryState.current;
    expect(active).toEqual({
      instanceId: record.instanceId,
      httpBaseUrl: "http://127.0.0.1:3773/",
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
    });

    yield* Scope.close(advertisementScope, Exit.void);
    expect(yield* fileSystem.exists(recordPath)).toBe(false);
    expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
    expect(yield* discoveryState.current).toBeNull();
  }).pipe(Effect.provide(Layer.mergeAll(LocalServerDiscoveryState.layer, NodeServices.layer))),
);

it.effect("activates before publication and rolls back when publication fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const discoveryState = yield* LocalServerDiscoveryState.LocalServerDiscoveryState;
    const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-server-advertisement-publication-failure-test-",
    });
    const config = yield* makeConfig(runtimeDirectory);
    const advertisementScope = yield* Scope.make();
    const publicationFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "chmod",
      pathOrDescriptor: runtimeDirectory,
    });
    let stateAtPublication: LocalServerDiscoveryState.LocalServerDiscoveryRecord | null = null;
    const failingFileSystem = FileSystem.FileSystem.of({
      ...fileSystem,
      rename: (from, to) =>
        Effect.gen(function* () {
          stateAtPublication = yield* discoveryState.current;
          yield* fileSystem.rename(from, to);
        }),
      chmod: (target, mode) =>
        String(target).endsWith(".json")
          ? Effect.fail(publicationFailure)
          : fileSystem.chmod(target, mode),
    });

    yield* runAdvertisement({
      config,
      runtimeDirectory,
      scope: advertisementScope,
      fileSystem: failingFileSystem,
    });

    expect(stateAtPublication).toMatchObject({
      httpBaseUrl: "http://127.0.0.1:3773/",
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
    });
    expect(yield* discoveryState.current).toBeNull();
    expect(
      yield* fileSystem.readDirectory(path.join(runtimeDirectory, "t3code", "servers")),
    ).toEqual([]);

    yield* Scope.close(advertisementScope, Exit.void);
  }).pipe(Effect.provide(Layer.mergeAll(LocalServerDiscoveryState.layer, NodeServices.layer))),
);

it.effect("stays inactive for non-linux, non-headless, and non-loopback servers", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cases = [
      { name: "darwin platform", platform: "darwin" as NodeJS.Platform, overrides: {} },
      {
        name: "browser startup presentation",
        platform: "linux" as NodeJS.Platform,
        overrides: { startupPresentation: "browser" as const },
      },
      {
        name: "wildcard host",
        platform: "linux" as NodeJS.Platform,
        overrides: { host: "0.0.0.0" },
      },
    ];

    for (const testCase of cases) {
      const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-advertisement-inactive-test-",
      });
      const config = yield* makeConfig(runtimeDirectory, testCase.overrides);
      const advertisementScope = yield* Scope.make();

      const discoveryState = yield* runAdvertisement({
        config,
        runtimeDirectory,
        platform: testCase.platform,
        scope: advertisementScope,
      });

      expect(
        yield* fileSystem.exists(path.join(runtimeDirectory, "t3code", "servers")),
        testCase.name,
      ).toBe(false);
      expect(yield* discoveryState.current, testCase.name).toBeNull();
      yield* Scope.close(advertisementScope, Exit.void);
    }
  }).pipe(Effect.provide(Layer.mergeAll(LocalServerDiscoveryState.layer, NodeServices.layer))),
);
