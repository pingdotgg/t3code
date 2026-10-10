import * as AWS from "@/AWS";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy";
import * as Output from "@/Output";
import { isResourceState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });
const waitPolicy = {
  until: (gone: boolean) => gone,
  schedule: Schedule.spaced("2 seconds"),
  times: 9,
};

const filter = (
  prefix: string,
  suffix = ".json",
  reversed = false,
): S3.NotificationConfigurationFilter => {
  const rules: S3.FilterRule[] = [
    { Name: "prefix", Value: prefix },
    { Name: "suffix", Value: suffix },
  ];
  return { Key: { FilterRules: reversed ? rules.reverse() : rules } };
};

const canonicalTargets = <
  T extends {
    Id?: string;
    Events: S3.Event[];
    Filter?: S3.NotificationConfigurationFilter;
  },
>(
  targets: T[] = [],
) =>
  targets
    .map((target) => ({
      ...target,
      Events: [...target.Events].sort(),
      Filter: target.Filter
        ? {
            Key: {
              FilterRules: (target.Filter.Key?.FilterRules ?? [])
                .map((rule) => ({ ...rule, Name: rule.Name?.toLowerCase() }))
                .sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? "")),
            },
          }
        : undefined,
    }))
    .sort((a, b) => (a.Id ?? "").localeCompare(b.Id ?? ""));

const canonical = (configuration: S3.NotificationConfiguration) => ({
  QueueConfigurations: canonicalTargets(configuration.QueueConfigurations),
  TopicConfigurations: canonicalTargets(configuration.TopicConfigurations),
  LambdaFunctionConfigurations: canonicalTargets(
    configuration.LambdaFunctionConfigurations,
  ),
  EventBridgeConfiguration: configuration.EventBridgeConfiguration,
});

const readNotifications = (bucketName: string) =>
  S3.getBucketNotificationConfiguration({ Bucket: bucketName });

const readEventBridgeOwner = (bucketName: string) =>
  S3.getBucketTagging({ Bucket: bucketName }).pipe(
    Effect.map(
      (response) =>
        response.TagSet.find(
          (tag) => tag.Key === "alchemy:notifications:eventbridge",
        )?.Value,
    ),
    Effect.catchTag("NoSuchTagSet", () => Effect.succeed(undefined)),
  );

const notificationQueue = Effect.fn(function* (
  id: string,
  bucket: AWS.S3.Bucket,
) {
  const queue = yield* AWS.SQS.Queue(id);
  // Keep both the self-reference and bucket dependency in the binding graph.
  yield* queue.bind("AllowBucketNotifications", {
    policyStatements: [
      {
        Sid: "AllowBucketNotifications",
        Effect: "Allow",
        Principal: { Service: "s3.amazonaws.com" },
        Action: ["sqs:SendMessage"],
        Resource: [queue.queueArn],
        Condition: { ArnEquals: { "aws:SourceArn": bucket.bucketArn } },
      },
    ],
  });
  return queue;
});

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  const gone = yield* readNotifications(bucketName).pipe(
    Effect.as(false),
    Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
    Effect.repeat(waitPolicy),
  );
  expect(gone).toBe(true);
});

const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  const gone = yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["QueueArn"],
  }).pipe(
    Effect.as(false),
    Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
    Effect.repeat(waitPolicy),
  );
  expect(gone).toBe(true);
});

