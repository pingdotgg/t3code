import * as AWS from "@/AWS";
import { Volume } from "@/AWS/EC2";
import { Alias, Key, type AliasName } from "@/AWS/KMS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as kms from "@distilled.cloud/aws/kms";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The testing account is in us-west-2.
const AZ = "us-west-2a";

test.provider(
  "create, verify, and delete a gp3 volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const volume = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Volume("TestGp3Volume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
          });
        }),
      );

      expect(volume.volumeId).toMatch(/^vol-/);
      expect(volume.availabilityZone).toBe(AZ);
      expect(volume.volumeType).toBe("gp3");
      expect(volume.size).toBe(1);

      // Out-of-band verification.
      const observed = yield* EC2.describeVolumes({
        VolumeIds: [volume.volumeId],
      });
      const v = observed.Volumes?.[0];
      expect(v?.VolumeType).toBe("gp3");
      expect(v?.Size).toBe(1);
      expect(v?.AvailabilityZone).toBe(AZ);
      expect(v?.State === "available" || v?.State === "creating").toBe(true);
      expect(
        v?.Tags?.find((tag) => tag.Key === "alchemy::instance")?.Value,
      ).toBeTruthy();

      // list() enumerates the deployed volume.
      const provider = yield* Provider.findProvider(Volume);
      const all = yield* provider.list();
      expect(all.some((x) => x.volumeId === volume.volumeId)).toBe(true);

      yield* stack.destroy();
      yield* assertVolumeDeleted(volume.volumeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

class AliasStillExists extends Data.TaggedError("AliasStillExists") {}
class KeyNotPendingDeletion extends Data.TaggedError("KeyNotPendingDeletion") {}

const kmsObservationSchedule = Schedule.max([
  Schedule.fixed("1 second"),
  Schedule.recurs(30),
]);

/**
 * Idempotent out-of-band backstop for the stack-managed fixture. KMS keys
 * cannot be hard-deleted, so the clean terminal state is alias NotFound plus
 * key PendingDeletion. The stack provider remains the owner; this finalizer
 * closes failure/timeout gaps and observes both terminal states before return.
 */
const releaseManagedKey = (
  aliasName: AliasName | undefined,
  keyId: string | undefined,
) =>
  Effect.gen(function* () {
    let targetKeyId = keyId;
    if (aliasName !== undefined) {
      const viaAlias = yield* kms.describeKey({ KeyId: aliasName }).pipe(
        Effect.map((response) => response.KeyMetadata),
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );
      targetKeyId ??= viaAlias?.KeyId;

      yield* kms.deleteAlias({ AliasName: aliasName }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "DependencyTimeoutException" ||
            error._tag === "KMSInternalException",
          schedule: Schedule.max([
            Schedule.fixed("500 millis"),
            Schedule.recurs(8),
          ]),
        }),
        Effect.catchTag("NotFoundException", () => Effect.void),
      );

      yield* kms.describeKey({ KeyId: aliasName }).pipe(
        Effect.flatMap(() => Effect.fail(new AliasStillExists())),
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "AliasStillExists",
          schedule: kmsObservationSchedule,
        }),
      );
    }

    if (targetKeyId !== undefined) {
      const metadata = yield* kms.describeKey({ KeyId: targetKeyId }).pipe(
        Effect.map((response) => response.KeyMetadata),
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );
      if (metadata && metadata.KeyState !== "PendingDeletion") {
        yield* kms
          .scheduleKeyDeletion({
            KeyId: targetKeyId,
            PendingWindowInDays: 7,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "DependencyTimeoutException" ||
                error._tag === "KMSInternalException",
              schedule: Schedule.max([
                Schedule.fixed("500 millis"),
                Schedule.recurs(8),
              ]),
            }),
            Effect.catchTag(
              ["KMSInvalidStateException", "NotFoundException"],
              () => Effect.void,
            ),
          );
      }

      yield* kms.describeKey({ KeyId: targetKeyId }).pipe(
        Effect.flatMap((response) =>
          response.KeyMetadata?.KeyState === "PendingDeletion"
            ? Effect.void
            : Effect.fail(new KeyNotPendingDeletion()),
        ),
        Effect.catchTag("NotFoundException", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "KeyNotPendingDeletion",
          schedule: kmsObservationSchedule,
        }),
      );
    }
  });

test.provider(
  "create an encrypted volume with a managed KMS key and alias",
  (stack) => {
    let fixtureAliasName: AliasName | undefined;
    let fixtureKeyId: string | undefined;
    return Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Key("EncryptedVolumeKey", {
            description: "Alchemy EC2 encrypted-volume test key",
            deletionWindow: "7 days",
            tags: { fixture: "ec2-volume" },
          });
          const alias = yield* Alias("EncryptedVolumeAlias", {
            targetKeyId: key.keyId,
          });
          const volume = yield* Volume("TestEncryptedVolume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
            encrypted: true,
            kmsKeyId: alias.aliasName,
          });
          return { alias, key, volume };
        }),
      );
      fixtureAliasName = deployed.alias.aliasName;
      fixtureKeyId = deployed.key.keyId;

      expect(deployed.volume.encrypted).toBe(true);

      const observed = yield* EC2.describeVolumes({
        VolumeIds: [deployed.volume.volumeId],
      });
      const v = observed.Volumes?.[0];
      expect(v?.Encrypted).toBe(true);
      expect(v?.KmsKeyId).toBe(deployed.key.keyArn);

      yield* stack.destroy();
      yield* assertVolumeDeleted(deployed.volume.volumeId);
      yield* releaseManagedKey(fixtureAliasName, fixtureKeyId);
    }).pipe(
      logLevel,
      // Always run both the state-owned destroy and the direct idempotent
      // backstop. This covers assertions, failures, and runner interruption
      // while preserving dependency order (Volume -> Alias -> Key).
      Effect.ensuring(
        Effect.gen(function* () {
          yield* stack.destroy().pipe(Effect.ignore);
          // Finalizers require a `never` error channel. Escalate a cleanup
          // failure to a visible defect instead of swallowing it.
          yield* releaseManagedKey(fixtureAliasName, fixtureKeyId).pipe(
            Effect.orDie,
          );
        }).pipe(logLevel),
      ),
    );
  },
  { timeout: 120_000 },
);

const assertVolumeDeleted = Effect.fn(function* (volumeId: string) {
  yield* EC2.describeVolumes({ VolumeIds: [volumeId] }).pipe(
    Effect.flatMap((result) => {
      const state = result.Volumes?.[0]?.State;
      return state === undefined || state === "deleted"
        ? Effect.void
        : Effect.fail(new VolumeStillExists());
    }),
    Effect.retry({
      while: (e) => e instanceof VolumeStillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
  );
});

class VolumeStillExists extends Data.TaggedError("VolumeStillExists") {}
