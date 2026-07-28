import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { LOCAL_SERVER_CHALLENGE_MAX_BYTES } from "@t3tools/shared/localServerDiscovery";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeLocalServerPairingIssuer } from "./localPairing.ts";
import * as LocalServerDiscoveryState from "../localServerDiscoveryState.ts";

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const HTTP_BASE_URL = "http://127.0.0.1:3773/";
// 64 hex characters: the 32-byte nonce the client is required to present.
const NONCE = "a".repeat(64);

const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  issueStartupPairingCredential: () =>
    Effect.succeed({
      id: "local-pair-id",
      credential: "LOCALPAIR",
      expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
    }),
});

/**
 * Stand up a challenge directory plus a valid challenge file, then hand back an
 * issuer whose discovery state points at it. Each test mutates one input so the
 * happy path stays the single source of "otherwise valid".
 */
const setup = Effect.fn(function* (options: { readonly activate?: boolean } = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-local-pairing-test-",
  });
  const challengeDirectory = path.join(runtimeDirectory, "t3code", "challenges");
  yield* fileSystem.makeDirectory(challengeDirectory, { recursive: true, mode: 0o700 });
  const challengePath = path.join(challengeDirectory, "challenge");
  yield* fileSystem.writeFileString(challengePath, `${NONCE}\n`, { mode: 0o600 });
  yield* fileSystem.chmod(challengePath, 0o600);

  const discoveryState = yield* LocalServerDiscoveryState.LocalServerDiscoveryState;
  if (options.activate !== false) {
    yield* discoveryState.activate({
      instanceId: INSTANCE_ID,
      httpBaseUrl: HTTP_BASE_URL,
      platform: "linux",
      xdgRuntimeDirectory: runtimeDirectory,
    });
  }
  const issue = yield* makeLocalServerPairingIssuer;

  return {
    fileSystem,
    path,
    runtimeDirectory,
    challengeDirectory,
    challengePath,
    issue: (
      overrides: {
        readonly instanceId?: string;
        readonly challengePath?: string;
        readonly nonce?: string;
        readonly remoteAddress?: string | undefined;
      } = {},
    ) =>
      issue({
        challenge: {
          instanceId: overrides.instanceId ?? INSTANCE_ID,
          challengePath: overrides.challengePath ?? challengePath,
          nonce: overrides.nonce ?? NONCE,
        },
        remoteAddress: "remoteAddress" in overrides ? overrides.remoteAddress : "127.0.0.1",
      }),
  };
});

const provideTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(authLayer, LocalServerDiscoveryState.layer, NodeServices.layer)),
  );