test.provider(
  "queue-only notification bindings create, update filters and events, switch destinations, and remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (
        updated = false,
        destination: "first" | "second" = "first",
        enabled = true,
      ) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", {});
          const first = yield* notificationQueue("FirstQueue", bucket);
          const second = yield* notificationQueue("SecondQueue", bucket);
          if (enabled) {
            yield* bucket.bind("QueueNotifications", {
              notificationConfiguration: {
                QueueConfigurations: [
                  {
                    QueueArn:
                      destination === "first"
                        ? first.queueArn
                        : second.queueArn,
                    Events: [
                      updated
                        ? "s3:ObjectRemoved:Delete"
                        : "s3:ObjectCreated:Put",
                    ],
                    Filter: updated
                      ? filter("updated/")
                      : filter("initial/", ".txt"),
                  },
                ],
              },
            });
          }
          return { bucket, first, second };
        });
      const { bucket, first, second } = yield* stack.deploy(definition());
      const initial = yield* readNotifications(bucket.bucketName);
      expect(canonical(initial)).toEqual(
        canonical({
          QueueConfigurations: [
            {
              Id: expect.any(String),
              QueueArn: first.queueArn,
              Events: ["s3:ObjectCreated:Put"],
              Filter: filter("initial/", ".txt"),
            },
          ],
        }),
      );
      const expectedPolicy = normalizePolicyDocument({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowBucketNotifications",
            Effect: "Allow",
            Principal: { Service: "s3.amazonaws.com" },
            Action: ["sqs:SendMessage"],
            Resource: [first.queueArn],
            Condition: { ArnEquals: { "aws:SourceArn": bucket.bucketArn } },
          },
        ],
      });
      const observedPolicy = yield* SQS.getQueueAttributes({
        QueueUrl: first.queueUrl,
        AttributeNames: ["Policy"],
      }).pipe(
        Effect.map((response) =>
          normalizePolicyDocument(response.Attributes?.Policy ?? ""),
        ),
        Effect.repeat({
          until: (policy) => policy === expectedPolicy,
          schedule: Schedule.spaced("2 seconds"),
          times: 9,
        }),
      );
      expect(observedPolicy).toEqual(expectedPolicy);

      yield* stack.deploy(definition(true));
      const updated = yield* readNotifications(bucket.bucketName);
      expect(canonical(updated)).toEqual(
        canonical({
          QueueConfigurations: [
            {
              Id: expect.any(String),
              QueueArn: first.queueArn,
              Events: ["s3:ObjectRemoved:Delete"],
              Filter: filter("updated/"),
            },
          ],
        }),
      );

      // Retain both destinations while switching the notification reference.
      yield* stack.deploy(definition(true, "second"));
      const switched = yield* readNotifications(bucket.bucketName);
      expect(canonical(switched)).toEqual(
        canonical({
          QueueConfigurations: [
            {
              Id: expect.any(String),
              QueueArn: second.queueArn,
              Events: ["s3:ObjectRemoved:Delete"],
              Filter: filter("updated/"),
            },
          ],
        }),
      );
      yield* S3.putBucketNotificationConfiguration({
        Bucket: bucket.bucketName,
        NotificationConfiguration: {},
      });
      yield* stack.deploy(definition(true, "second"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(switched),
      );
      yield* stack.deploy(definition(true, "second"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(switched),
      );
      yield* stack.deploy(definition(true, "second", false));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );

      yield* stack.destroy();
      yield* Effect.all(
        [
          assertBucketDeleted(bucket.bucketName),
          assertQueueDeleted(first.queueUrl),
          assertQueueDeleted(second.queueUrl),
        ],
        { concurrency: 3 },
      );
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:s3",
      "provider:aws:sqs",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "mixed notification bindings keep stable IDs across reordering and preserve foreign configurations on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (
        mode: "all" | "without-queue" | "none" = "all",
        reversed = false,
        revision = "initial",
      ) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", { tags: { revision } });
          const queue = yield* notificationQueue("Queue", bucket);
          const topic = yield* AWS.SNS.Topic("Topic", {
            attributes: {
              Policy: bucket.bucketArn.pipe(
                Output.mapEffect((bucketArn) =>
                  Effect.sync(() =>
                    JSON.stringify({
                      Version: "2012-10-17",
                      Statement: [
                        {
                          Effect: "Allow",
                          Principal: { Service: "s3.amazonaws.com" },
                          Action: "sns:Publish",
                          Resource: "*",
                          Condition: {
                            ArnEquals: { "aws:SourceArn": bucketArn },
                          },
                        },
                      ],
                    }),
                  ),
                ),
              ),
            },
          });
          const fn = yield* AWS.Lambda.Function("Target", {
            main: new URL("./fixtures/notification-target.ts", import.meta.url)
              .pathname,
            isExternal: true,
            handler: "handler",
            functionUrl: false,
          });
          yield* AWS.Lambda.Permission("AllowBucket", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "s3.amazonaws.com",
            sourceArn: bucket.bucketArn,
          });
          const events: S3.Event[] = [
            "s3:ObjectCreated:Put",
            "s3:ObjectCreated:Post",
          ];
          if (reversed) events.reverse();
          const bindings = [
            ...(mode === "all"
              ? [
                  bucket.bind("QueueNotifications", {
                    notificationConfiguration: {
                      QueueConfigurations: (reversed
                        ? ["b", "a"]
                        : ["a", "b"]
                      ).map((key) => ({
                        QueueArn: queue.queueArn,
                        Events: events,
                        Filter: filter(
                          `owned/queue-${key}/`,
                          ".json",
                          reversed,
                        ),
                      })),
                    },
                  }),
                ]
              : []),
            ...(mode !== "none"
              ? [
                  bucket.bind("TopicNotifications", {
                    notificationConfiguration: {
                      TopicConfigurations: [
                        {
                          TopicArn: topic.topicArn,
                          Events: events,
                          Filter: filter("owned/topic/", ".json", reversed),
                        },
                      ],
                    },
                  }),
                  bucket.bind("LambdaNotifications", {
                    notificationConfiguration: {
                      LambdaFunctionConfigurations: [
                        {
                          LambdaFunctionArn: fn.functionArn,
                          Events: events,
                          Filter: filter("owned/lambda/", ".json", reversed),
                        },
                      ],
                    },
                  }),
                ]
              : []),
          ];
          yield* Effect.all(reversed ? bindings.reverse() : bindings);
          return { bucket, queue, topic, fn };
        });
      const { bucket, queue, topic, fn } = yield* stack.deploy(definition());
      const owned = yield* readNotifications(bucket.bucketName);
      expect(owned.QueueConfigurations).toHaveLength(2);
      expect(owned.TopicConfigurations).toHaveLength(1);
      expect(owned.LambdaFunctionConfigurations).toHaveLength(1);
      const ids = [
        ...owned.QueueConfigurations!,
        ...owned.TopicConfigurations!,
        ...owned.LambdaFunctionConfigurations!,
      ].map((target) => target.Id);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
        true,
      );
      expect(new Set(ids).size).toBe(4);
      const actual = canonical(owned);
      const events = ["s3:ObjectCreated:Post", "s3:ObjectCreated:Put"];
      expect(actual.QueueConfigurations).toEqual(
        expect.arrayContaining(
          ["a", "b"].map((key) => ({
            Id: expect.any(String),
            QueueArn: queue.queueArn,
            Events: events,
            Filter: filter(`owned/queue-${key}/`),
          })),
        ),
      );
      expect(actual.TopicConfigurations).toEqual([
        {
          Id: expect.any(String),
          TopicArn: topic.topicArn,
          Events: events,
          Filter: filter("owned/topic/"),
        },
      ]);
      expect(actual.LambdaFunctionConfigurations).toEqual([
        {
          Id: expect.any(String),
          LambdaFunctionArn: fn.functionArn,
          Events: events,
          Filter: filter("owned/lambda/"),
        },
      ]);
      expect(actual.EventBridgeConfiguration).toBeUndefined();
      const foreign: S3.NotificationConfiguration = {
        QueueConfigurations: [
          {
            Id: "external-queue",
            QueueArn: queue.queueArn,
            Events: ["s3:ObjectCreated:Put"],
            Filter: filter("external/queue/"),
          },
        ],
        TopicConfigurations: [
          {
            Id: "external-topic",
            TopicArn: topic.topicArn,
            Events: ["s3:ObjectCreated:Put"],
            Filter: filter("external/topic/"),
          },
        ],
        LambdaFunctionConfigurations: [
          {
            Id: "external-lambda",
            LambdaFunctionArn: fn.functionArn,
            Events: ["s3:ObjectCreated:Put"],
            Filter: filter("external/lambda/"),
          },
        ],
        EventBridgeConfiguration: {},
      };
      const combined: S3.NotificationConfiguration = {
        QueueConfigurations: [
          ...owned.QueueConfigurations!,
          ...foreign.QueueConfigurations!,
        ],
        TopicConfigurations: [
          ...owned.TopicConfigurations!,
          ...foreign.TopicConfigurations!,
        ],
        LambdaFunctionConfigurations: [
          ...owned.LambdaFunctionConfigurations!,
          ...foreign.LambdaFunctionConfigurations!,
        ],
        EventBridgeConfiguration: {},
      };
      // Add foreign entries only after deploy; AWS validates all real destinations.
      yield* S3.putBucketNotificationConfiguration({
        Bucket: bucket.bucketName,
        NotificationConfiguration: combined,
      });
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(combined),
      );

      yield* stack.deploy(definition("all", true));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(combined),
      );
      // Exercise the provider's no-change notification sync, not only an engine noop.
      yield* stack.deploy(definition("all", true, "noop"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(combined),
      );
      yield* stack.deploy(definition("without-queue", true, "noop"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({
          ...combined,
          QueueConfigurations: foreign.QueueConfigurations,
        }),
      );
      yield* stack.deploy(definition("none", true, "noop"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(foreign),
      );

      yield* stack.destroy();
      yield* Effect.all(
        [
          assertBucketDeleted(bucket.bucketName),
          assertQueueDeleted(queue.queueUrl),
          SNS.getTopicAttributes({ TopicArn: topic.topicArn }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
            Effect.repeat(waitPolicy),
            Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
          ),
          Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
            Effect.as(false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
            Effect.repeat(waitPolicy),
            Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
          ),
        ],
        { concurrency: 4 },
      );
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:aws:s3",
      "provider:aws:sns",
      "provider:aws:sqs",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "managed EventBridge remains until its final binding is removed after a no-change reconcile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (bindings: string[], revision = "initial") =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", { tags: { revision } });
          for (const id of bindings) {
            yield* bucket.bind(id, {
              notificationConfiguration: { EventBridgeConfiguration: {} },
            });
          }
          return bucket;
        });
      const bucket = yield* stack.deploy(definition(["First", "Second"]));
      const enabled = canonical({ EventBridgeConfiguration: {} });
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        enabled,
      );
      const owner = yield* readEventBridgeOwner(bucket.bucketName);
      expect(owner).toBeTruthy();
      yield* stack.deploy(definition(["Second"]));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        enabled,
      );
      // Force tag sync while keeping the remaining notification binding unchanged.
      yield* stack.deploy(definition(["Second"], "tag-sync"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        enabled,
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBe(owner);
      yield* stack.deploy(definition([], "tag-sync"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
  { tags: ["provider:aws", "provider:aws:s3", "live"], timeout: 120_000 },
);

test.provider(
  "adding and removing identical bindings does not claim a foreign queue target or EventBridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (enabled: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", {});
          const queue = yield* notificationQueue("Queue", bucket);
          if (enabled) {
            yield* bucket.bind("MatchingNotifications", {
              notificationConfiguration: {
                QueueConfigurations: [
                  {
                    QueueArn: queue.queueArn,
                    Events: ["s3:ObjectCreated:Put"],
                    Filter: filter("shared/"),
                  },
                ],
                EventBridgeConfiguration: {},
              },
            });
          }
          return { bucket, queue };
        });
      const { bucket, queue } = yield* stack.deploy(definition(false));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );
      const foreign: S3.NotificationConfiguration = {
        QueueConfigurations: [
          {
            Id: "external-identical-target",
            QueueArn: queue.queueArn,
            Events: ["s3:ObjectCreated:Put"],
            Filter: filter("shared/"),
          },
        ],
        EventBridgeConfiguration: {},
      };
      yield* S3.putBucketNotificationConfiguration({
        Bucket: bucket.bucketName,
        NotificationConfiguration: foreign,
      });
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(foreign),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      yield* stack.deploy(definition(true));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(foreign),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      yield* stack.deploy(definition(false));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(foreign),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      yield* stack.destroy();
      yield* Effect.all(
        [
          assertBucketDeleted(bucket.bucketName),
          assertQueueDeleted(queue.queueUrl),
        ],
        { concurrency: 2 },
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "provider:aws:sqs", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "legacy Lambda notifications migrate from persisted bindings without claiming new identical external bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (mode: "legacy" | "updated" | "none") =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", {});
          const fn = yield* AWS.Lambda.Function("Target", {
            main: new URL("./fixtures/notification-target.ts", import.meta.url)
              .pathname,
            isExternal: true,
            handler: "handler",
            functionUrl: false,
          });
          yield* AWS.Lambda.Permission("AllowBucket", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "s3.amazonaws.com",
            sourceArn: bucket.bucketArn,
          });
          if (mode !== "none") {
            yield* bucket.bind("ChangingNotifications", {
              notificationConfiguration: {
                LambdaFunctionConfigurations: [
                  {
                    LambdaFunctionArn: fn.functionArn,
                    Events: ["s3:ObjectCreated:Put"],
                    Filter: filter(
                      mode === "legacy" ? "owned/original/" : "owned/updated/",
                    ),
                  },
                ],
              },
            });
            yield* bucket.bind(
              mode === "legacy"
                ? "RemovedNotifications"
                : "ExternalNotifications",
              {
                notificationConfiguration: {
                  LambdaFunctionConfigurations: [
                    {
                      LambdaFunctionArn: fn.functionArn,
                      Events: ["s3:ObjectCreated:Put"],
                      Filter: filter(
                        mode === "legacy" ? "owned/removed/" : "external/",
                      ),
                    },
                  ],
                },
              },
            );
          }
          return { bucket, fn };
        });
      const { bucket, fn } = yield* stack.deploy(definition("legacy"));
      const legacyTargets: S3.LambdaFunctionConfiguration[] = [
        "owned/original/",
        "owned/removed/",
      ].map((prefix) => ({
        LambdaFunctionArn: fn.functionArn,
        Events: ["s3:ObjectCreated:Put"],
        Filter: filter(prefix),
      }));
      const foreign: S3.LambdaFunctionConfiguration = {
        Id: "external-lambda",
        LambdaFunctionArn: fn.functionArn,
        Events: ["s3:ObjectCreated:Put"],
        Filter: filter("external/"),
      };
      // The legacy provider omitted IDs; S3 assigned them outside Alchemy's namespace.
      yield* S3.putBucketNotificationConfiguration({
        Bucket: bucket.bucketName,
        NotificationConfiguration: {
          LambdaFunctionConfigurations: [...legacyTargets, foreign],
        },
      });
      const legacy = yield* readNotifications(bucket.bucketName);
      expect(legacy.LambdaFunctionConfigurations).toHaveLength(3);
      const legacyIds = legacy
        .LambdaFunctionConfigurations!.filter(
          (target) => target.Id !== foreign.Id,
        )
        .map((target) => target.Id!);
      expect(legacyIds).toHaveLength(2);
      for (const id of legacyIds) {
        expect(id).toBeTruthy();
        expect(id.startsWith("alchemy-notification-")).toBe(false);
      }
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "Bucket" };
        const row = yield* state.get(key);
        if (!row || !isResourceState(row) || !row.attr) {
          return yield* Effect.fail(
            new Error("Expected persisted bucket attributes"),
          );
        }
        const bindings = row.bindings.map((binding) => ({
          ...binding,
          data: {
            notificationConfiguration: {
              LambdaFunctionConfigurations:
                binding.sid === "ChangingNotifications"
                  ? [legacyTargets[0]!]
                  : [legacyTargets[1]!],
            },
          },
        }));
        expect(bindings).toHaveLength(2);
        expect(bindings.map((binding) => binding.sid).sort()).toEqual([
          "ChangingNotifications",
          "RemovedNotifications",
        ]);
        const attr = { ...row.attr };
        delete attr.managedNotificationConfiguration;
        const persisted = yield* state.set({
          ...key,
          value: { ...row, attr, bindings },
        });
        expect(persisted.attr.managedNotificationConfiguration).toBeUndefined();
      }).pipe(Effect.provide(stack.state));

      yield* stack.deploy(definition("updated"));
      const updated = yield* readNotifications(bucket.bucketName);
      const managedId = updated.LambdaFunctionConfigurations?.find(
        (target) => target.Id !== foreign.Id,
      )?.Id;
      expect(managedId).toMatch(/^alchemy-notification-/);
      expect(canonical(updated)).toEqual(
        canonical({
          LambdaFunctionConfigurations: [
            {
              Id: managedId,
              LambdaFunctionArn: fn.functionArn,
              Events: ["s3:ObjectCreated:Put"],
              Filter: filter("owned/updated/"),
            },
            foreign,
          ],
        }),
      );
      for (const target of updated.LambdaFunctionConfigurations!) {
        expect(legacyIds).not.toContain(target.Id);
      }
      yield* stack.deploy(definition("updated"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical(updated),
      );
      yield* stack.deploy(definition("none"));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({ LambdaFunctionConfigurations: [foreign] }),
      );
      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
      const gone = yield* Lambda.getFunction({
        FunctionName: fn.functionName,
      }).pipe(
        Effect.as(false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
        Effect.repeat(waitPolicy),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "clears a stale EventBridge ownership marker when notifications and withdrawn bindings already match",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (enabled: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", {
            tags: { purpose: "eventbridge-marker-recovery" },
          });
          if (enabled) {
            yield* bucket.bind("EventBridge", {
              notificationConfiguration: { EventBridgeConfiguration: {} },
            });
          }
          return bucket;
        });
      const bucket = yield* stack.deploy(definition(true));
      const owner = yield* readEventBridgeOwner(bucket.bucketName);
      expect(owner).toBeTruthy();
      yield* S3.putBucketNotificationConfiguration({
        Bucket: bucket.bucketName,
        NotificationConfiguration: {},
      });
      // Model withdrawn bindings with a lost snapshot and an uncleared cloud marker.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "Bucket" };
        const row = yield* state.get(key);
        if (!row || !isResourceState(row) || !row.attr) {
          return yield* Effect.fail(
            new Error("Expected persisted bucket attributes"),
          );
        }
        const attr = { ...row.attr };
        delete attr.managedNotificationConfiguration;
        yield* state.set({ ...key, value: { ...row, attr, bindings: [] } });
      }).pipe(Effect.provide(stack.state));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBe(owner);
      const retained = yield* stack.deploy(definition(false));
      expect(retained.bucketName).toBe(bucket.bucketName);
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      expect(
        (yield* S3.getBucketTagging({ Bucket: bucket.bucketName })).TagSet,
      ).toContainEqual({
        Key: "purpose",
        Value: "eventbridge-marker-recovery",
      });
      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
  { tags: ["provider:aws", "provider:aws:s3", "live"], timeout: 120_000 },
);

