import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  LocalServerAdvertisement,
  type LocalServerPairingChallenge,
} from "@t3tools/contracts";
import { LOCAL_SERVER_CHALLENGE_NONCE_BYTES } from "@t3tools/shared/localServerDiscovery";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { LocalServerPairingError, make } from "./DesktopLocalServerDiscovery.ts";

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
  environmentId,
  label: "Advertisement label",
  ...overrides,
});

const rejectPairing: () => Effect.Effect<never, LocalServerPairingError> = () =>
  Effect.fail(
    new LocalServerPairingError({ reason: "request_failed", detail: "unexpected pairing call" }),
  );

const writeAdvertisement = Effect.fn("test.writeAdvertisement")(function* (
  advertisementDirectory: string,
  record: LocalServerAdvertisement,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordPath = path.join(advertisementDirectory, `${record.instanceId}.json`);
  yield* fileSystem.writeFileString(recordPath, yield* encodeRecord(record), { mode: 0o600 });
  yield* fileSystem.chmod(recordPath, 0o600);
});

const makeAdvertisementDirectory = Effect.fn("test.makeAdvertisementDirectory")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  const advertisementDirectory = path.join(runtimeDirectory, "t3code", "servers");
  yield* fileSystem.makeDirectory(advertisementDirectory, { recursive: true, mode: 0o700 });
  yield* fileSystem.chmod(advertisementDirectory, 0o700);
  return { runtimeDirectory, advertisementDirectory };
});

