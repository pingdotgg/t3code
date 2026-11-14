import { createHash } from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import { makeS3State } from "@alchemy.run/aws";
import { createStateBucketName } from "@alchemy.run/aws/StateStore/State";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as kms from "@distilled.cloud/aws/kms";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Alchemy from "alchemy";
import { StateStoreError, type ResourceState, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

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
        observed.ServerSideEncryptionConfiguration!.Rules[0]!.ApplyServerSideEncryptionByDefault!
          .KMSMasterKeyID;
      expect(Redacted.isRedacted(decoded)).toBe(true);
      expect(Redacted.isRedacted(decoded) ? Redacted.value(decoded) : decoded).toBe(first.keyArn);
      const write = s3.putBucketEncryption({
        Bucket: bucket.bucketName,
        ServerSideEncryptionConfiguration: observed.ServerSideEncryptionConfiguration!,
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
        Effect.ensuring(s3.deleteBucketPolicy({ Bucket: bucket.bucketName }).pipe(Effect.orDie)),
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
      })).ServerSideEncryptionConfiguration!.Rules[0]!.ApplyServerSideEncryptionByDefault!
        .KMSMasterKeyID;
      expect(Redacted.isRedacted(changed) ? Redacted.value(changed) : changed).toBe(second.keyArn);
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
      expect(defaults.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("AES256");
      expect(defaults.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID).toBeUndefined();
      expect(defaults.BucketKeyEnabled ?? false).toBe(false);
      expect(defaults.BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
      yield* stack.destroy();
      const absent = yield* s3.getBucketLocation({ Bucket: bucket.bucketName }).pipe(
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
        expect((yield* kms.describeKey({ KeyId: key.keyId })).KeyMetadata?.KeyState).toBe(
          "PendingDeletion",
        );
      }
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:kms",
      "provider:aws:s3",
      "provider:aws:statestore",
      "live",
    ],
    timeout: 120_000,
  },
);

