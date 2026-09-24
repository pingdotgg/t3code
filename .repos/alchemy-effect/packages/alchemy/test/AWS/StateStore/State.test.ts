import * as AWS from "@/AWS";
import { makeS3State } from "@/AWS";
import { createStateBucketName } from "@/AWS/StateStore/State.ts";
import type { ResourceState, StateService } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "PR1587 fresh state services skip matching KMS encryption writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucket, first, second } = yield* stack.deploy(
        Effect.gen(function* () {
          const first = yield* AWS.KMS.Key("FirstStateKey", {
            deletionWindow: "7 days",
          });
          const second = yield* AWS.KMS.Key("SecondStateKey", {
            deletionWindow: "7 days",
          });
          const bucket = yield* AWS.S3.Bucket("IdentityStateBucket", {
            encryption: {
              sseAlgorithm: "aws:kms",
              kmsMasterKeyId: first.keyArn,
            },
          });
          return { bucket, first, second };
        }),
      );
      const initialize = (key: string, bucketKeyEnabled?: boolean) =>
        Effect.gen(function* () {
          const state = yield* makeS3State({
            bucketName: bucket.bucketName,
            prefix: "pr1587",
            encryption: {
              sseAlgorithm: "aws:kms",
              kmsMasterKeyId: key,
              bucketKeyEnabled,
            },
          });
          return yield* state.listStacks();
        });
      expect(yield* initialize(first.keyArn)).toEqual([]);
      const observed = yield* s3.getBucketEncryption({
        Bucket: bucket.bucketName,
      });
      const decoded =
        observed.ServerSideEncryptionConfiguration!.Rules[0]!
          .ApplyServerSideEncryptionByDefault!.KMSMasterKeyID;
      expect(Redacted.isRedacted(decoded)).toBe(true);
      expect(
        Redacted.isRedacted(decoded) ? Redacted.value(decoded) : decoded,
      ).toBe(first.keyArn);
      const write = s3.putBucketEncryption({
        Bucket: bucket.bucketName,
        ServerSideEncryptionConfiguration:
          observed.ServerSideEncryptionConfiguration!,
      });
      const deniedWrite = write.pipe(
        Effect.as(false),
        Effect.catchTag("AccessDeniedException", () => Effect.succeed(true)),
      );
      yield* Effect.gen(function* () {
        yield* s3.putBucketPolicy({
          Bucket: bucket.bucketName,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Deny",
                Principal: "*",
                Action: "s3:PutEncryptionConfiguration",
                Resource: bucket.bucketArn,
              },
            ],
          }),
        });
        expect(
          yield* deniedWrite.pipe(
            Effect.repeat({
              until: Boolean,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          ),
        ).toBe(true);
        // Each call constructs a fresh service, bypassing the per-service initialization cache.
        expect(yield* initialize(first.keyArn)).toEqual([]);
        expect(yield* initialize(first.keyArn, false)).toEqual([]);
        expect(yield* deniedWrite).toBe(true);
      }).pipe(
        Effect.ensuring(
          s3
            .deleteBucketPolicy({ Bucket: bucket.bucketName })
            .pipe(Effect.orDie),
        ),
      );
      yield* write.pipe(
        Effect.retry({
          while: (error) => error._tag === "AccessDeniedException",
          schedule: Schedule.spaced("1 second"),
          times: 8,
        }),
      );

      yield* initialize(second.keyArn);
      const changed = (yield* s3.getBucketEncryption({
        Bucket: bucket.bucketName,
      })).ServerSideEncryptionConfiguration!.Rules[0]!
        .ApplyServerSideEncryptionByDefault!.KMSMasterKeyID;
      expect(
        Redacted.isRedacted(changed) ? Redacted.value(changed) : changed,
      ).toBe(second.keyArn);
      yield* initialize(second.keyArn, true);
      expect(
        (yield* s3.getBucketEncryption({ Bucket: bucket.bucketName }))
          .ServerSideEncryptionConfiguration?.Rules[0]?.BucketKeyEnabled,
      ).toBe(true);
      const defaultState = yield* makeS3State({
        bucketName: bucket.bucketName,
        prefix: "pr1587",
      });
      expect(yield* defaultState.listStacks()).toEqual([]);
      const defaults = (yield* s3.getBucketEncryption({
        Bucket: bucket.bucketName,
      })).ServerSideEncryptionConfiguration!.Rules[0]!;
      expect(defaults.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe(
        "AES256",
      );
      expect(
        defaults.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID,
      ).toBeUndefined();
      expect(defaults.BucketKeyEnabled ?? false).toBe(false);
      expect(defaults.BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
      yield* stack.destroy();
      const absent = yield* s3
        .getBucketLocation({ Bucket: bucket.bucketName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
          Effect.repeat({
            until: Boolean,
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );
      expect(absent).toBe(true);
      for (const key of [first, second]) {
        expect(
          (yield* kms.describeKey({ KeyId: key.keyId })).KeyMetadata?.KeyState,
        ).toBe("PendingDeletion");
      }
    }),
  { timeout: 120_000 },
);

for (const blocked of ["SSE-C", "NONE"] as const) {
  test.provider(
    `state initialization restores encryption defaults after external ${blocked} settings`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const bucket = yield* stack.deploy(
          AWS.S3.Bucket("EncryptionBlocksStateBucket", {}),
        );
        const initialize = Effect.gen(function* () {
          const state = yield* makeS3State({
            bucketName: bucket.bucketName,
            prefix: "pr1588",
          });
          return yield* state.listStacks();
        });
        expect(yield* initialize).toEqual([]);
        yield* s3.putBucketEncryption({
          Bucket: bucket.bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
                BlockedEncryptionTypes: { EncryptionType: [blocked] },
              },
            ],
          },
        });
        const before = (yield* s3.getBucketEncryption({
          Bucket: bucket.bucketName,
        })).ServerSideEncryptionConfiguration!.Rules[0]!;
        expect(before.BlockedEncryptionTypes?.EncryptionType).toEqual([
          blocked,
        ]);
        expect(before.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe(
          "aws:kms",
        );
        // Re-running the generator constructs a fresh state service and rechecks cloud configuration.
        expect(yield* initialize).toEqual([]);
        const after = (yield* s3.getBucketEncryption({
          Bucket: bucket.bucketName,
        })).ServerSideEncryptionConfiguration!.Rules[0]!;
        expect(after.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe(
          "AES256",
        );
        expect(
          after.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID,
        ).toBeUndefined();
        expect(after.BucketKeyEnabled ?? false).toBe(false);
        expect(after.BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
        yield* stack.destroy();
        const absent = yield* s3
          .getBucketLocation({ Bucket: bucket.bucketName })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
            Effect.repeat({
              until: Boolean,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
        expect(absent).toBe(true);
      }),
    { timeout: 120_000 },
  );
}

test.provider(
  "state services manage encryption blocks and restore defaults on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucket, blockedBucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket(
            "ManagedStateEncryptionBlocks",
            {},
          );
          const blockedBucket = yield* AWS.S3.Bucket(
            "BlockedNoOpStateBucket",
            {},
          );
          return { bucket, blockedBucket };
        }),
      );
      const initialize = (
        blockedEncryptionTypes: AWS.S3.BucketEncryption["blockedEncryptionTypes"],
        bucketName = bucket.bucketName,
      ) =>
        Effect.gen(function* () {
          const state = yield* makeS3State({
            bucketName,
            prefix: "pr1588-managed",
            encryption: { sseAlgorithm: "AES256", blockedEncryptionTypes },
          });
          return yield* state.listStacks();
        });
      const readRule = s3
        .getBucketEncryption({ Bucket: bucket.bucketName })
        .pipe(
          Effect.map(
            (result) => result.ServerSideEncryptionConfiguration!.Rules[0]!,
          ),
        );
      const block = s3.putBucketEncryption({
        Bucket: bucket.bucketName,
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
              BlockedEncryptionTypes: { EncryptionType: ["SSE-C"] },
            },
          ],
        },
      });
      yield* block;
      expect(yield* initialize([])).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual([
        "NONE",
      ]);
      yield* block;
      expect(yield* initialize([])).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual([
        "NONE",
      ]);
      expect(yield* initialize(["SSE-C"])).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual([
        "SSE-C",
      ]);
      expect(yield* initialize(undefined)).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual([
        "NONE",
      ]);

      // Keep each deny policy until bucket deletion; policy removal is eventually consistent.
      const settings: "SSE-C"[][] = [[], ["SSE-C"]];
      for (const types of settings) {
        const target = types.length ? blockedBucket : bucket;
        expect(yield* initialize(types, target.bucketName)).toEqual([]);
        const rule = (yield* s3.getBucketEncryption({
          Bucket: target.bucketName,
        })).ServerSideEncryptionConfiguration!.Rules[0]!;
        expect(rule.BlockedEncryptionTypes?.EncryptionType).toEqual(
          types.length ? ["SSE-C"] : ["NONE"],
        );
        const probeWrite = s3
          .putBucketEncryption({
            Bucket: target.bucketName,
            ServerSideEncryptionConfiguration: {
              Rules: [
                {
                  ApplyServerSideEncryptionByDefault: {
                    SSEAlgorithm: "AES256",
                  },
                  BucketKeyEnabled: false,
                  BlockedEncryptionTypes: {
                    EncryptionType: types.length ? types : ["NONE"],
                  },
                },
              ],
            },
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("AccessDeniedException", () =>
              Effect.succeed(true),
            ),
          );
        yield* s3.putBucketPolicy({
          Bucket: target.bucketName,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Deny",
                Principal: "*",
                Action: "s3:PutEncryptionConfiguration",
                Resource: target.bucketArn,
              },
            ],
          }),
        });
        expect(
          yield* probeWrite.pipe(
            Effect.repeat({
              until: Boolean,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          ),
        ).toBe(true);
        expect(
          yield* initialize([...types, ...types], target.bucketName),
        ).toEqual([]);
        if (!types.length) {
          expect(yield* initialize(undefined, target.bucketName)).toEqual([]);
        }
        expect(yield* probeWrite).toBe(true);
      }
      yield* stack.destroy();
      for (const target of [bucket, blockedBucket]) {
        const absent = yield* s3
          .getBucketLocation({ Bucket: target.bucketName })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
            Effect.repeat({
              until: Boolean,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
        expect(absent).toBe(true);
      }
    }),
  { timeout: 120_000 },
);

