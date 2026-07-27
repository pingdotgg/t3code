import * as AWS from "@/AWS";
import { PlaybackKeyPair } from "@/AWS/IVS";
import * as Test from "@/Test/Alchemy";
import * as ivs from "@distilled.cloud/aws/ivs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Generated once with `openssl ecparam -name secp384r1 -genkey | openssl
// ec -pubout` and checked in as constants (never generated at test time).
const PUBLIC_KEY_A = `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAESErCxbkHXtts2QDGbIfjMpUjNtnBtHwm
vIu3tC3Rqdv3NAcDzBadv045/QzYLFYpW1qqAMBGCASZKl+fvk+oI6ES+wV6aT1i
vGQdcQN88zA1DeJLu2CEA5dRXmSKhP4C
-----END PUBLIC KEY-----`;

const PUBLIC_KEY_B = `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEiS2HkhQsxtJG4i++/Na99ZwNEugpI+M/
N0EKZtiBKnt5QhZMcyeRjcwY3zJBtrZSd8hgdyaW0HQoGtyNVNZNi54XPRq3BQUf
r4NJCuts5JUtFVRM6ynCdqdi78ZxNUBj
-----END PUBLIC KEY-----`;

const assertKeyPairGone = (arn: string) =>
  Effect.gen(function* () {
    const keyPair = yield* ivs.getPlaybackKeyPair({ arn }).pipe(
      Effect.map((r) => r.keyPair),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (keyPair !== undefined) {
      return yield* Effect.fail(
        new Error(`playback key pair '${arn}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Key pairs are free and provision synchronously. Covers create, no-op,
// and the replace path (key material is immutable).
test.provider(
  "import, replace, and destroy a playback key pair",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        playbackKeyPairName: "alchemy-test-ivs-keypair",
        publicKeyMaterial: PUBLIC_KEY_A,
        tags: { fixture: "ivs-playback-key-pair" },
      };

      // Create (import).
      const created = yield* stack.deploy(PlaybackKeyPair("Viewer", props));
      expect(created.playbackKeyPairName).toBe("alchemy-test-ivs-keypair");
      expect(created.playbackKeyPairArn).toContain(":playback-key/");
      expect(created.fingerprint).toBeDefined();

      // Out-of-band verification via distilled.
      const observed = yield* ivs.getPlaybackKeyPair({
        arn: created.playbackKeyPairArn,
      });
      expect(observed.keyPair?.name).toBe("alchemy-test-ivs-keypair");
      expect(observed.keyPair?.fingerprint).toBe(created.fingerprint);
      expect(observed.keyPair?.tags?.["alchemy::id"]).toBe("Viewer");

      // No-op redeploy keeps the same key pair.
      const noop = yield* stack.deploy(PlaybackKeyPair("Viewer", props));
      expect(noop.playbackKeyPairArn).toBe(created.playbackKeyPairArn);
      expect(noop.fingerprint).toBe(created.fingerprint);

      // Changing the key material replaces the key pair — new ARN and
      // fingerprint under the same name.
      const replaced = yield* stack.deploy(
        PlaybackKeyPair("Viewer", {
          ...props,
          publicKeyMaterial: PUBLIC_KEY_B,
        }),
      );
      expect(replaced.playbackKeyPairArn).not.toBe(created.playbackKeyPairArn);
      expect(replaced.fingerprint).not.toBe(created.fingerprint);
      yield* assertKeyPairGone(created.playbackKeyPairArn);

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertKeyPairGone(replaced.playbackKeyPairArn);
    }),
  { timeout: 240_000 },
);
