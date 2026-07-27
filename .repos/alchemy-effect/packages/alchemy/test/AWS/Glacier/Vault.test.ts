import * as AWS from "@/AWS";
import { Vault } from "@/AWS/Glacier";
import { Topic } from "@/AWS/SNS";
import * as Test from "@/Test/Alchemy";
import * as glacier from "@distilled.cloud/aws/glacier";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete/sync paths depend on. Runs in
// every CI pass at near-zero cost.
test.provider(
  "describeVault on a nonexistent vault fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        glacier.describeVault({
          accountId: "-",
          vaultName: "alchemy-nonexistent-glacier-vault-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated entitlement probe: AWS rejects the vault-based S3 Glacier API on
// accounts created after its 2025 deprecation ("This API is no longer
// supported for new accounts. Please use S3 Glacier storage classes
// instead.") with the typed NoLongerSupportedException. On an entitled
// (older) account the create succeeds — clean the probe vault up and move
// on; the full lifecycle below is what exercises entitled accounts.
test.provider(
  "createVault either succeeds (entitled account) or fails with the typed NoLongerSupportedException",
  () =>
    Effect.gen(function* () {
      const vaultName = "alchemy-glacier-entitlement-probe";
      const created = yield* Effect.result(
        glacier.createVault({ accountId: "-", vaultName }),
      );
      if (Result.isFailure(created)) {
        expect(created.failure._tag).toBe("NoLongerSupportedException");
        return;
      }
      yield* glacier
        .deleteVault({ accountId: "-", vaultName })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
);

class VaultStillExists extends Data.TaggedError("VaultStillExists")<{
  vaultName: string;
}> {}

// Typed wait-until-gone: DescribeVault must return the typed
// ResourceNotFoundException once deletion has propagated.
const assertVaultDeleted = (vaultName: string) =>
  Effect.gen(function* () {
    const exists = yield* glacier
      .describeVault({ accountId: "-", vaultName })
      .pipe(
        Effect.map(() => true),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(false),
        ),
      );
    if (exists) {
      yield* Effect.fail(new VaultStillExists({ vaultName }));
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VaultStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const denyArchiveDeletes = (vaultArn: string) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "deny-archive-deletes",
      Effect: "Deny",
      Principal: "*",
      Action: ["glacier:DeleteArchive"],
      Resource: [vaultArn],
    },
  ],
});

test.provider.skipIf(!process.env.AWS_TEST_GLACIER)(
  "create vault with tags + notifications, sync access policy, remove config, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Step 1 — vault with tags and a notification configuration.
      const step1 = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("VaultEvents");
          const vault = yield* Vault("Backups", {
            tags: { fixture: "glacier-vault" },
            notificationConfig: {
              snsTopic: topic.topicArn,
              events: ["ArchiveRetrievalCompleted"],
            },
          });
          return { topic, vault };
        }),
      );

      expect(step1.vault.vaultName).toBeDefined();
      expect(step1.vault.vaultArn).toContain(":vaults/");
      expect(step1.vault.creationDate).toBeDefined();

      // Out-of-band verification via distilled.
      const described = yield* glacier.describeVault({
        accountId: "-",
        vaultName: step1.vault.vaultName,
      });
      expect(described.VaultARN).toBe(step1.vault.vaultArn);

      const notifications = yield* glacier.getVaultNotifications({
        accountId: "-",
        vaultName: step1.vault.vaultName,
      });
      expect(notifications.vaultNotificationConfig?.SNSTopic).toBe(
        step1.topic.topicArn,
      );
      expect(notifications.vaultNotificationConfig?.Events).toEqual([
        "ArchiveRetrievalCompleted",
      ]);

      const tags = yield* glacier.listTagsForVault({
        accountId: "-",
        vaultName: step1.vault.vaultName,
      });
      expect(tags.Tags?.fixture).toBe("glacier-vault");
      expect(tags.Tags?.["alchemy::id"]).toBeDefined();

      // No access policy yet.
      const noPolicy = yield* Effect.flip(
        glacier.getVaultAccessPolicy({
          accountId: "-",
          vaultName: step1.vault.vaultName,
        }),
      );
      expect(noPolicy._tag).toBe("ResourceNotFoundException");

      // Step 2 — add an access policy (the vault ARN is deterministic given
      // the engine-generated name, so we thread the step-1 output through),
      // change the notification events, and update the tags.
      const vaultArn = step1.vault.vaultArn;
      const step2 = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("VaultEvents");
          const vault = yield* Vault("Backups", {
            tags: { fixture: "glacier-vault", stage: "two" },
            accessPolicy: denyArchiveDeletes(vaultArn),
            notificationConfig: {
              snsTopic: topic.topicArn,
              events: [
                "ArchiveRetrievalCompleted",
                "InventoryRetrievalCompleted",
              ],
            },
          });
          return { vault };
        }),
      );
      expect(step2.vault.vaultArn).toBe(vaultArn);

      const policy = yield* glacier.getVaultAccessPolicy({
        accountId: "-",
        vaultName: step2.vault.vaultName,
      });
      expect(policy.policy?.Policy).toContain("deny-archive-deletes");

      const updatedNotifications = yield* glacier.getVaultNotifications({
        accountId: "-",
        vaultName: step2.vault.vaultName,
      });
      expect(
        [
          ...(updatedNotifications.vaultNotificationConfig?.Events ?? []),
        ].sort(),
      ).toEqual(["ArchiveRetrievalCompleted", "InventoryRetrievalCompleted"]);

      const updatedTags = yield* glacier.listTagsForVault({
        accountId: "-",
        vaultName: step2.vault.vaultName,
      });
      expect(updatedTags.Tags?.stage).toBe("two");

      // Step 3 — remove the access policy and notification configuration;
      // the reconciler must delete both against observed state.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Topic("VaultEvents");
          const vault = yield* Vault("Backups", {
            tags: { fixture: "glacier-vault" },
          });
          return { vault };
        }),
      );

      const removedPolicy = yield* Effect.flip(
        glacier.getVaultAccessPolicy({
          accountId: "-",
          vaultName: step1.vault.vaultName,
        }),
      );
      expect(removedPolicy._tag).toBe("ResourceNotFoundException");

      const removedNotifications = yield* Effect.flip(
        glacier.getVaultNotifications({
          accountId: "-",
          vaultName: step1.vault.vaultName,
        }),
      );
      expect(removedNotifications._tag).toBe("ResourceNotFoundException");

      const prunedTags = yield* glacier.listTagsForVault({
        accountId: "-",
        vaultName: step1.vault.vaultName,
      });
      expect(prunedTags.Tags?.stage).toBeUndefined();

      yield* stack.destroy();
      yield* assertVaultDeleted(step1.vault.vaultName);
    }),
  { timeout: 240_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_GLACIER)(
  "vault lock: initiate in-progress, then abort on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Step 1 — plain vault (we need its ARN to author the lock policy).
      const step1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("LockedVault");
        }),
      );

      // Step 2 — initiate the vault lock. It must observe as InProgress and
      // must never be completed by the provider.
      const vaultArn = step1.vaultArn;
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("LockedVault", {
            lockPolicy: denyArchiveDeletes(vaultArn),
          });
        }),
      );

      const lock = yield* glacier.getVaultLock({
        accountId: "-",
        vaultName: step1.vaultName,
      });
      expect(lock.State).toBe("InProgress");
      expect(lock.Policy).toContain("deny-archive-deletes");

      // Reconcile is idempotent while the lock is in progress.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("LockedVault", {
            lockPolicy: denyArchiveDeletes(vaultArn),
          });
        }),
      );

      // Step 3 — removing the prop aborts the in-progress lock.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("LockedVault");
        }),
      );
      const aborted = yield* Effect.flip(
        glacier.getVaultLock({
          accountId: "-",
          vaultName: step1.vaultName,
        }),
      );
      expect(aborted._tag).toBe("ResourceNotFoundException");

      yield* stack.destroy();
      yield* assertVaultDeleted(step1.vaultName);
    }),
  { timeout: 240_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_GLACIER)(
  "renaming a vault replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("Renamed");
        }),
      );

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vault("Renamed", {
            vaultName: "alchemy-test-glacier-vault-renamed",
          });
        }),
      );

      expect(renamed.vaultName).toBe("alchemy-test-glacier-vault-renamed");
      expect(renamed.vaultArn).not.toBe(original.vaultArn);

      // The new vault exists; the old one was deleted by the replacement.
      const described = yield* glacier.describeVault({
        accountId: "-",
        vaultName: renamed.vaultName,
      });
      expect(described.VaultARN).toBe(renamed.vaultArn);
      yield* assertVaultDeleted(original.vaultName);

      yield* stack.destroy();
      yield* assertVaultDeleted(renamed.vaultName);
    }),
  { timeout: 240_000 },
);