for (const blocked of ["SSE-C", "NONE"] as const) {
  test.provider(
    `state initialization restores encryption defaults after external ${blocked} settings`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const bucket = yield* stack.deploy(AWS.S3.Bucket("EncryptionBlocksStateBucket", {}));
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
        expect(before.BlockedEncryptionTypes?.EncryptionType).toEqual([blocked]);
        expect(before.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("aws:kms");
        // Re-running the generator constructs a fresh state service and rechecks cloud configuration.
        expect(yield* initialize).toEqual([]);
        const after = (yield* s3.getBucketEncryption({
          Bucket: bucket.bucketName,
        })).ServerSideEncryptionConfiguration!.Rules[0]!;
        expect(after.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("AES256");
        expect(after.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID).toBeUndefined();
        expect(after.BucketKeyEnabled ?? false).toBe(false);
        expect(after.BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
        yield* stack.destroy();
        const absent = yield* s3.getBucketLocation({ Bucket: bucket.bucketName }).pipe(
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
    {
      tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
      timeout: 120_000,
    },
  );
}

test.provider(
  "state services manage encryption blocks and restore defaults on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucket, blockedBucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("ManagedStateEncryptionBlocks", {});
          const blockedBucket = yield* AWS.S3.Bucket("BlockedNoOpStateBucket", {});
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
        .pipe(Effect.map((result) => result.ServerSideEncryptionConfiguration!.Rules[0]!));
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
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
      yield* block;
      expect(yield* initialize([])).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);
      expect(yield* initialize(["SSE-C"])).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual(["SSE-C"]);
      expect(yield* initialize(undefined)).toEqual([]);
      expect((yield* readRule).BlockedEncryptionTypes?.EncryptionType).toEqual(["NONE"]);

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
            Effect.catchTag("AccessDeniedException", () => Effect.succeed(true)),
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
        expect(yield* initialize([...types, ...types], target.bucketName)).toEqual([]);
        if (!types.length) {
          expect(yield* initialize(undefined, target.bucketName)).toEqual([]);
        }
        expect(yield* probeWrite).toBe(true);
      }
      yield* stack.destroy();
      for (const target of [bucket, blockedBucket]) {
        const absent = yield* s3.getBucketLocation({ Bucket: target.bucketName }).pipe(
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
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
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
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
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

        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
        expect(yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" })).toBeUndefined();

        const fqns = yield* state.list({ stack: STACK, stage });
        expect([...fqns].sort()).toEqual(["Parent/ResourceA", "ResourceB"]);

        expect(yield* state.listStacks()).toContain(STACK);
        expect(yield* state.listStages(STACK)).toContain(stage);

        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toBeUndefined();
        // deleting a missing resource is a no-op
        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

// State objects hold generated secrets, and the AWS client logs request
// payloads and parsed responses at Debug. A Debug floor where the store is
// built (the CLI's run log sets one) must not put state contents in the logs.
test.provider(
  "state contents stay out of Debug logs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(
        AWS.S3.Bucket("LoggingStateBucket", { forceDestroy: true }),
      );
      const secret = "state-logging-secret-0123456789";
      const stage = "logging";

      // Record every log line emitted at a Debug floor.
      const atDebug = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const lines: string[] = [];
          const logger = Logger.make<unknown, void>((options) => {
            lines.push(
              JSON.stringify(options.message, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
            );
          });
          const result = yield* effect.pipe(
            Effect.provide(Logger.layer([logger])),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          );
          return { result, logs: lines.join("\n") };
        });

      const { logs } = yield* atDebug(
        Effect.gen(function* () {
          const state = yield* makeS3State({ bucketName: bucket.bucketName, prefix: "logging" });
          const value = resource("SecretHolder", { token: secret });
          yield* state.set({ stack: STACK, stage, fqn: value.fqn, value });
          expect(yield* state.get({ stack: STACK, stage, fqn: value.fqn })).toEqual(value);
          yield* state.deleteStack({ stack: STACK, stage });
        }),
      );
      expect(logs).not.toContain(secret);

      // Control: the same payload sent directly is logged at Debug, so the
      // capture above is real.
      const control = yield* atDebug(
        s3.putObject({ Bucket: bucket.bucketName, Key: "control", Body: secret }),
      );
      expect(control.logs).toContain(secret);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "existing state buckets converge to secure defaults",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWS.AWSEnvironment.current;
      const suffix = yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      );
      const bucketName = createStateBucketName(`security-${suffix}-${accountId}`, region);
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

        // Bucket configuration reads are eventually consistent. Observe the
        // injected drift before reconciliation, or a stale AES256 read can
        // incorrectly make the provider conclude that no repair is needed.
        const driftedEncryption = yield* s3.getBucketEncryption({ Bucket: bucketName }).pipe(
          Effect.map(
            (result) =>
              result.ServerSideEncryptionConfiguration?.Rules?.[0]
                ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
          ),
          Effect.repeat({
            until: (algorithm) => algorithm === "aws:kms",
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );
        expect(driftedEncryption).toBe("aws:kms");

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
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "stack outputs are stored separately from resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
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
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "getReplacedResources returns only replaced resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
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
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "a second S3 state store cannot write a stage another deploy holds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
      const options = { bucketName: bucket.bucketName, prefix: "lease" };
      const stage = "race";
      const created = resource("Vpc", { vpcId: "vpc-aaaa" });
      const request = { stack: STACK, stage, fqn: created.fqn, value: created };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* makeS3State(options);
          yield* held.set(request);
          const other = yield* makeS3State(options);
          const error = yield* other
            .set({ ...request, value: { ...created, attr: { vpcId: "vpc-bbbb" } } })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("another deploy holds the S3 state lock");
          expect(yield* held.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-aaaa" },
          });
          // The lease object is not a resource row.
          expect(yield* held.list({ stack: STACK, stage })).toEqual([created.fqn]);
        }),
      );

      // The first store's scope has closed, so the lease is expired and the
      // next deploy of this stage can write.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const next = yield* makeS3State(options);
          yield* next.set({ ...request, value: { ...created, attr: { vpcId: "vpc-cccc" } } });
          expect(yield* next.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-cccc" },
          });
          yield* next.deleteStack({ stack: STACK, stage });
        }),
      );

      // Closing the store deletes its lease, so a destroyed stage is no
      // longer listed.
      const after = yield* makeS3State(options);
      expect(yield* after.listStages(STACK)).not.toContain(stage);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "an expired S3 state lease can be taken and a live one cannot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
      const prefix = "lease-expiry";
      const state = yield* makeS3State({ bucketName: bucket.bucketName, prefix });
      const expiredStage = "expired";
      const heldStage = "held";
      const leaseKey = (stage: string) => `${prefix}/${STACK}/${stage}/__lease__.json`;
      const putLease = (stage: string, expiresAt: number) =>
        s3.putObject({
          Bucket: bucket.bucketName,
          Key: leaseKey(stage),
          Body: JSON.stringify({ token: "foreign", expiresAt }),
          ContentType: "application/json",
        });

      yield* putLease(expiredStage, 0);
      const created = resource("Group", { groupId: "sg-aaaa" });
      yield* state.set({
        stack: STACK,
        stage: expiredStage,
        fqn: created.fqn,
        value: created,
      });
      expect(yield* state.list({ stack: STACK, stage: expiredStage })).toEqual([created.fqn]);

      yield* putLease(heldStage, Date.now() + 60_000);
      const blocked = yield* state
        .set({
          stack: STACK,
          stage: heldStage,
          fqn: created.fqn,
          value: created,
        })
        .pipe(Effect.flip);
      expect(blocked).toBeInstanceOf(StateStoreError);
      expect(blocked.message).toContain("another deploy holds the S3 state lock");

      yield* s3.deleteObject({ Bucket: bucket.bucketName, Key: leaseKey(heldStage) });
      yield* state.deleteStack({ stack: STACK, stage: expiredStage });
      yield* state.deleteStack({ stack: STACK, stage: heldStage });
      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

