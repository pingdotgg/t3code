import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("create and delete bucket with default props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.bucketArn).toBeDefined();
    expect(bucket.region).toBeDefined();

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create, update, delete bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "test" },
          forceDestroy: true,
        });
      }),
    );

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    const tagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(tagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "test",
    });

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "production", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );

    const updatedTagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "production",
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Team",
      Value: "platform",
    });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create bucket with custom name", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("CustomNameBucket", {
          bucketName: "alchemy-test-bucket-custom-name",
          forceDestroy: true,
        });
      }),
    );

    expect(bucket.bucketName).toEqual("alchemy-test-bucket-custom-name");
    expect(bucket.bucketArn).toEqual(
      "arn:aws:s3:::alchemy-test-bucket-custom-name",
    );

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("create bucket with forceDestroy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ForceDestroyBucket", {
          bucketName: "alchemy-test-bucket-force-destroy",
          forceDestroy: true,
        });
      }),
    );

    yield* S3.putObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
      Body: "Hello, World!",
    });

    // A heavily parallel account sweep can briefly observe the successful
    // PutObject before the object is readable through a different S3
    // endpoint. Retry only the typed visibility miss, with a hard bound;
    // authorization and request-shape errors still fail immediately.
    yield* S3.headObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "NotFound",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(6)]),
      }),
    );

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("idempotent create - bucket already exists", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket1 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket1.bucketName;

    const bucket2 = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    expect(bucket2.bucketName).toEqual(bucketName);

    yield* stack.destroy();

    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("create bucket with objectLockEnabled", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ObjectLockBucket", {
          bucketName: "alchemy-test-bucket-object-lock",
          objectLockEnabled: true,
          forceDestroy: true,
        });
      }),
    );

    const objectLockConfig = yield* S3.getObjectLockConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(objectLockConfig.ObjectLockConfiguration?.ObjectLockEnabled).toEqual(
      "Enabled",
    );

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("remove all tags from bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          tags: { Environment: "test", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket.bucketName;

    const tagging = yield* S3.getBucketTagging({
      Bucket: bucketName,
    });
    expect(tagging.TagSet).toHaveLength(2);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          forceDestroy: true,
        });
      }),
    );

    const result = yield* S3.getBucketTagging({
      Bucket: bucketName,
    }).pipe(
      Effect.map(() => "has-tags" as const),
      Effect.catchTag("NoSuchTagSet", () => Effect.succeed("no-tags" as const)),
    );
    expect(result).toEqual("no-tags");

    yield* stack.destroy();

    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("create and remove bucket policy from bindings", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const distributionArn =
      "arn:aws:cloudfront::123456789012:distribution/TESTDIST";
    const bucketArn = "arn:aws:s3:::alchemy-test-bucket-policy-bindings";

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });

        yield* bucket.bind("AWS.S3.Policy(TestDistribution, PolicyBucket)", {
          policyStatements: [
            {
              Effect: "Allow",
              Principal: {
                Service: "cloudfront.amazonaws.com",
              },
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": distributionArn,
                },
              },
            },
          ],
        });

        return bucket;
      }),
    );

    const bucketPolicy = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(Effect.map((response) => JSON.parse(response.Policy!)));
    const statement = bucketPolicy.Statement[0];

    expect(bucketPolicy.Version).toEqual("2012-10-17");
    expect(statement.Effect).toEqual("Allow");
    expect(statement.Principal).toEqual({
      Service: "cloudfront.amazonaws.com",
    });
    expect(statement.Action).toEqual("s3:GetObject");
    expect(statement.Resource).toEqual(`${bucketArn}/*`);
    expect(statement.Condition).toEqual({
      StringEquals: {
        "AWS:SourceArn": distributionArn,
      },
    });

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });
      }),
    );

    const policyAfterRemoval = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(
      Effect.map(() => "has-policy" as const),
      Effect.catchTag("NoSuchBucketPolicy", () =>
        Effect.succeed("no-policy" as const),
      ),
    );

    expect(policyAfterRemoval).toEqual("no-policy");

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

