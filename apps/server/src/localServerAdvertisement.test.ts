import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, LocalServerAdvertisement } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import {
  resolveAdvertisementRefreshDelayMs,
  startLocalServerAdvertisement,
} from "./localServerAdvertisement.ts";

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServerAdvertisement));

it("refreshes one minute before expiry with a bounded minimum delay", () => {
  expect(
    resolveAdvertisementRefreshDelayMs({
      nowMs: 1_000,
      pairingExpiresAt: "1970-01-01T00:05:01.000Z",
    }),
  ).toBe(240_000);
  expect(
    resolveAdvertisementRefreshDelayMs({
      nowMs: 1_000,
      pairingExpiresAt: "1970-01-01T00:00:02.000Z",
    }),
  ).toBe(1_000);
  expect(
    resolveAdvertisementRefreshDelayMs({
      nowMs: 1_000,
      pairingExpiresAt: "not-a-date",
    }),
  ).toBe(1_000);
});

it.effect("publishes, rotates, and removes a private loopback advertisement", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-server-advertisement-test-",
    });
    const baseConfig = yield* Effect.gen(function* () {
      return yield* ServerConfig.ServerConfig;
    }).pipe(Effect.provide(ServerConfig.layerTest(runtimeDirectory, runtimeDirectory)));
    const config = ServerConfig.ServerConfig.of({
      ...baseConfig,
      host: "127.0.0.1",
      startupPresentation: "headless",
    });
    const revokedIds: Array<string> = [];
    const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      issueStartupPairingCredential: () =>
        Effect.succeed({
          id: "rotated-id",
          credential: "ROTATED",
          expiresAt: DateTime.makeUnsafe("1970-01-01T00:07:00.000Z"),
        }),
      revokePairingLink: (id) =>
        Effect.sync(() => {
          revokedIds.push(id);
          return true;
        }),
    });
    const environment = ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-local")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment-local"),
        label: "Local server",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.28",
        capabilities: { repositoryIdentity: true },
      }),
    });
    const advertisementScope = yield* Scope.make();

    yield* startLocalServerAdvertisement({
      initialAccessInfo: {
        pairingCredentialId: "initial-id",
        connectionString: "http://127.0.0.1:3773",
        token: "INITIAL",
        pairingUrl: "http://127.0.0.1:3773/pair#token=INITIAL",
        pairingExpiresAt: "1970-01-01T00:02:00.000Z",
      },
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
    }).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
      Effect.provide(authLayer),
      Scope.provide(advertisementScope),
    );
    yield* Effect.sleep("20 millis").pipe(TestClock.withLive);

    const directory = path.join(runtimeDirectory, "t3code", "servers");
    const entries = yield* fileSystem.readDirectory(directory);
    assert.strictEqual(entries.length, 1);
    const recordPath = path.join(directory, entries[0]!);
    expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
    expect((yield* fileSystem.stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(
      (yield* decodeRecord(yield* fileSystem.readFileString(recordPath))).pairingUrl,
    ).toContain("token=INITIAL");

    yield* TestClock.adjust("1 minute");
    yield* Effect.sleep("20 millis").pipe(TestClock.withLive);
    expect(
      (yield* decodeRecord(yield* fileSystem.readFileString(recordPath))).pairingUrl,
    ).toContain("token=ROTATED");
    expect(revokedIds).toContain("initial-id");

    yield* Scope.close(advertisementScope, Exit.void);
    expect(yield* fileSystem.exists(recordPath)).toBe(false);
    expect(revokedIds).toContain("rotated-id");
  }).pipe(Effect.provide(NodeServices.layer)),
);