test.provider(
  "EventBridge binding removal recovers ownership after losing the committed notification snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const definition = (enabled: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Bucket", {
            tags: { purpose: "notifications-crash-recovery" },
          });
          if (enabled) {
            yield* bucket.bind("EventBridge", {
              notificationConfiguration: { EventBridgeConfiguration: {} },
            });
          }
          return bucket;
        });
      const bucket = yield* stack.deploy(definition(true));
      const enabled = canonical({ EventBridgeConfiguration: {} });
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        enabled,
      );
      const owner = yield* readEventBridgeOwner(bucket.bucketName);
      expect(owner).toBeTruthy();

      // Model a lost attributes commit without deleting the live bucket or its state row.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "Bucket" };
        const row = yield* state.get(key);
        if (!row || !isResourceState(row) || !row.attr) {
          return yield* Effect.fail(
            new Error("Expected persisted bucket attributes"),
          );
        }
        expect(
          row.attr.managedNotificationConfiguration?.EventBridgeConfiguration,
        ).toEqual({});
        const attr = { ...row.attr };
        delete attr.managedNotificationConfiguration;
        const persisted = yield* state.set({ ...key, value: { ...row, attr } });
        expect(persisted.attr.managedNotificationConfiguration).toBeUndefined();
        expect(persisted.attr.bucketName).toBe(bucket.bucketName);
      }).pipe(Effect.provide(stack.state));
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        enabled,
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBe(owner);

      const retained = yield* stack.deploy(definition(false));
      expect(retained.bucketName).toBe(bucket.bucketName);
      expect(canonical(yield* readNotifications(bucket.bucketName))).toEqual(
        canonical({}),
      );
      expect(yield* readEventBridgeOwner(bucket.bucketName)).toBeUndefined();
      expect(
        (yield* S3.getBucketTagging({ Bucket: bucket.bucketName })).TagSet,
      ).toContainEqual({
        Key: "purpose",
        Value: "notifications-crash-recovery",
      });
      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.bucketName);
    }),
  { tags: ["provider:aws", "provider:aws:s3", "live"], timeout: 120_000 },
);