// A large deploy can queue its lease refresh behind thousands of state
// writes until the lease lapses. Nobody else took it, so the deploy keeps
// going; a deploy that did take it wins.
test.provider(
  "a lease that lapsed while still held is taken back unless another deploy took it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(AWS.S3.Bucket("StateBucket", { forceDestroy: true }));
      const options = { bucketName: bucket.bucketName, prefix: "lease-lapse" };
      const stage = "lapse";
      const key = `lease-lapse/${STACK}/${stage}/__lease__.json`;
      const created = resource("Queue", { queueUrl: "https://example.com/a" });
      const request = { stack: STACK, stage, fqn: created.fqn, value: created };
      const lapse = Effect.gen(function* () {
        const object = yield* s3.getObject({ Bucket: bucket.bucketName, Key: key });
        const lease = JSON.parse(yield* Stream.mkString(Stream.decodeText(object.Body!)));
        yield* s3.putObject({
          Bucket: bucket.bucketName,
          Key: key,
          Body: JSON.stringify({ ...lease, expiresAt: 0 }),
          ContentType: "application/json",
        });
      });
      // Past the store's 5s trust in its last lease check.
      const pastCheck = Effect.sleep("6 seconds");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* makeS3State(options);
          yield* held.set(request);
          yield* lapse;
          yield* pastCheck;
          yield* held.set({ ...request, value: { ...created, attr: { queueUrl: "b" } } });
          expect(yield* held.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { queueUrl: "b" },
          });

          // Lapsed again, and this time another deploy takes it.
          yield* lapse;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const other = yield* makeS3State(options);
              yield* other.list({ stack: STACK, stage });
              yield* pastCheck;
              const lost = yield* held.set(request).pipe(Effect.flip);
              expect(lost.message).toContain("was lost mid-run");
              yield* other.deleteStack({ stack: STACK, stage });
            }),
          );
        }),
      );
      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:statestore", "live"],
    timeout: 120_000,
  },
);

// Each deploy/destroy of a Stack declaring the S3 state store releases its
// lease when it finishes, so a file can redeploy and destroy that Stack.
const s3Stack = { providers: AWS.providers(), state: AWS.state({ backend: "s3" }) };
const s3Harness = Test.make(s3Stack);

const S3StateStack = Alchemy.Stack(
  "S3StateHarness",
  s3Stack,
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("HarnessQueue");
    return { queueUrl: queue.queueUrl };
  }),
);

describe(
  "a Stack with the S3 state store",
  { tags: ["provider:aws", "provider:aws:sqs", "provider:aws:statestore", "live"] },
  () => {
    const deployed = s3Harness.beforeAll(s3Harness.deploy(S3StateStack), { timeout: 120_000 });

    s3Harness.afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.gen(function* () {
        const { queueUrl } = yield* deployed;
        yield* s3Harness.destroy(S3StateStack);
        const gone = yield* Core.withProviders(
          sqs.getQueueAttributes({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }).pipe(
            Effect.as(false),
            Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
          ),
          s3Stack,
          "S3StateHarness",
        );
        expect(gone).toBe(true);
      }),
      { timeout: 120_000 },
    );

    s3Harness.test(
      "redeploys after the file's first deploy released its lease",
      Effect.gen(function* () {
        const { queueUrl } = yield* deployed;
        const redeployed = yield* s3Harness.deploy(S3StateStack);
        expect(redeployed.queueUrl).toBe(queueUrl);
      }),
      { timeout: 120_000 },
    );
  },
);