const STACK = "S3StateStoreTestStack";

/**
 * Guaranteed out-of-band cleanup: `deleteStack` is idempotent (list +
 * batched delete), and `Effect.orDie` collapses the finalizer's error
 * channel to `never` so it is a valid `Effect.ensuring` finalizer.
 * Every test pre-cleans AND finalizes with this so a failing assertion
 * can never leave state objects behind in the bucket.
 */
const cleanStage = (state: StateService, stage: string) =>
  state.deleteStack({ stack: STACK, stage }).pipe(Effect.orDie);

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

test.provider(
  "set/get/list/delete round-trips state through S3",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(
        AWS.S3.Bucket("StateBucket", { forceDestroy: true }),
      );
      const state = yield* makeS3State({
        bucketName: bucket.bucketName,
        prefix: "test-state",
      });
      const stage = "round-trip";

      // start from a clean slate (idempotent)
      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const a = resource("Parent/ResourceA", { value: "a" });
        const b = resource("ResourceB", { value: "b" });

        yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
        yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });

        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(
          a,
        );
        expect(
          yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" }),
        ).toBeUndefined();

        const fqns = yield* state.list({ stack: STACK, stage });
        expect([...fqns].sort()).toEqual(["Parent/ResourceA", "ResourceB"]);

        expect(yield* state.listStacks()).toContain(STACK);
        expect(yield* state.listStages(STACK)).toContain(stage);

        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
        expect(
          yield* state.get({ stack: STACK, stage, fqn: a.fqn }),
        ).toBeUndefined();
        // deleting a missing resource is a no-op
        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "existing state buckets converge to secure defaults",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWS.AWSEnvironment.current;
      const suffix = yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      );
      const bucketName = createStateBucketName(
        `security-${suffix}-${accountId}`,
        region,
      );
      const deleteBucket = s3.deleteBucket({ Bucket: bucketName }).pipe(
        Effect.catchTag("NoSuchBucket", () => Effect.void),
        Effect.orDie,
      );

      yield* s3
        .deleteBucket({ Bucket: bucketName })
        .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));

      yield* Effect.gen(function* () {
        // First create the bucket, then simulate out-of-band configuration
        // drift. The second state service targets the SAME existing bucket and
        // must repair every setting from observed cloud state.
        const initial = yield* makeS3State({
          bucketName,
          prefix: "security-test",
        });
        yield* initial.listStacks();

        yield* s3.putBucketVersioning({
          Bucket: bucketName,
          VersioningConfiguration: { Status: "Suspended" },
        });
        yield* s3.putBucketEncryption({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  SSEAlgorithm: "aws:kms",
                },
              },
            ],
          },
        });
        yield* s3.putPublicAccessBlock({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false,
          },
        });
        yield* s3.putBucketOwnershipControls({
          Bucket: bucketName,
          OwnershipControls: {
            Rules: [{ ObjectOwnership: "ObjectWriter" }],
          },
        });

        const secured = yield* makeS3State({
          bucketName,
          prefix: "security-test",
        });
        yield* secured.listStacks();

        const versioning = yield* s3.getBucketVersioning({
          Bucket: bucketName,
        });
        expect(versioning.Status).toBe("Enabled");

        const encryption = yield* s3.getBucketEncryption({
          Bucket: bucketName,
        });
        expect(
          encryption.ServerSideEncryptionConfiguration?.Rules?.[0]
            ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
        ).toBe("AES256");

        const publicAccess = yield* s3.getPublicAccessBlock({
          Bucket: bucketName,
        });
        expect(publicAccess.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        });

        const ownership = yield* s3.getBucketOwnershipControls({
          Bucket: bucketName,
        });
        expect(ownership.OwnershipControls?.Rules?.[0]?.ObjectOwnership).toBe(
          "BucketOwnerEnforced",
        );
      }).pipe(Effect.ensuring(deleteBucket));
    }),
  { timeout: 120_000 },
);

