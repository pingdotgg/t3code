import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, LocalServerAdvertisement } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { make } from "./DesktopLocalServerDiscovery.ts";

const environmentId = EnvironmentId.make("environment-local");
const descriptor = {
  environmentId,
  label: "Local development server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.28",
  capabilities: { repositoryIdentity: true },
} as const;
const encodeRecord = Schema.encodeUnknownEffect(Schema.fromJsonString(LocalServerAdvertisement));

const makeRecord = (
  overrides: Partial<LocalServerAdvertisement> = {},
): LocalServerAdvertisement => ({
  version: 1,
  instanceId: "instance-local",
  pid: 1234,
  startedAt: "2026-01-01T00:00:00.000Z",
  httpBaseUrl: "http://127.0.0.1:3773/",
  pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
  pairingExpiresAt: "2099-01-01T00:00:00.000Z",
  environmentId,
  label: "Advertisement label",
  ...overrides,
});

it.effect("discovers private, live, identity-matched loopback advertisements", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-local-discovery-test-",
    });
    const advertisementDirectory = path.join(runtimeDirectory, "t3code", "servers");
    const recordPath = path.join(advertisementDirectory, "instance-local.json");
    yield* fileSystem.makeDirectory(advertisementDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.chmod(advertisementDirectory, 0o700);
    yield* fileSystem.writeFileString(recordPath, yield* encodeRecord(makeRecord()), {
      mode: 0o600,
    });
    yield* fileSystem.chmod(recordPath, 0o600);

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
    });
    const discovered = yield* discovery.discover;

    assert.strictEqual(discovered.length, 1);
    expect(discovered[0]?.environmentId).toBe(environmentId);
    expect(discovered[0]?.label).toBe(descriptor.label);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("ignores unsafe, expired, and identity-mismatched advertisements", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-local-discovery-rejection-test-",
    });
    const advertisementDirectory = path.join(runtimeDirectory, "t3code", "servers");
    yield* fileSystem.makeDirectory(advertisementDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.chmod(advertisementDirectory, 0o700);

    const records = [
      makeRecord({
        instanceId: "non-loopback",
        httpBaseUrl: "http://192.168.1.20:3773/",
        pairingUrl: "http://192.168.1.20:3773/pair#token=PAIRCODE",
      }),
      makeRecord({
        instanceId: "expired",
        pairingExpiresAt: "2000-01-01T00:00:00.000Z",
      }),
      makeRecord({ instanceId: "identity-mismatch" }),
    ];
    for (const record of records) {
      const recordPath = path.join(advertisementDirectory, `${record.instanceId}.json`);
      yield* fileSystem.writeFileString(recordPath, yield* encodeRecord(record), { mode: 0o600 });
      yield* fileSystem.chmod(recordPath, 0o600);
    }

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: (httpBaseUrl) =>
        httpBaseUrl === "http://127.0.0.1:3773/"
          ? Effect.succeed({
              ...descriptor,
              environmentId: EnvironmentId.make("another-environment"),
            })
          : Effect.succeed(descriptor),
    });

    expect(yield* discovery.discover).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);