it.effect("issues a pairing credential when the caller proves filesystem access", () =>
  provideTestLayers(
    Effect.gen(function* () {
      const context = yield* setup();

      const result = yield* context.issue();

      expect(result).toEqual({
        pairingUrl: "http://127.0.0.1:3773/pair#token=LOCALPAIR",
        pairingExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      // The challenge file belongs to the client; the server must not delete it.
      expect(yield* context.fileSystem.exists(context.challengePath)).toBe(true);
    }),
  ),
);

it.effect("rejects every invalid challenge without saying why", () =>
  provideTestLayers(
    Effect.gen(function* () {
      const context = yield* setup();
      const { fileSystem, path } = context;

      // Wrong instance: the caller discovered some other server.
      expect(
        yield* context.issue({ instanceId: "99999999-0000-0000-0000-000000000000" }),
      ).toBeNull();

      // Nonce mismatch.
      expect(yield* context.issue({ nonce: "b".repeat(64) })).toBeNull();

      // Nonce shorter than the required 32 bytes of hex-encoded entropy.
      const shortPath = path.join(context.challengeDirectory, "short");
      yield* fileSystem.writeFileString(shortPath, "abcd", { mode: 0o600 });
      yield* fileSystem.chmod(shortPath, 0o600);
      expect(yield* context.issue({ challengePath: shortPath, nonce: "abcd" })).toBeNull();

      // Non-loopback and unknown peers.
      expect(yield* context.issue({ remoteAddress: "192.168.1.42" })).toBeNull();
      expect(yield* context.issue({ remoteAddress: undefined })).toBeNull();

      // Challenge path outside the challenge directory.
      const outsidePath = path.join(context.runtimeDirectory, "outside");
      yield* fileSystem.writeFileString(outsidePath, `${NONCE}\n`, { mode: 0o600 });
      yield* fileSystem.chmod(outsidePath, 0o600);
      expect(yield* context.issue({ challengePath: outsidePath })).toBeNull();

      // Nested one level deeper: `isContainedChallengePath` requires the file to
      // sit directly in the challenge directory.
      const nestedDirectory = path.join(context.challengeDirectory, "nested");
      yield* fileSystem.makeDirectory(nestedDirectory, { recursive: true, mode: 0o700 });
      const nestedPath = path.join(nestedDirectory, "challenge");
      yield* fileSystem.writeFileString(nestedPath, `${NONCE}\n`, { mode: 0o600 });
      yield* fileSystem.chmod(nestedPath, 0o600);
      expect(yield* context.issue({ challengePath: nestedPath })).toBeNull();

      // Symlink inside the directory pointing at a file outside it. This is the
      // arbitrary-file-read case, so it must be caught by realPath canonicalization.
      const symlinkPath = path.join(context.challengeDirectory, "escape");
      yield* fileSystem.symlink(outsidePath, symlinkPath);
      // Confirm the symlink really does resolve out of the directory, otherwise
      // this case would pass for the wrong reason (a broken link).
      expect(yield* fileSystem.realPath(symlinkPath)).toBe(yield* fileSystem.realPath(outsidePath));
      expect(yield* context.issue({ challengePath: symlinkPath })).toBeNull();

      // Traversal that lands outside after canonicalization.
      expect(
        yield* context.issue({
          challengePath: path.join(context.challengeDirectory, "..", "..", "outside"),
        }),
      ).toBeNull();

      // Missing file.
      expect(
        yield* context.issue({ challengePath: path.join(context.challengeDirectory, "absent") }),
      ).toBeNull();

      // A directory rather than a regular file.
      expect(yield* context.issue({ challengePath: nestedDirectory })).toBeNull();

      // World/group readable: another local user could have planted the nonce.
      const loosePath = path.join(context.challengeDirectory, "loose");
      yield* fileSystem.writeFileString(loosePath, `${NONCE}\n`, { mode: 0o600 });
      yield* fileSystem.chmod(loosePath, 0o644);
      expect(yield* context.issue({ challengePath: loosePath })).toBeNull();

      // Oversized challenge file.
      const hugePath = path.join(context.challengeDirectory, "huge");
      yield* fileSystem.writeFileString(
        hugePath,
        `${NONCE}\n${"p".repeat(LOCAL_SERVER_CHALLENGE_MAX_BYTES + 1)}`,
        { mode: 0o600 },
      );
      yield* fileSystem.chmod(hugePath, 0o600);
      expect(yield* context.issue({ challengePath: hugePath })).toBeNull();

      // Sanity: the otherwise-valid challenge still works, so the rejections
      // above are attributable to the mutation and not to a broken fixture.
      expect(yield* context.issue()).not.toBeNull();
    }),
  ),
);

it.effect("stays closed when local discovery was never activated", () =>
  provideTestLayers(
    Effect.gen(function* () {
      const context = yield* setup({ activate: false });

      expect(yield* context.issue()).toBeNull();
    }),
  ),
);

it.effect("stays closed once discovery is deactivated", () =>
  provideTestLayers(
    Effect.gen(function* () {
      const context = yield* setup();
      const discoveryState = yield* LocalServerDiscoveryState.LocalServerDiscoveryState;

      expect(yield* context.issue()).not.toBeNull();
      yield* discoveryState.deactivate;
      expect(yield* context.issue()).toBeNull();
    }),
  ),
);