test.provider(
  "stack outputs are stored separately from resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(
        AWS.S3.Bucket("StateBucket", { forceDestroy: true }),
      );
      const state = yield* makeS3State({
        bucketName: bucket.bucketName,
        prefix: "test-state",
      });
      const stage = "outputs";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();

        yield* state.setOutput({
          stack: STACK,
          stage,
          value: { url: "https://example.com" },
        });
        expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
          url: "https://example.com",
        });

        // the output bookkeeping object must not leak into list()
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "getReplacedResources returns only replaced resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(
        AWS.S3.Bucket("StateBucket", { forceDestroy: true }),
      );
      const state = yield* makeS3State({
        bucketName: bucket.bucketName,
        prefix: "test-state",
      });
      const stage = "replaced";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const created = resource("Created", { value: "created" });
        const replaced = {
          ...resource("Replaced", { value: "replaced" }),
          status: "replaced",
        } as ResourceState;

        yield* state.set({
          stack: STACK,
          stage,
          fqn: created.fqn,
          value: created,
        });
        yield* state.set({
          stack: STACK,
          stage,
          fqn: replaced.fqn,
          value: replaced,
        });

        const result = yield* state.getReplacedResources({
          stack: STACK,
          stage,
        });
        expect(result.map((r) => r.fqn)).toEqual(["Replaced"]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