// Engine-level adoption: S3 has no per-stack ownership signal (we don't
// stamp alchemy tags on buckets — the canonical existence check is
// `headBucket`, which only succeeds when the bucket is owned by *this AWS
// account*). So a name match means we own it at the account level — silent
// adoption is correct for the cold-start case.
test.provider(
  "owned bucket (account-level) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Deterministic name: the state wipe below intentionally makes the
      // bucket invisible to the scratch stack's auto-destroy for a window, so
      // the name must be stable across runs — a re-run then reclaims any
      // orphan left by a previously-killed run instead of minting a new one.
      const bucketName = "alchemy-test-s3-adopt-bucket";

      // Idempotent pre-clean: reclaim a leftover from a prior interrupted run.
      yield* deleteBucketIfExists(bucketName);

      yield* Effect.gen(function* () {
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Bucket("AdoptableBucket", {
              bucketName,
              forceDestroy: true,
            });
          }),
        );
        expect(initial.bucketName).toEqual(bucketName);

        // Wipe state — bucket stays in S3.
        yield* Effect.gen(function* () {
          const state = yield* yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableBucket",
          });
        }).pipe(Effect.provide(stack.state));

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Bucket("AdoptableBucket", {
              bucketName,
              forceDestroy: true,
            });
          }),
        );

        expect(adopted.bucketArn).toEqual(initial.bucketArn);

        yield* stack.destroy();
        yield* assertBucketDeleted(bucketName);
      }).pipe(
        // Guaranteed out-of-band cleanup: while state is wiped the bucket is
        // outside the scratch stack, so the framework's ensuring-destroy can't
        // see it. This finalizer runs on success, failure, AND interruption;
        // it's a no-op when stack.destroy already deleted the bucket.
        Effect.ensuring(deleteBucketIfExists(bucketName).pipe(Effect.ignore)),
      );
    }),
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// real bucket, resolve the provider from context via `findProviderByType`,
// call `list()`, and assert the deployed bucket appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ListBucket", {
          bucketName: "alchemy-test-bucket-list",
          forceDestroy: true,
        });
      }),
    );

    const provider = yield* Provider.findProvider(Bucket);
    const all = yield* provider.list();

    expect(all.some((b) => b.bucketName === bucket.bucketName)).toBe(true);

    yield* stack.destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("versioning enable then suspend", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-versioning";
    const bucket = yield* stack.deploy(
      Bucket("VersioningBucket", {
        bucketName: name,
        versioning: "Enabled",
        forceDestroy: true,
      }),
    );

    const v1 = yield* S3.getBucketVersioning({ Bucket: bucket.bucketName });
    expect(v1.Status).toEqual("Enabled");

    yield* stack.deploy(
      Bucket("VersioningBucket", {
        bucketName: name,
        versioning: "Suspended",
        forceDestroy: true,
      }),
    );

    const v2 = yield* S3.getBucketVersioning({ Bucket: bucket.bucketName });
    expect(v2.Status).toEqual("Suspended");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("encryption SSE-S3 set and update bucketKey", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-encryption";
    const bucket = yield* stack.deploy(
      Bucket("EncryptionBucket", {
        bucketName: name,
        encryption: { sseAlgorithm: "AES256" },
        forceDestroy: true,
      }),
    );

    const e1 = yield* S3.getBucketEncryption({ Bucket: bucket.bucketName });
    expect(
      e1.ServerSideEncryptionConfiguration?.Rules?.[0]
        ?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
    ).toEqual("AES256");

    yield* stack.deploy(
      Bucket("EncryptionBucket", {
        bucketName: name,
        encryption: { sseAlgorithm: "AES256", bucketKeyEnabled: true },
        forceDestroy: true,
      }),
    );

    const e2 = yield* S3.getBucketEncryption({ Bucket: bucket.bucketName });
    expect(
      e2.ServerSideEncryptionConfiguration?.Rules?.[0]?.BucketKeyEnabled,
    ).toEqual(true);

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("public access block set, update, remove", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-pab";
    const bucket = yield* stack.deploy(
      Bucket("PabBucket", {
        bucketName: name,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
        forceDestroy: true,
      }),
    );

    const p1 = yield* S3.getPublicAccessBlock({ Bucket: bucket.bucketName });
    expect(p1.PublicAccessBlockConfiguration?.BlockPublicAcls).toEqual(true);
    expect(p1.PublicAccessBlockConfiguration?.RestrictPublicBuckets).toEqual(
      true,
    );

    yield* stack.deploy(
      Bucket("PabBucket", {
        bucketName: name,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: false,
          blockPublicPolicy: true,
          restrictPublicBuckets: false,
        },
        forceDestroy: true,
      }),
    );

    const p2 = yield* S3.getPublicAccessBlock({ Bucket: bucket.bucketName });
    expect(p2.PublicAccessBlockConfiguration?.RestrictPublicBuckets).toEqual(
      false,
    );

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("cors add rule then remove all", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-cors";
    const bucket = yield* stack.deploy(
      Bucket("CorsBucket", {
        bucketName: name,
        cors: [
          {
            AllowedMethods: ["GET"],
            AllowedOrigins: ["https://example.com"],
            AllowedHeaders: ["*"],
            MaxAgeSeconds: 3000,
          },
        ],
        forceDestroy: true,
      }),
    );

    const c1 = yield* S3.getBucketCors({ Bucket: bucket.bucketName });
    expect(c1.CORSRules).toHaveLength(1);

    yield* stack.deploy(
      Bucket("CorsBucket", {
        bucketName: name,
        cors: [
          {
            AllowedMethods: ["GET"],
            AllowedOrigins: ["https://example.com"],
            AllowedHeaders: ["*"],
            MaxAgeSeconds: 3000,
          },
          {
            AllowedMethods: ["PUT", "POST"],
            AllowedOrigins: ["https://app.example.com"],
          },
        ],
        forceDestroy: true,
      }),
    );

    const c2 = yield* S3.getBucketCors({ Bucket: bucket.bucketName });
    expect(c2.CORSRules).toHaveLength(2);

    yield* stack.deploy(
      Bucket("CorsBucket", {
        bucketName: name,
        cors: [],
        forceDestroy: true,
      }),
    );

    const removed = yield* S3.getBucketCors({ Bucket: bucket.bucketName }).pipe(
      Effect.map(() => "has-cors" as const),
      Effect.catchTag("NoSuchCORSConfiguration", () =>
        Effect.succeed("no-cors" as const),
      ),
    );
    expect(removed).toEqual("no-cors");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("lifecycle add rule then remove", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-lifecycle";
    const bucket = yield* stack.deploy(
      Bucket("LifecycleBucket", {
        bucketName: name,
        lifecycleRules: [
          {
            ID: "expire-logs",
            Status: "Enabled",
            Filter: { Prefix: "logs/" },
            Expiration: { Days: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
        forceDestroy: true,
      }),
    );

    const l1 = yield* S3.getBucketLifecycleConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(l1.Rules).toHaveLength(1);
    expect(l1.Rules?.[0]?.Expiration?.Days).toEqual(30);

    yield* stack.deploy(
      Bucket("LifecycleBucket", {
        bucketName: name,
        lifecycleRules: [],
        forceDestroy: true,
      }),
    );

    // Lifecycle config is eventually consistent — the rule can linger on reads
    // for a few seconds after deleteBucketLifecycle. Retry until it clears.
    const removed = yield* S3.getBucketLifecycleConfiguration({
      Bucket: bucket.bucketName,
    }).pipe(
      Effect.map(() => "has-lifecycle" as const),
      Effect.catchTag("NoSuchLifecycleConfiguration", () =>
        Effect.succeed("no-lifecycle" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (r) => r === "no-lifecycle",
        // S3 lifecycle deletion can take well over 30s to become visible on
        // reads. Give it ~90s (30 × 3s) before failing — the loop short-circuits
        // via `until` the moment the config clears, so this only costs wall-clock
        // time on the (rare) slow-propagation runs that were flaking at times: 10.
        times: 30,
      }),
    );
    expect(removed).toEqual("no-lifecycle");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider(
  "ownership controls and website hosting serves index.html",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const name = "alchemy-test-bucket-website";
      const bucket = yield* stack.deploy(
        Bucket("WebsiteBucket", {
          bucketName: name,
          objectOwnership: "BucketOwnerPreferred",
          // The website endpoint serves anonymously, so the bucket must allow
          // a public-read policy: PAB flags all off + a public GetObject
          // statement. (publicAccessBlock syncs before policy in reconcile.)
          publicAccessBlock: {
            blockPublicAcls: false,
            ignorePublicAcls: false,
            blockPublicPolicy: false,
            restrictPublicBuckets: false,
          },
          policy: [
            {
              Sid: "PublicReadGetObject",
              Effect: "Allow",
              Principal: { AWS: "*" },
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${name}/*`],
            },
          ],
          website: {
            indexDocument: { suffix: "index.html" },
            errorDocument: { key: "error.html" },
          },
          forceDestroy: true,
        }),
      );

      const own = yield* S3.getBucketOwnershipControls({
        Bucket: bucket.bucketName,
      });
      expect(own.OwnershipControls?.Rules?.[0]?.ObjectOwnership).toEqual(
        "BucketOwnerPreferred",
      );

      const web = yield* S3.getBucketWebsite({ Bucket: bucket.bucketName });
      expect(web.IndexDocument?.Suffix).toEqual("index.html");
      expect(web.ErrorDocument?.Key).toEqual("error.html");

      // Prove the website endpoint actually serves: upload an index document
      // and GET it anonymously over HTTP (marker-anchored, with propagation
      // retry — fresh website endpoints can take a few seconds to serve).
      const marker = "alchemy-s3-website-test-marker";
      yield* S3.putObject({
        Bucket: bucket.bucketName,
        Key: "index.html",
        Body: `<html><body>${marker}</body></html>`,
        ContentType: "text/html",
      });

      const websiteUrl = `http://${name}.s3-website-${bucket.region}.amazonaws.com/`;
      const body = yield* HttpClient.get(websiteUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text
            : Effect.fail(
                new Error(`website endpoint returned ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(1000),
            Schedule.recurs(8),
          ]),
        }),
      );
      expect(body).toContain(marker);

      // In-place update of the index document; website config is in-place
      // updatable. (Omitting the prop leaves the config untouched — to clear it
      // a user removes the resource; we never silently drop unmanaged config.)
      yield* stack.deploy(
        Bucket("WebsiteBucket", {
          bucketName: name,
          objectOwnership: "BucketOwnerPreferred",
          publicAccessBlock: {
            blockPublicAcls: false,
            ignorePublicAcls: false,
            blockPublicPolicy: false,
            restrictPublicBuckets: false,
          },
          policy: [
            {
              Sid: "PublicReadGetObject",
              Effect: "Allow",
              Principal: { AWS: "*" },
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${name}/*`],
            },
          ],
          website: {
            indexDocument: { suffix: "home.html" },
            errorDocument: { key: "error.html" },
          },
          forceDestroy: true,
        }),
      );

      const web2 = yield* S3.getBucketWebsite({ Bucket: bucket.bucketName });
      expect(web2.IndexDocument?.Suffix).toEqual("home.html");

      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
  { timeout: 120_000 },
);

// Server-access logging needs a same-stack target bucket that grants the S3
// logging service principal permission to deliver logs (the modern, ACL-free
// grant — works with the BucketOwnerEnforced default).
test.provider("server access logging set and update prefix", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const target = "alchemy-test-bucket-logging-target";
    const source = "alchemy-test-bucket-logging-src";

    const deployWith = (targetPrefix: string) =>
      stack.deploy(
        Effect.gen(function* () {
          const targetBucket = yield* Bucket("LogTargetBucket", {
            bucketName: target,
            policy: [
              {
                Sid: "S3ServerAccessLogsPolicy",
                Effect: "Allow",
                Principal: { Service: "logging.s3.amazonaws.com" },
                Action: ["s3:PutObject"],
                Resource: [`arn:aws:s3:::${target}/*`],
                Condition: {
                  ArnLike: { "aws:SourceArn": `arn:aws:s3:::${source}` },
                },
              },
            ],
            forceDestroy: true,
          });
          const sourceBucket = yield* Bucket("LogSourceBucket", {
            bucketName: source,
            logging: {
              // Output reference so the target (and its delivery policy)
              // reconciles before the source's putBucketLogging.
              targetBucket: targetBucket.bucketName,
              targetPrefix,
            },
            forceDestroy: true,
          });
          return { sourceBucket, targetBucket };
        }),
      );

    const buckets = yield* deployWith("logs/");

    const l1 = yield* S3.getBucketLogging({
      Bucket: buckets.sourceBucket.bucketName,
    });
    expect(l1.LoggingEnabled?.TargetBucket).toEqual(target);
    expect(l1.LoggingEnabled?.TargetPrefix).toEqual("logs/");

    // In-place update of the log prefix.
    yield* deployWith("access/");

    const l2 = yield* S3.getBucketLogging({
      Bucket: buckets.sourceBucket.bucketName,
    });
    expect(l2.LoggingEnabled?.TargetPrefix).toEqual("access/");

    yield* stack.destroy();
    yield* assertBucketDeleted(buckets.sourceBucket.bucketName);
    yield* assertBucketDeleted(buckets.targetBucket.bucketName);
  }),
);

test.provider("transfer acceleration and request payment", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-accel-pay";
    const bucket = yield* stack.deploy(
      Bucket("AccelPayBucket", {
        bucketName: name,
        transferAcceleration: "Enabled",
        requestPayer: "Requester",
        forceDestroy: true,
      }),
    );

    const a1 = yield* S3.getBucketAccelerateConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(a1.Status).toEqual("Enabled");

    const r1 = yield* S3.getBucketRequestPayment({ Bucket: bucket.bucketName });
    expect(r1.Payer).toEqual("Requester");

    yield* stack.deploy(
      Bucket("AccelPayBucket", {
        bucketName: name,
        transferAcceleration: "Suspended",
        requestPayer: "BucketOwner",
        forceDestroy: true,
      }),
    );

    const a2 = yield* S3.getBucketAccelerateConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(a2.Status).toEqual("Suspended");

    const r2 = yield* S3.getBucketRequestPayment({ Bucket: bucket.bucketName });
    expect(r2.Payer).toEqual("BucketOwner");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("object lock default retention", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-objlock-retention";
    const bucket = yield* stack.deploy(
      Bucket("ObjLockRetentionBucket", {
        bucketName: name,
        objectLockEnabled: true,
        objectLockConfiguration: { mode: "GOVERNANCE", days: "1 day" },
        forceDestroy: true,
      }),
    );

    const cfg = yield* S3.getObjectLockConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(cfg.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode).toEqual(
      "GOVERNANCE",
    );
    expect(cfg.ObjectLockConfiguration?.Rule?.DefaultRetention?.Days).toEqual(
      1,
    );

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("intelligent tiering add and remove id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-int-tiering";
    const bucket = yield* stack.deploy(
      Bucket("IntTieringBucket", {
        bucketName: name,
        intelligentTiering: [
          {
            Id: "archive",
            Status: "Enabled",
            Tierings: [{ Days: 90, AccessTier: "ARCHIVE_ACCESS" }],
          },
        ],
        forceDestroy: true,
      }),
    );

    const t1 = yield* S3.getBucketIntelligentTieringConfiguration({
      Bucket: bucket.bucketName,
      Id: "archive",
    });
    expect(t1.IntelligentTieringConfiguration?.Status).toEqual("Enabled");

    yield* stack.deploy(
      Bucket("IntTieringBucket", {
        bucketName: name,
        intelligentTiering: [],
        forceDestroy: true,
      }),
    );

    const removed = yield* S3.getBucketIntelligentTieringConfiguration({
      Bucket: bucket.bucketName,
      Id: "archive",
    }).pipe(
      Effect.map(() => "has-config" as const),
      Effect.catchTag("NoSuchConfiguration", () =>
        Effect.succeed("no-config" as const),
      ),
    );
    expect(removed).toEqual("no-config");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

test.provider("explicit bucket policy prop", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const name = "alchemy-test-bucket-policy-prop";
    const bucketArn = `arn:aws:s3:::${name}`;
    const bucket = yield* stack.deploy(
      Bucket("PolicyPropBucket", {
        bucketName: name,
        policy: [
          {
            Sid: "AllowCloudFront",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: ["s3:GetObject"],
            Resource: [`${bucketArn}/*`],
          },
        ],
        forceDestroy: true,
      }),
    );

    const policy = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(Effect.map((r) => JSON.parse(r.Policy!)));
    expect(policy.Statement[0].Sid).toEqual("AllowCloudFront");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucket.bucketName);
  }),
);

// Replication needs an IAM role S3 can assume + a versioned destination bucket.
// The test provisions all of it (role + dest bucket) so it is self-contained.
test.provider(
  "replication configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dest = "alchemy-test-bucket-replication-dest";
      const src = "alchemy-test-bucket-replication-src";

      const buckets = yield* stack.deploy(
        Effect.gen(function* () {
          const destBucket = yield* Bucket("ReplDestBucket", {
            bucketName: dest,
            versioning: "Enabled",
            forceDestroy: true,
          });
          const replRole = yield* Role("ReplRole", {
            roleName: "alchemy-test-s3-replication-role",
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "s3.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              Replication: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
                    Resource: [`arn:aws:s3:::${src}`],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "s3:GetObjectVersionForReplication",
                      "s3:GetObjectVersionAcl",
                      "s3:GetObjectVersionTagging",
                    ],
                    Resource: [`arn:aws:s3:::${src}/*`],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "s3:ReplicateObject",
                      "s3:ReplicateDelete",
                      "s3:ReplicateTags",
                    ],
                    Resource: [`arn:aws:s3:::${dest}/*`],
                  },
                ],
              },
            },
          });
          const srcBucket = yield* Bucket("ReplSrcBucket", {
            bucketName: src,
            versioning: "Enabled",
            replication: {
              role: replRole.roleArn,
              rules: [
                {
                  ID: "replicate-all",
                  Status: "Enabled",
                  Priority: 1,
                  Filter: {},
                  DeleteMarkerReplication: { Status: "Disabled" },
                  Destination: { Bucket: `arn:aws:s3:::${dest}` },
                },
              ],
            },
            forceDestroy: true,
          });
          return { srcBucket, destBucket, roleArn: replRole.roleArn };
        }),
      );

      const repl = yield* S3.getBucketReplication({
        Bucket: buckets.srcBucket.bucketName,
      });
      expect(repl.ReplicationConfiguration?.Role).toEqual(buckets.roleArn);
      expect(repl.ReplicationConfiguration?.Rules).toHaveLength(1);

      yield* stack.destroy();
      yield* assertBucketDeleted(buckets.srcBucket.bucketName);
      yield* assertBucketDeleted(buckets.destBucket.bucketName);
    }),
  { timeout: 180_000 },
);

// Idempotent out-of-band delete for the adoption test's deterministically
// named bucket. Tolerates the bucket never existing / already deleted
// (typed NoSuchBucket) and retries transient failures a bounded number of
// times. The bucket is always empty in that test, so deleteBucket suffices.
const deleteBucketIfExists = Effect.fn(function* (bucketName: string) {
  yield* S3.deleteBucket({ Bucket: bucketName }).pipe(
    Effect.catchTag("NoSuchBucket", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(5)]),
    }),
  );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
