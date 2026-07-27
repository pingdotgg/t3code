import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as efs from "@distilled.cloud/aws/efs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const efsTagsToRecord = (
  tags: readonly efs.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

// Typed wait-until-gone: DescribeFileSystems surfaces the typed
// FileSystemNotFound once the deletion finishes; a still-visible file system
// in the `deleted` state also counts as gone.
const waitUntilFileSystemGone = (fileSystemId: string) =>
  efs.describeFileSystems({ FileSystemId: fileSystemId }).pipe(
    Effect.map((r) =>
      (r.FileSystems ?? []).every((f) => f.LifeCycleState === "deleted"),
    ),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("2 seconds"),
      until: (gone) => gone,
      times: 30,
    }),
  );

test.provider(
  "create, update, list, delete file system",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // --- create: encrypted by default, elastic throughput ---
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("Files", {
            throughputMode: "elastic",
            tags: { purpose: "alchemy-efs-test" },
          });
          return { files };
        }),
      );
      expect(created.files.fileSystemId).toMatch(/^fs-/);
      expect(created.files.fileSystemArn).toContain(":file-system/");

      const observed = yield* efs
        .describeFileSystems({ FileSystemId: created.files.fileSystemId })
        .pipe(Effect.map((r) => r.FileSystems![0]));
      expect(observed.Encrypted).toBe(true);
      expect(observed.PerformanceMode).toBe("generalPurpose");
      expect(observed.ThroughputMode).toBe("elastic");
      const observedTags = efsTagsToRecord(observed.Tags);
      expect(observedTags.purpose).toBe("alchemy-efs-test");
      expect(observedTags["alchemy::id"]).toBe("Files");

      // --- update: lifecycle policies + typed file system policy + backup
      //     policy + replication overwrite protection + tags, same file
      //     system ---
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("Files", {
            throughputMode: "elastic",
            backup: true,
            replicationOverwriteProtection: "DISABLED",
            lifecyclePolicies: [
              { transitionToIA: "AFTER_30_DAYS" },
              { transitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
            ],
            policy: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "AllowMountViaMountTarget",
                  Effect: "Allow",
                  Principal: { AWS: "*" },
                  Action: [
                    "elasticfilesystem:ClientMount",
                    "elasticfilesystem:ClientWrite",
                  ],
                  Condition: {
                    Bool: {
                      "elasticfilesystem:AccessedViaMountTarget": "true",
                    },
                  },
                },
              ],
            },
            tags: { purpose: "alchemy-efs-test-updated" },
          });
          return { files };
        }),
      );
      expect(updated.files.fileSystemId).toBe(created.files.fileSystemId);

      const lifecycle = yield* efs.describeLifecycleConfiguration({
        FileSystemId: created.files.fileSystemId,
      });
      expect(lifecycle.LifecyclePolicies ?? []).toHaveLength(2);

      // the PolicyDocument round-trips as the file system policy
      const storedPolicy = yield* efs
        .describeFileSystemPolicy({
          FileSystemId: created.files.fileSystemId,
        })
        .pipe(Effect.map((r) => r.Policy ?? ""));
      expect(storedPolicy).toContain("AllowMountViaMountTarget");

      const retagged = yield* efs
        .describeFileSystems({ FileSystemId: created.files.fileSystemId })
        .pipe(Effect.map((r) => efsTagsToRecord(r.FileSystems![0].Tags)));
      expect(retagged.purpose).toBe("alchemy-efs-test-updated");

      // backup: true converged (ENABLING settles to ENABLED asynchronously)
      const backupStatus = yield* efs
        .describeBackupPolicy({ FileSystemId: created.files.fileSystemId })
        .pipe(Effect.map((r) => r.BackupPolicy?.Status));
      expect(["ENABLED", "ENABLING"]).toContain(backupStatus);

      // replication overwrite protection converged to DISABLED
      const protection = yield* efs
        .describeFileSystems({ FileSystemId: created.files.fileSystemId })
        .pipe(
          Effect.map(
            (r) =>
              r.FileSystems![0].FileSystemProtection
                ?.ReplicationOverwriteProtection,
          ),
        );
      expect(protection).toBe("DISABLED");

      // --- re-deploy: an equivalent PolicyDocument (statement keys in a
      //     different order) is a no-op — the normalized comparison skips
      //     the put and the stored policy is untouched. The tag change
      //     forces the reconcile to actually run.
      yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("Files", {
            throughputMode: "elastic",
            lifecyclePolicies: [
              { transitionToIA: "AFTER_30_DAYS" },
              { transitionToPrimaryStorageClass: "AFTER_1_ACCESS" },
            ],
            policy: {
              Version: "2012-10-17",
              Statement: [
                {
                  Condition: {
                    Bool: {
                      "elasticfilesystem:AccessedViaMountTarget": "true",
                    },
                  },
                  Action: [
                    "elasticfilesystem:ClientMount",
                    "elasticfilesystem:ClientWrite",
                  ],
                  Principal: { AWS: "*" },
                  Effect: "Allow",
                  Sid: "AllowMountViaMountTarget",
                },
              ],
            },
            tags: { purpose: "alchemy-efs-test-redeploy" },
          });
          return { files };
        }),
      );
      const redeployedPolicy = yield* efs
        .describeFileSystemPolicy({
          FileSystemId: created.files.fileSystemId,
        })
        .pipe(Effect.map((r) => r.Policy ?? ""));
      expect(redeployedPolicy).toBe(storedPolicy);

      // --- update: clearing lifecycle policies + policy converges to
      //     empty / the default policy; backup + protection revert ---
      yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("Files", {
            throughputMode: "elastic",
            backup: false,
            replicationOverwriteProtection: "ENABLED",
            tags: { purpose: "alchemy-efs-test-updated" },
          });
          return { files };
        }),
      );
      const cleared = yield* efs.describeLifecycleConfiguration({
        FileSystemId: created.files.fileSystemId,
      });
      expect(cleared.LifecyclePolicies ?? []).toHaveLength(0);

      // backup: false converged (DISABLING settles asynchronously)
      const backupDisabled = yield* efs
        .describeBackupPolicy({ FileSystemId: created.files.fileSystemId })
        .pipe(
          Effect.map((r) => r.BackupPolicy?.Status ?? "DISABLED"),
          Effect.catchTag("PolicyNotFound", () => Effect.succeed("DISABLED")),
        );
      expect(["DISABLED", "DISABLING"]).toContain(backupDisabled);

      // protection reverted to ENABLED
      const protectionReverted = yield* efs
        .describeFileSystems({ FileSystemId: created.files.fileSystemId })
        .pipe(
          Effect.map(
            (r) =>
              r.FileSystems![0].FileSystemProtection
                ?.ReplicationOverwriteProtection ?? "ENABLED",
          ),
        );
      expect(protectionReverted).toBe("ENABLED");

      // removing the policy prop reverts to the default policy — the
      // explicit policy is gone (typed PolicyNotFound)
      const policyGone = yield* efs
        .describeFileSystemPolicy({
          FileSystemId: created.files.fileSystemId,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("PolicyNotFound", () => Effect.succeed(true)),
        );
      expect(policyGone).toBe(true);

      // --- list ---
      const provider = yield* Provider.findProvider(AWS.EFS.FileSystem);
      const all = yield* provider.list();
      expect(
        all.some((f) => f.fileSystemId === created.files.fileSystemId),
      ).toBe(true);

      // --- delete + typed wait-until-gone ---
      yield* stack.destroy();
      const gone = yield* waitUntilFileSystemGone(created.files.fileSystemId);
      expect(gone).toBe(true);
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing encryption replaces the file system",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("ReplaceFiles", {
            encrypted: false,
          });
          return { files };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("ReplaceFiles", {
            encrypted: true,
          });
          return { files };
        }),
      );

      expect(second.files.fileSystemId).not.toBe(first.files.fileSystemId);

      const observed = yield* efs
        .describeFileSystems({ FileSystemId: second.files.fileSystemId })
        .pipe(Effect.map((r) => r.FileSystems![0]));
      expect(observed.Encrypted).toBe(true);

      // the replaced (unencrypted) file system must be gone
      const oldGone = yield* waitUntilFileSystemGone(first.files.fileSystemId);
      expect(oldGone).toBe(true);

      yield* stack.destroy();
      const gone = yield* waitUntilFileSystemGone(second.files.fileSystemId);
      expect(gone).toBe(true);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 120_000 },
);
