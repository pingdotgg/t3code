import * as AWS from "@alchemy.run/aws";
import { Volume } from "@alchemy.run/aws/EC2";
import { Alias, Key, type AliasName } from "@alchemy.run/aws/KMS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as kms from "@distilled.cloud/aws/kms";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
      expect(v?.Tags?.find((tag) => tag.Key === "alchemy::instance")?.Value).toBeTruthy();

      // list() enumerates the deployed volume.
      const provider = yield* Provider.findProvider(Volume);
      const all = yield* provider.list();
      expect(all.some((x) => x.volumeId === volume.volumeId)).toBe(true);

      yield* stack.destroy();
      yield* assertVolumeDeleted(volume.volumeId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 120_000 },
);

class AliasStillExists extends Data.TaggedError("AliasStillExists") {}
class KeyNotPendingDeletion extends Data.TaggedError("KeyNotPendingDeletion") {}

const kmsObservationSchedule = Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(30)]);

/**
 * Idempotent out-of-band backstop for the stack-managed fixture. KMS keys
 * cannot be hard-deleted, so the clean terminal state is alias NotFound plus
 * key PendingDeletion. The stack provider remains the owner; this finalizer
 * closes failure/timeout gaps and observes both terminal states before return.
 */
const releaseManagedKey = (aliasName: AliasName | undefined, keyId: string | undefined) =>
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
            error._tag === "DependencyTimeoutException" || error._tag === "KMSInternalException",
          schedule: Schedule.max([Schedule.fixed("500 millis"), Schedule.recurs(8)]),
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
              schedule: Schedule.max([Schedule.fixed("500 millis"), Schedule.recurs(8)]),
            }),
            Effect.catchTag(["KMSInvalidStateException", "NotFoundException"], () => Effect.void),
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
          yield* releaseManagedKey(fixtureAliasName, fixtureKeyId).pipe(Effect.orDie);
        }).pipe(logLevel),
      ),
    );
  },
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:kms", "live"],
    timeout: 120_000,
  },
);