it.effect("discovers private, live, identity-matched loopback advertisements", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-discovery-test-",
    );
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: rejectPairing,
    });
    const discovered = yield* discovery.discover;

    assert.strictEqual(discovered.length, 1);
    expect(discovered[0]?.environmentId).toBe(environmentId);
    expect(discovered[0]?.label).toBe(descriptor.label);
    // The advertisement is public-to-this-user metadata only.
    expect(discovered[0]).not.toHaveProperty("pairingUrl");
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("ignores unsafe, dead, and identity-mismatched advertisements", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-discovery-rejection-test-",
    );

    const records = [
      makeRecord({
        instanceId: "non-loopback",
        httpBaseUrl: "http://192.168.1.20:3773/",
      }),
      // Records no longer expire, so a leftover record from a dead process is
      // only rejected because nothing answers the identity probe.
      makeRecord({ instanceId: "dead-process", httpBaseUrl: "http://127.0.0.1:3774/" }),
      makeRecord({ instanceId: "identity-mismatch" }),
      makeRecord({ instanceId: "absurd-start", startedAt: "2999-01-01T00:00:00.000Z" }),
    ];
    for (const record of records) {
      yield* writeAdvertisement(advertisementDirectory, record);
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
          : Effect.succeed(null),
      postPairingChallenge: rejectPairing,
    });

    expect(yield* discovery.discover).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("pairs by presenting a private nonce and always removes the challenge file", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { runtimeDirectory, advertisementDirectory } =
      yield* makeAdvertisementDirectory("t3-local-pairing-test-");
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const fileSystem = yield* FileSystem.FileSystem;
    const observed: Array<{
      readonly httpBaseUrl: string;
      readonly challenge: LocalServerPairingChallenge;
      readonly contents: string;
      readonly mode: number;
    }> = [];

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: ({ httpBaseUrl, challenge }) =>
        Effect.gen(function* () {
          // Read while the request is in flight: the nonce must exist on disk
          // with 0600 permissions for the server to be able to verify it.
          observed.push({
            httpBaseUrl,
            challenge,
            contents: yield* fileSystem.readFileString(challenge.challengePath),
            mode: (yield* fileSystem.stat(challenge.challengePath)).mode & 0o777,
          });
          return {
            pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
            pairingExpiresAt: "2099-01-01T00:00:00.000Z",
          };
        }).pipe(Effect.orDie),
    });

    const result = yield* discovery.pairLocalServer("instance-local");

    expect(result).toEqual({
      pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
      pairingExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.strictEqual(observed.length, 1);
    const call = observed[0];
    assert.isDefined(call);
    expect(call.httpBaseUrl).toBe("http://127.0.0.1:3773/");
    expect(call.challenge.instanceId).toBe("instance-local");
    expect(call.challenge.nonce).toMatch(
      new RegExp(`^[0-9a-f]{${LOCAL_SERVER_CHALLENGE_NONCE_BYTES * 2}}$`),
    );
    expect(call.contents).toBe(call.challenge.nonce);
    expect(call.mode).toBe(0o600);
    // Written inside the user-private challenge directory, never the
    // advertisement directory the server owns.
    expect(path.dirname(call.challenge.challengePath)).toBe(
      path.join(runtimeDirectory, "t3code", "challenges"),
    );
    expect((yield* fileSystem.stat(path.dirname(call.challenge.challengePath))).mode & 0o777).toBe(
      0o700,
    );
    expect(yield* fileSystem.exists(call.challenge.challengePath)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("rejects pairing for an instance that is no longer advertising", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-pairing-missing-test-",
    );
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: rejectPairing,
    });

    const error = yield* discovery.pairLocalServer("instance-gone").pipe(Effect.flip);
    expect(error.reason).toBe("not_found");
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("removes the challenge file when the pairing request fails", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-pairing-failure-test-",
    );
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const fileSystem = yield* FileSystem.FileSystem;
    const attempted: Array<string> = [];
    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: ({ challenge }) =>
        Effect.gen(function* () {
          attempted.push(challenge.challengePath);
          expect(yield* fileSystem.exists(challenge.challengePath).pipe(Effect.orDie)).toBe(true);
          return yield* new LocalServerPairingError({ reason: "request_failed", detail: "boom" });
        }),
    });

    const error = yield* discovery.pairLocalServer("instance-local").pipe(Effect.flip);
    expect(error.reason).toBe("request_failed");
    assert.strictEqual(attempted.length, 1);
    expect(yield* fileSystem.exists(attempted[0] as string)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("removes the challenge file when tightening its permissions fails", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-pairing-chmod-failure-test-",
    );
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const fileSystem = yield* FileSystem.FileSystem;
    let challengePath: string | null = null;
    const chmodFailure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "chmod",
      pathOrDescriptor: runtimeDirectory,
    });
    const failingFileSystem = FileSystem.FileSystem.of({
      ...fileSystem,
      writeFileString: (target, contents, options) =>
        fileSystem.writeFileString(target, contents, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (target.endsWith(".nonce")) challengePath = target;
            }),
          ),
        ),
      chmod: (target, mode) =>
        target.endsWith(".nonce")
          ? Effect.fail(chmodFailure)
          : fileSystem.chmod(target, mode),
    });
    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: rejectPairing,
    }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));

    const error = yield* discovery.pairLocalServer("instance-local").pipe(Effect.flip);

    expect(error.reason).toBe("challenge_failed");
    assert.isNotNull(challengePath);
    expect(yield* fileSystem.exists(challengePath)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect("rejects a pairing URL that can retarget the minted local credential", () =>
  Effect.gen(function* () {
    const { runtimeDirectory, advertisementDirectory } = yield* makeAdvertisementDirectory(
      "t3-local-pairing-url-test-",
    );
    yield* writeAdvertisement(advertisementDirectory, makeRecord());

    const discovery = yield* make({
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
      uid: process.getuid?.(),
      probeEnvironment: () => Effect.succeed(descriptor),
      postPairingChallenge: () =>
        Effect.succeed({
          pairingUrl:
            "http://127.0.0.1:3773/pair?host=https%3A%2F%2Fattacker.example#token=PAIRCODE",
          pairingExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
    });

    const error = yield* discovery.pairLocalServer("instance-local").pipe(Effect.flip);
    expect(error.reason).toBe("request_failed");
    expect(error.detail).toContain("invalid pairing link");
  }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
);