// A create whose reply was lost leaves no saved output, and the tag lookup
// can miss a volume EC2 has not indexed yet. The ClientToken alchemy derives
// from the resource's generation makes the retried CreateVolume return the
// first volume instead of a second one.
test.provider(
  "a create retried after a lost reply returns the same volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployWith = (tags: Record<string, string>) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Volume("ClientTokenVolume", {
              availabilityZone: AZ,
              size: 1,
              volumeType: "gp3",
              tags,
            });
          }),
        );
      const key = { stack: stack.name, stage: stack.stage, fqn: "ClientTokenVolume" };

      // Simulate a lost CreateVolume reply: drop the saved output and the
      // generation tag the recovery lookup finds the volume by.
      const loseReply = Effect.fn(function* (volumeId: string) {
        const state = yield* yield* State;
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.die(new Error("Expected a created volume row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({ ...key, value: { ...rest, status: "creating" } });
        yield* EC2.deleteTags({
          Resources: [volumeId],
          Tags: [{ Key: "alchemy::instance" }],
          DryRun: false,
        });
        return row.instanceId;
      });

      const ownedVolumes = EC2.describeVolumes({
        Filters: [
          { Name: "tag:alchemy::stack", Values: [stack.name] },
          { Name: "tag:alchemy::stage", Values: [stack.stage] },
          { Name: "tag:alchemy::id", Values: ["ClientTokenVolume"] },
        ],
      }).pipe(Effect.map((owned) => owned.Volumes ?? []));

      const first = yield* deployWith({ v: "1" });
      const generation = yield* loseReply(first.volumeId);

      const retried = yield* deployWith({ v: "1" });
      expect(retried.volumeId).toBe(first.volumeId);

      // Only one volume carries this resource's ownership tags, and the sync
      // put the generation tag back.
      const volumes = yield* ownedVolumes;
      expect(volumes.map((v) => v.VolumeId)).toEqual([first.volumeId]);
      expect(volumes[0]?.Tags?.find((tag) => tag.Key === "alchemy::instance")?.Value).toBe(
        generation,
      );

      // Lose the reply again, then delete the volume outside the stack. EC2
      // refuses the retried token for a deleted volume, so the create must
      // fall back to a new volume rather than fail.
      yield* loseReply(first.volumeId);
      yield* EC2.deleteVolume({ VolumeId: first.volumeId, DryRun: false });
      yield* assertVolumeDeleted(first.volumeId);

      const recreated = yield* deployWith({ v: "1" });
      expect(recreated.volumeId).not.toBe(first.volumeId);
      expect((yield* ownedVolumes).map((v) => v.VolumeId)).toEqual([recreated.volumeId]);

      // Delete the volume outside the stack and change a tag. The update
      // finds the saved volume gone and creates under a token keyed on it.
      // Then lose that reply: state still holds the deleted volume and the
      // recovery lookup misses, so the retry must get the same new volume.
      const state = yield* yield* State;
      const beforeRecreate = yield* state.get(key);
      yield* EC2.deleteVolume({ VolumeId: recreated.volumeId, DryRun: false });
      yield* assertVolumeDeleted(recreated.volumeId);
      const updated = yield* deployWith({ v: "2" });
      expect(updated.volumeId).not.toBe(recreated.volumeId);

      yield* state.set({ ...key, value: beforeRecreate! });
      yield* EC2.deleteTags({
        Resources: [updated.volumeId],
        Tags: [{ Key: "alchemy::instance" }],
        DryRun: false,
      });
      const retriedUpdate = yield* deployWith({ v: "2" });
      expect(retriedUpdate.volumeId).toBe(updated.volumeId);
      expect((yield* ownedVolumes).map((v) => v.VolumeId)).toEqual([updated.volumeId]);

      yield* stack.destroy();
      yield* assertVolumeDeleted(updated.volumeId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 300_000 },
);

// `read` observes the volume, so drift sees it unchanged after a deploy and
// missing once it is deleted outside the stack. Repair recreates it under a
// new ClientToken.
test.provider(
  "drift reports a volume deleted outside the stack as missing and repair recreates it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        return yield* Volume("DriftVolume", {
          availabilityZone: AZ,
          size: 1,
          volumeType: "gp3",
        });
      });

      const volume = yield* stack.deploy(program);
      const state = yield* yield* State;
      const key = { stack: stack.name, stage: stack.stage, fqn: "DriftVolume" };
      const beforeRepair = yield* state.get(key);

      const detect = Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect((yield* detect).resources.DriftVolume?.action).toBe("unchanged");

      yield* EC2.deleteVolume({ VolumeId: volume.volumeId, DryRun: false });
      yield* assertVolumeDeleted(volume.volumeId);
      expect((yield* detect).resources.DriftVolume?.action).toBe("missing");

      const repaired = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(repaired.resources.DriftVolume?.action).toBe("recreated");
      const recreated = repaired.resources.DriftVolume?.attr as typeof volume;
      expect(recreated.volumeId).not.toBe(volume.volumeId);
      expect(recreated.state).toBe("available");

      // Lose the repair's reply: state still holds the deleted volume and the
      // recovery lookup misses. Repairing again must return the same volume
      // rather than create a second one.
      yield* state.set({ ...key, value: beforeRepair! });
      yield* EC2.deleteTags({
        Resources: [recreated.volumeId],
        Tags: [{ Key: "alchemy::instance" }],
        DryRun: false,
      });
      const retried = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(retried.resources.DriftVolume?.action).toBe("recreated");
      expect((retried.resources.DriftVolume?.attr as typeof volume).volumeId).toBe(
        recreated.volumeId,
      );
      const owned = yield* EC2.describeVolumes({
        Filters: [
          { Name: "tag:alchemy::stack", Values: [stack.name] },
          { Name: "tag:alchemy::stage", Values: [stack.stage] },
          { Name: "tag:alchemy::id", Values: ["DriftVolume"] },
        ],
      });
      expect((owned.Volumes ?? []).map((v) => v.VolumeId)).toEqual([recreated.volumeId]);

      yield* stack.destroy();
      yield* assertVolumeDeleted(recreated.volumeId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"], timeout: 300_000 },
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
      while: (e) => e._tag === "VolumeStillExists",
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
  );
});

class VolumeStillExists extends Data.TaggedError("VolumeStillExists") {}
