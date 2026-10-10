import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import type { SubscriptionResourceSource } from "@/Cloudflare/Queues/Subscription";
import * as TestCore from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as ai from "@distilled.cloud/cloudflare/ai";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as images from "@distilled.cloud/cloudflare/images";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect, test as unitTest } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  hasReadySubscriptionEvent,
  makeSubscriptionCleanup,
  matchesSubscriptionEvent,
  SubscriptionEvent,
  type SubscriptionProbe,
} from "./SubscriptionSources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

type Assert<T extends true> = T;
type Accepts<T> = T extends SubscriptionResourceSource ? true : false;
type _Variant = Assert<Accepts<Cloudflare.Images.Variant>>;
type _Namespace = Assert<Accepts<Cloudflare.KV.Namespace>>;
type _Bucket = Assert<Accepts<Cloudflare.R2.Bucket>>;
type _Job = Assert<Accepts<Cloudflare.R2.SuperSlurperJob>>;
type _Index = Assert<Accepts<Cloudflare.Vectorize.Index>>;
type _Model = Assert<Accepts<Cloudflare.AI.Model>>;
type _SearchModel = Assert<
  Cloudflare.AI.SearchModel extends string ? true : false
>;
type _SearchModelIsNotResource = Assert<
  Accepts<Cloudflare.AI.SearchModel> extends false ? true : false
>;
type _Worker = Assert<Accepts<Cloudflare.Worker>>;

const references = Effect.gen(function* () {
  const queue = yield* Cloudflare.Queues.Queue("EventsQueue");
  const sources = [
    yield* Cloudflare.Images.Variant.ref("Image"),
    yield* Cloudflare.KV.Namespace.ref("Cache"),
    yield* Cloudflare.R2.Bucket.ref("Uploads"),
    yield* Cloudflare.R2.SuperSlurperJob.ref("Migration"),
    yield* Cloudflare.Vectorize.Index.ref("Search"),
    yield* Cloudflare.AI.Model.ref("Embeddings"),
    yield* Cloudflare.Worker.ref("Website"),
  ];
  const Subscription = yield* Cloudflare.Queues.Subscription;
  for (const [index, source] of sources.entries()) {
    yield* Subscription(
      `Events${index}`,
      Effect.succeed({
        source,
        events: ["product.event"],
        queueId: queue.queueId,
      }),
    );
  }
  yield* Subscription("Invalid", {
    // @ts-expect-error arbitrary account-bearing objects are not resource sources
    source: { accountId: "account", modelName: "model" },
    events: ["batch.queued"],
    queueId: queue.queueId,
  });
});
void references;

type Kind = "images" | "kv" | "r2" | "vectorize" | "model" | "worker";
const createSource = (kind: Kind, id = "Source") =>
  Effect.gen(function* () {
    switch (kind) {
      case "images":
        return yield* Cloudflare.Images.Variant(id, {
          name: `alchemySubscription${id}`,
          fit: "contain",
          width: 100,
          height: 100,
        });
      case "kv":
        return yield* Cloudflare.KV.Namespace(id);
      case "r2":
        return yield* Cloudflare.R2.Bucket(id, { forceDestroy: true });
      case "vectorize":
        return yield* Cloudflare.Vectorize.Index(id, {
          dimensions: 32,
          metric: "cosine",
        });
      case "model":
        return yield* Cloudflare.AI.Model(id, {
          modelName: "@cf/baai/bge-m3",
        });
      case "worker":
        return yield* Cloudflare.Worker(id, {
          main: `${import.meta.dirname}/fixtures/subscription-source-worker.ts`,
        });
    }
  });
const refSource = (kind: Kind, options?: { stack: string; stage: string }) =>
  Effect.gen(function* () {
    switch (kind) {
      case "images":
        return yield* Cloudflare.Images.Variant.ref("Source", options);
      case "kv":
        return yield* Cloudflare.KV.Namespace.ref("Source", options);
      case "r2":
        return yield* Cloudflare.R2.Bucket.ref("Source", options);
      case "vectorize":
        return yield* Cloudflare.Vectorize.Index.ref("Source", options);
      case "model":
        return yield* Cloudflare.AI.Model.ref("Source", options);
      case "worker":
        return yield* Cloudflare.Worker.ref("Source", options);
    }
  });
const eventType = (kind: Kind) =>
  ({
    images: process.env.CLOUDFLARE_TEST_IMAGES_EVENT ?? "image.uploaded",
    kv: "namespace.created",
    r2: "bucket.created",
    vectorize: "index.created",
    model: "batch.queued",
    worker: "build.started",
  })[kind];

const verifySource = (source: {
  accountId: string;
  variantName?: string;
  namespaceId?: string;
  bucketName?: string;
  indexName?: string;
  modelName?: string;
  workerName?: string;
}) =>
  Effect.gen(function* () {
    const { accountId } = source;
    if (source.variantName)
      yield* images.getV1Variant({ accountId, variantId: source.variantName });
    else if (source.namespaceId)
      yield* kv.getNamespace({ accountId, namespaceId: source.namespaceId });
    else if (source.bucketName)
      yield* r2.getBucket({ accountId, bucketName: source.bucketName });
    else if (source.indexName)
      yield* vectorize.getIndex({ accountId, indexName: source.indexName });
    else if (source.modelName)
      yield* ai.getModelSchema({ accountId, model: source.modelName });
    else if (source.workerName)
      yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: source.workerName,
      });
    else throw new Error("Unknown source identity");
  });

const gone = (accountId: string, subscriptionId: string) =>
  queues.getSubscription({ accountId, subscriptionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("Subscription still exists"))),
    Effect.catchTag("SubscriptionNotFound", () => Effect.void),
  );

const triggerEvent = (kind: Kind, accountId: string, name: string) =>
  Effect.gen(function* () {
    const eventName = `${name.slice(0, 48)}-event`;
    if (kind === "kv") {
      const namespace = yield* Effect.acquireRelease(
        kv.createNamespace({ accountId, title: eventName }),
        (namespace) =>
          kv
            .deleteNamespace({ accountId, namespaceId: namespace.id })
            .pipe(Effect.orDie),
      );
      return namespace.id;
    }
    if (kind === "r2") {
      const bucket = yield* Effect.acquireRelease(
        r2.createBucket({ accountId, name: eventName }),
        () =>
          r2
            .deleteBucket({ accountId, bucketName: eventName })
            .pipe(Effect.orDie),
      );
      return bucket.name!;
    }
    if (kind === "vectorize") {
      const index = yield* Effect.acquireRelease(
        vectorize.createIndex({
          accountId,
          name: eventName,
          config: { dimensions: 32, metric: "cosine" },
        }),
        () =>
          vectorize
            .deleteIndex({ accountId, indexName: eventName })
            .pipe(Effect.orDie),
      );
      yield* Effect.logInfo("Vectorize index created", {
        name: index.name,
        createdOn: index.createdOn,
      });
      return index.name!;
    }
    return yield* Effect.fail(new Error(`No lifecycle trigger for ${kind}`));
  });

const pullEvents = (
  accountId: string,
  queueId: string,
  received: SubscriptionEvent[] = [],
) =>
  Effect.gen(function* () {
    const batch = yield* queues
      .pullMessage({
        accountId,
        queueId,
        batchSize: 100,
        visibilityTimeoutMs: 30_000,
      })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "QueueHttpPullNotEnabled",
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
      );
    const events = yield* Effect.forEach(
      (batch.messages ?? []).flatMap(({ body }) => (body ? [body] : [])),
      (body) => Schema.decodeUnknownEffect(SubscriptionEvent)(body),
    );
    received.push(...events);
    if (events.length) {
      yield* Effect.logInfo("Subscription events received", events);
    }
    const acks = (batch.messages ?? []).flatMap(({ leaseId }) =>
      leaseId ? [{ leaseId }] : [],
    );
    if (acks.length) {
      const result = yield* queues.ackMessage({ accountId, queueId, acks });
      expect(result.ackCount).toBe(acks.length);
      expect(Object.keys(result.warnings ?? {})).toHaveLength(0);
    }
    return events;
  });

const waitForDelivery = (
  kind: "kv" | "r2" | "vectorize",
  accountId: string,
  queueId: string,
  subscriptionId: string,
  readyAfter: number,
) =>
  Effect.gen(function* () {
    const probes: SubscriptionProbe[] = [];
    let ready = false;
    const createProbe = Effect.gen(function* () {
      const createdAt = yield* Clock.currentTimeMillis;
      probes.push({
        createdAt,
        identity: yield* triggerEvent(
          kind,
          accountId,
          `${kind}-${subscriptionId}-${probes.length}`,
        ),
      });
    });
    const observe = Effect.gen(function* () {
      const events = yield* pullEvents(accountId, queueId);
      ready = hasReadySubscriptionEvent(events, probes, {
        source: kind,
        type: eventType(kind),
        accountId,
        subscriptionId,
        readyAfter,
      });
    });
    if (kind === "vectorize") {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, readyAfter - now));
      yield* createProbe;
      yield* observe.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
          until: () => ready,
        }),
      );
    } else {
      yield* createProbe.pipe(
        Effect.andThen(observe),
        Effect.repeat({
          schedule: Schedule.spaced("7 seconds"),
          times: 8,
          until: () => ready,
        }),
      );
    }
    expect(ready).toBe(true);
  }).pipe(Effect.timeout("80 seconds"));

// Account-wide subscriptions are unique per product, regardless of the selected resource.
describe.sequential(
  "resource subscription sources",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "live",
    ],
  },
  () => {
    for (const kind of [
      "images",
      "kv",
      "r2",
      "vectorize",
      "model",
      "worker",
    ] as const) {
      test.provider(
        `${kind} direct source and persisted ref retain identity and ownership`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const { accountId } = yield* yield* CloudflareEnvironment;
            const program = (reference: boolean) =>
              Effect.gen(function* () {
                const resource = yield* createSource(kind);
                const queue = yield* Cloudflare.Queues.Queue("EventsQueue");
                const subscription = yield* Cloudflare.Queues.Subscription(
                  "Events",
                  Effect.gen(function* () {
                    return {
                      source: reference ? yield* refSource(kind) : resource,
                      events: [eventType(kind)],
                      queueId: queue.queueId,
                    };
                  }),
                );
                return { resource, queue, subscription };
              });
            const initial = yield* stack.deploy(program(false));
            const configuredAt = yield* Clock.currentTimeMillis;
            expect(initial.subscription.accountId).toBe(accountId);
            const expected =
              kind === "model"
                ? { type: "workersAi.model", modelName: "@cf/baai/bge-m3" }
                : kind === "worker" && "workerName" in initial.resource
                  ? {
                      type: "workersBuilds.worker",
                      workerName: initial.resource.workerName,
                    }
                  : { type: kind };
            expect(initial.subscription.source).toEqual(expected);
            const plan = yield* stack.plan(program(false));
            expect(plan.resources.Source.downstream).toContain("Events");
            expect(plan.resources.Events.state).toHaveProperty(
              "props.sourceAccountId",
              accountId,
            );
            expect(plan.resources.Events.state).toHaveProperty(
              "props.source",
              expected,
            );
            const observed = yield* queues.getSubscription({
              accountId,
              subscriptionId: initial.subscription.subscriptionId,
            });
            expect(observed.source).toEqual(expect.objectContaining(expected));
            const receivesLifecycle =
              kind === "kv" || kind === "r2" || kind === "vectorize";
            if (receivesLifecycle) {
              yield* queues.createConsumer({
                accountId,
                queueId: initial.queue.queueId,
                type: "http_pull",
              });
              yield* pullEvents(accountId, initial.queue.queueId);
            }
            const referenced = yield* stack.deploy(program(true));
            expect(referenced.subscription.subscriptionId).toBe(
              initial.subscription.subscriptionId,
            );
            if (receivesLifecycle) {
              yield* Effect.gen(function* () {
                yield* waitForDelivery(
                  kind,
                  accountId,
                  referenced.queue.queueId,
                  referenced.subscription.subscriptionId,
                  // Allow the observed Vectorize propagation interval before probing.
                  kind === "vectorize" ? configuredAt + 60_000 : 0,
                );
                const identities = [
                  yield* triggerEvent(
                    kind,
                    accountId,
                    referenced.queue.queueName,
                  ),
                ];
                if (kind === "vectorize") {
                  for (const suffix of ["second", "third"]) {
                    identities.push(
                      yield* triggerEvent(
                        kind,
                        accountId,
                        `vec-${referenced.subscription.subscriptionId}-${suffix}`,
                      ),
                    );
                  }
                }
                const events: SubscriptionEvent[] = [];
                const missing = () =>
                  identities.filter(
                    (identity) =>
                      !events.some((event) =>
                        matchesSubscriptionEvent(event, {
                          source: kind,
                          type: eventType(kind),
                          accountId,
                          subscriptionId:
                            referenced.subscription.subscriptionId,
                          identity,
                        }),
                      ),
                  );
                yield* pullEvents(
                  accountId,
                  referenced.queue.queueId,
                  events,
                ).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("5 seconds"),
                    times: 10,
                    until: () => missing().length === 0,
                  }),
                  Effect.timeout("60 seconds"),
                  Effect.onExit(() =>
                    Effect.gen(function* () {
                      if (missing().length === 0) return;
                      yield* Effect.logInfo("Missing subscription delivery", {
                        expected: identities,
                        missing: missing(),
                        received: events,
                      });
                      yield* Effect.all({
                        subscription: queues.getSubscription({
                          accountId,
                          subscriptionId:
                            referenced.subscription.subscriptionId,
                        }),
                        queue: queues.getQueue({
                          accountId,
                          queueId: referenced.queue.queueId,
                        }),
                        metrics: queues.getMetricsQueue({
                          accountId,
                          queueId: referenced.queue.queueId,
                        }),
                      }).pipe(
                        Effect.tap((state) =>
                          Effect.logInfo("Subscription delivery state", state),
                        ),
                        Effect.timeout("5 seconds"),
                        Effect.catch((error) =>
                          Effect.logWarning(
                            "Subscription delivery state unavailable",
                            { error: error._tag },
                          ),
                        ),
                      );
                    }),
                  ),
                );
                expect(missing()).toEqual([]);
              }).pipe(Effect.timeout("90 seconds"));
            }
            yield* stack.deploy(createSource(kind));
            yield* gone(accountId, initial.subscription.subscriptionId);
            yield* verifySource(initial.resource);
            yield* stack.destroy();
            if (kind === "model")
              yield* ai.getModelSchema({ accountId, model: "@cf/baai/bge-m3" });
          }).pipe(
            Effect.scoped,
            Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
          ),
        {
          tags: [
            "provider:cloudflare:ai",
            "provider:cloudflare:images",
            "provider:cloudflare:r2",
            "provider:cloudflare:vectorize",
            "provider:cloudflare:worker",
          ],
          timeout: 120_000,
          exclusive: true,
        },
      );
    }

    test.provider(
      "cross-stack and cross-stage namespace ref does not own the source",
      (stack) => {
        const host = TestCore.scratchStack(
          { providers: Cloudflare.providers(), stage: `${stack.stage}-host` },
          "SubscriptionRefHost",
          "test/Cloudflare/Queue/SubscriptionSources.test.ts",
        );
        return Effect.gen(function* () {
          yield* stack.destroy();
          yield* host.destroy();
          const source = yield* host.deploy(Cloudflare.KV.Namespace("Source"));
          const program = Effect.gen(function* () {
            const queue = yield* Cloudflare.Queues.Queue("Queue");
            return yield* Cloudflare.Queues.Subscription("Events", {
              source: yield* refSource("kv", {
                stack: host.name,
                stage: host.stage,
              }),
              events: ["namespace.created"],
              queueId: queue.queueId,
            });
          });
          const subscription = yield* stack.deploy(program);
          expect(subscription.source).toEqual({ type: "kv" });
          const plan = yield* stack.plan(program);
          expect(
            Object.values(plan.resources).some(
              (node) => node.resource.Type === "Cloudflare.KV.Namespace",
            ),
          ).toBe(false);
          yield* stack.destroy();
          yield* verifySource(source);
          yield* host.destroy();
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
          ),
        );
      },
      {
        tags: [
          "provider:cloudflare:ai",
          "provider:cloudflare:images",
          "provider:cloudflare:r2",
          "provider:cloudflare:vectorize",
          "provider:cloudflare:worker",
        ],
        timeout: 120_000,
        exclusive: true,
      },
    );

    test.provider(
      "a source reference from another account is rejected before subscription creation",
      (stack) => {
        const host = TestCore.scratchStack(
          { providers: Cloudflare.providers(), stage: `${stack.stage}-host` },
          "SubscriptionAccountHost",
          "test/Cloudflare/Queue/SubscriptionSources.test.ts",
        );
        return Effect.gen(function* () {
          yield* stack.destroy();
          yield* host.destroy();
          const environment = yield* yield* CloudflareEnvironment;
          const hosted = yield* host.deploy(
            Effect.gen(function* () {
              const source = yield* Cloudflare.KV.Namespace("Source");
              const queue = yield* Cloudflare.Queues.Queue("Queue");
              return { source, queue };
            }),
          );
          const rejecting = TestCore.scratchStack(
            {
              providers: Layer.mergeAll(
                Cloudflare.providers(),
                Layer.succeed(
                  CloudflareEnvironment,
                  Effect.succeed({
                    ...environment,
                    accountId: "00000000000000000000000000000000",
                  }),
                ),
              ),
              stage: stack.stage,
            },
            "SubscriptionAccountMismatch",
            "test/Cloudflare/Queue/SubscriptionSources.test.ts",
          );
          const cleanup = TestCore.scratchStack(
            { providers: Cloudflare.providers(), stage: stack.stage },
            "SubscriptionAccountMismatch",
            "test/Cloudflare/Queue/SubscriptionSources.test.ts",
          );
          yield* cleanup.destroy();
          yield* Effect.addFinalizer(() =>
            cleanup.destroy().pipe(Effect.orDie),
          );
          const mismatch = yield* rejecting
            .deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Queues.Subscription("Events", {
                  source: yield* refSource("kv", {
                    stack: host.name,
                    stage: host.stage,
                  }),
                  events: ["namespace.created"],
                  queueId: hosted.queue.queueId,
                });
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(mismatch)).toBe(true);
          if (Exit.isFailure(mismatch))
            expect(Cause.pretty(mismatch.cause)).toContain(
              "SubscriptionSourceAccountMismatch",
            );
          yield* stack.destroy();
          yield* verifySource(hosted.source);
          yield* host.destroy();
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
          ),
        );
      },
      {
        tags: [
          "provider:cloudflare:ai",
          "provider:cloudflare:images",
          "provider:cloudflare:r2",
          "provider:cloudflare:vectorize",
          "provider:cloudflare:worker",
        ],
        timeout: 120_000,
        exclusive: true,
      },
    );

    test.provider(
      "a foreign subscription collision preserves the original destination",
      (stack) => {
        const host = TestCore.scratchStack(
          { providers: Cloudflare.providers(), stage: `${stack.stage}-owner` },
          "SubscriptionOwner",
          "test/Cloudflare/Queue/SubscriptionSources.test.ts",
        );
        return Effect.gen(function* () {
          yield* stack.destroy();
          yield* host.destroy();
          const owner = yield* host.deploy(
            Effect.gen(function* () {
              const queue = yield* Cloudflare.Queues.Queue("Queue");
              const subscription = yield* Cloudflare.Queues.Subscription(
                "OwnedEvents",
                {
                  source: { type: "kv" },
                  events: ["namespace.created"],
                  queueId: queue.queueId,
                },
              );
              return { queue, subscription };
            }),
          );
          const result = yield* stack
            .deploy(
              Effect.gen(function* () {
                const queue = yield* Cloudflare.Queues.Queue("Queue");
                const source = yield* Cloudflare.KV.Namespace("Source");
                return yield* Cloudflare.Queues.Subscription("ForeignEvents", {
                  source,
                  events: ["namespace.created"],
                  queueId: queue.queueId,
                });
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              "SubscriptionAlreadyExists",
            );
          yield* stack.destroy();
          const observed = yield* queues.getSubscription({
            accountId: owner.subscription.accountId,
            subscriptionId: owner.subscription.subscriptionId,
          });
          expect(observed.destination.queueId).toBe(owner.queue.queueId);
          expect(observed.name).toBe(owner.subscription.name);
          yield* host.destroy();
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.andThen(host.destroy()), Effect.orDie),
          ),
        );
      },
      { timeout: 120_000, exclusive: true },
    );
  },
);

describe(
  "subscription cleanup",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:queue", "local"],
  },
  () => {
    unitTest.effect("returns successful cleanup results", () =>
      Effect.gen(function* () {
        const cleanup = makeSubscriptionCleanup();
        expect(yield* cleanup(Effect.succeed(42))).toBe(42);
      }),
    );

    unitTest.effect("preserves cleanup failures", () =>
      Effect.gen(function* () {
        const cleanup = makeSubscriptionCleanup();
        const result = yield* cleanup(
          Effect.fail(new Error("delete failed")),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("delete failed");
      }),
    );

    unitTest.effect("bounds a stalled release inside scope finalization", () =>
      Effect.gen(function* () {
        const cleanup = makeSubscriptionCleanup();
        const fiber = yield* Effect.acquireRelease(Effect.void, () =>
          cleanup(Effect.never),
        ).pipe(
          Effect.scoped,
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(fiber);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("TimeoutError");
      }),
    );

    unitTest.effect(
      "shares one deadline across releases and stops starting work when exhausted",
      () =>
        Effect.gen(function* () {
          const cleanup = makeSubscriptionCleanup();
          yield* cleanup(Effect.void);
          yield* TestClock.adjust("19 seconds");
          const fiber = yield* cleanup(Effect.never).pipe(
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* TestClock.adjust("1 second");
          expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
          let started = false;
          const result = yield* cleanup(
            Effect.sync(() => {
              started = true;
            }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect(started).toBe(false);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              "Subscription cleanup deadline exceeded",
            );
        }),
    );
  },
);

const expected = {
  source: "vectorize" as const,
  type: "index.created",
  accountId: "account",
  subscriptionId: "subscription",
  identity: "vectorize-subscription-0-event",
};
const event: SubscriptionEvent = {
  type: "cf.vectorize.index.created",
  source: { type: "vectorize" },
  metadata: {
    accountId: "account",
    eventSubscriptionId: "subscription",
    eventTimestamp: "2026-09-20T00:00:00Z",
  },
  payload: { name: expected.identity },
};

describe(
  "subscription event identity",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:queue", "local"],
  },
  () => {
    unitTest(
      "an early event from the current subscription does not establish settled routing",
      () => {
        expect(
          hasReadySubscriptionEvent(
            [event],
            [{ identity: expected.identity, createdAt: 49_000 }],
            {
              ...expected,
              readyAfter: 60_000,
            },
          ),
        ).toBe(false);
      },
    );

    unitTest(
      "an early probe delivered later cannot substitute for a fresh probe",
      () => {
        expect(
          hasReadySubscriptionEvent(
            [event],
            [
              { identity: expected.identity, createdAt: 49_000 },
              { identity: "fresh-probe", createdAt: 61_000 },
            ],
            { ...expected, readyAfter: 60_000 },
          ),
        ).toBe(false);
      },
    );

    unitTest(
      "a fresh matching probe establishes readiness after the propagation interval",
      () => {
        expect(
          hasReadySubscriptionEvent(
            [event],
            [{ identity: expected.identity, createdAt: 61_000 }],
            {
              ...expected,
              readyAfter: 60_000,
            },
          ),
        ).toBe(true);
      },
    );

    unitTest("matches the exact Vectorize event envelope", () => {
      const decoded = Schema.decodeUnknownSync(SubscriptionEvent)(
        JSON.stringify(event),
      );
      expect(matchesSubscriptionEvent(decoded, expected)).toBe(true);
    });

    unitTest(
      "an index name containing the subscription id does not prove subscription identity",
      () => {
        expect(
          matchesSubscriptionEvent(
            {
              ...event,
              metadata: { ...event.metadata, eventSubscriptionId: "other" },
            },
            expected,
          ),
        ).toBe(false);
      },
    );

    unitTest("a readiness probe cannot satisfy a distinct final index", () => {
      expect(
        matchesSubscriptionEvent(event, {
          ...expected,
          identity: "final-index",
        }),
      ).toBe(false);
    });

    unitTest("matches the whole resource name, not a substring", () => {
      expect(
        matchesSubscriptionEvent(
          {
            ...event,
            payload: { name: `${expected.identity}-other` },
          },
          expected,
        ),
      ).toBe(false);
    });

    unitTest(
      "rejects another account even when its name contains the expected account",
      () => {
        expect(
          matchesSubscriptionEvent(
            {
              ...event,
              metadata: { ...event.metadata, accountId: "other" },
              payload: { name: expected.identity, id: expected.accountId },
            },
            expected,
          ),
        ).toBe(false);
      },
    );

    unitTest("requires the exact event type and product source", () => {
      expect(
        matchesSubscriptionEvent(
          { ...event, type: `${event.type}.other` },
          expected,
        ),
      ).toBe(false);
      expect(
        matchesSubscriptionEvent(
          { ...event, source: { type: "r2" } },
          expected,
        ),
      ).toBe(false);
    });

    unitTest(
      "matches an Images upload by exact payload id and subscription",
      () => {
        const image = {
          ...event,
          type: "cf.images.image.uploaded",
          source: { type: "images" },
          payload: { id: "subscription-final" },
        };
        const target = {
          ...expected,
          source: "images" as const,
          type: "image.uploaded",
          identity: "subscription-final",
        };
        expect(matchesSubscriptionEvent(image, target)).toBe(true);
        expect(
          matchesSubscriptionEvent(
            { ...image, payload: { id: "subscription-probe-0" } },
            target,
          ),
        ).toBe(false);
        expect(
          matchesSubscriptionEvent(
            {
              ...image,
              metadata: {
                ...image.metadata,
                eventSubscriptionId: "old-subscription",
              },
            },
            target,
          ),
        ).toBe(false);
        expect(
          matchesSubscriptionEvent(
            { ...image, payload: { name: target.identity } },
            target,
          ),
        ).toBe(false);
      },
    );

    unitTest(
      "matches KV ids and R2 names in their documented payload fields",
      () => {
        expect(
          matchesSubscriptionEvent(
            {
              ...event,
              type: "cf.kv.namespace.created",
              source: { type: "kv" },
              payload: { id: "namespace-id", name: "namespace-name" },
            },
            {
              ...expected,
              source: "kv",
              type: "namespace.created",
              identity: "namespace-id",
            },
          ),
        ).toBe(true);
        expect(
          matchesSubscriptionEvent(
            {
              ...event,
              type: "cf.r2.bucket.created",
              source: { type: "r2" },
              payload: { name: "bucket-name" },
            },
            {
              ...expected,
              source: "r2",
              type: "bucket.created",
              identity: "bucket-name",
            },
          ),
        ).toBe(true);
      },
    );
  },
);

// Native routing experiments are opt-in; control-plane reads are not delivery barriers.
for (const change of ["replacement", "update", "paused-update"] as const) {
  const enabled =
    process.env[
      {
        replacement: "CLOUDFLARE_TEST_VECTORIZE_IMMEDIATE_REPLACEMENT",
        update: "CLOUDFLARE_TEST_VECTORIZE_IMMEDIATE_UPDATE",
        "paused-update": "CLOUDFLARE_TEST_VECTORIZE_PAUSED_UPDATE",
      }[change]
    ] === "1";
  test.provider.skipIf(!enabled)(
    `Vectorize immediately routes post-${change} events to the current subscription`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;
        const start = yield* Clock.currentTimeMillis;
        const cleanup = makeSubscriptionCleanup();
        const makeQueue = (suffix: string) =>
          Effect.gen(function* () {
            const queue = yield* Effect.acquireRelease(
              queues.createQueue({
                accountId,
                queueName: `alchemy-vectorize-replacement-${suffix}`,
              }),
              (queue) =>
                queues
                  .deleteQueue({ accountId, queueId: queue.queueId! })
                  .pipe(cleanup),
            );
            yield* queues.createConsumer({
              accountId,
              queueId: queue.queueId!,
              type: "http_pull",
            });
            return queue.queueId!;
          });
        const a = yield* makeQueue("a");
        const b = yield* makeQueue("b");
        const makeSubscription = (queueId: string) =>
          Effect.acquireRelease(
            queues.createSubscription({
              accountId,
              name: `native-${queueId}`,
              source: { type: "vectorize" },
              events: ["index.created"],
              enabled: true,
              destination: { type: "queues.queue", queueId },
            }),
            (subscription) =>
              queues
                .deleteSubscription({
                  accountId,
                  subscriptionId: subscription.id,
                })
                .pipe(
                  Effect.catchTag("SubscriptionNotFound", () => Effect.void),
                  cleanup,
                ),
          );
        const create = (name: string) =>
          Effect.gen(function* () {
            const index = yield* Effect.acquireRelease(
              vectorize.createIndex({
                accountId,
                name,
                config: { dimensions: 32, metric: "cosine" },
              }),
              () =>
                vectorize
                  .deleteIndex({ accountId, indexName: name })
                  .pipe(cleanup),
            );
            yield* Effect.logInfo(`Native ${change} create`, {
              elapsedMs: (yield* Clock.currentTimeMillis) - start,
              index,
            });
            return name;
          });
        const received: { queueId: string; event: SubscriptionEvent }[] = [];
        const pull = (queueId: string) =>
          Effect.gen(function* () {
            const batch = yield* queues
              .pullMessage({
                accountId,
                queueId,
                batchSize: 100,
                visibilityTimeoutMs: 30_000,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "QueueHttpPullNotEnabled",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                }),
              );
            for (const message of batch.messages ?? []) {
              if (message.body) {
                const event = yield* Schema.decodeUnknownEffect(
                  SubscriptionEvent,
                )(message.body);
                expect(event.type).toBe("cf.vectorize.index.created");
                expect(event.source.type).toBe("vectorize");
                expect(event.metadata.accountId).toBe(accountId);
                received.push({ queueId, event });
                yield* Effect.logInfo(`Native ${change} receipt`, {
                  elapsedMs: (yield* Clock.currentTimeMillis) - start,
                  queueId,
                  messageId: message.id,
                  timestampMs: message.timestampMs,
                  attempts: message.attempts,
                  rawBody: message.body,
                  event,
                });
              }
            }
            const acks = (batch.messages ?? []).flatMap(({ leaseId }) =>
              leaseId ? [{ leaseId }] : [],
            );
            if (acks.length) {
              const ack = yield* queues.ackMessage({
                accountId,
                queueId,
                acks,
              });
              expect(ack.ackCount).toBe(acks.length);
              expect(Object.keys(ack.warnings ?? {})).toHaveLength(0);
            }
          });
        const old = yield* makeSubscription(a);
        yield* pull(b);
        const initialProbes: string[] = [];
        const initiallyReady = () =>
          received.some(
            ({ queueId, event }) =>
              queueId === a &&
              event.metadata.eventSubscriptionId === old.id &&
              initialProbes.includes(event.payload.name!),
          );
        yield* Effect.gen(function* () {
          initialProbes.push(yield* create(`vec-${a}-${initialProbes.length}`));
          yield* pull(a);
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("7 seconds"),
            times: 8,
            until: initiallyReady,
          }),
        );
        expect(initiallyReady()).toBe(true);
        const observe = Effect.fn(function* (
          subscriptionId: string,
          phase: string,
        ) {
          const observed = yield* queues.getSubscription({
            accountId,
            subscriptionId,
          });
          yield* Effect.logInfo(`Native ${change} configuration`, {
            phase,
            elapsedMs: (yield* Clock.currentTimeMillis) - start,
            subscription: observed,
          });
          return observed;
        });
        const current = yield* Effect.gen(function* () {
          if (change === "paused-update") {
            yield* queues.patchSubscription({
              accountId,
              subscriptionId: old.id,
              enabled: false,
            });
            const paused = yield* observe(old.id, "disabled");
            expect(paused.enabled).toBe(false);
            expect(paused.destination.queueId).toBe(a);
            yield* create(`vec-${a}-disabled`);
            yield* pull(a);
            yield* pull(b);
            yield* queues.patchSubscription({
              accountId,
              subscriptionId: old.id,
              destination: { type: "queues.queue", queueId: b },
            });
            const moved = yield* observe(
              old.id,
              "destination-updated-while-disabled",
            );
            expect(moved.enabled).toBe(false);
            expect(moved.destination.queueId).toBe(b);
            const resumed = yield* queues.patchSubscription({
              accountId,
              subscriptionId: old.id,
              enabled: true,
            });
            expect(resumed.id).toBe(old.id);
            return resumed;
          }
          if (change === "update") {
            const updated = yield* queues.patchSubscription({
              accountId,
              subscriptionId: old.id,
              destination: { type: "queues.queue", queueId: b },
            });
            expect(updated.id).toBe(old.id);
            return updated;
          }
          yield* queues.deleteSubscription({
            accountId,
            subscriptionId: old.id,
          });
          yield* queues
            .getSubscription({ accountId, subscriptionId: old.id })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(new Error("Deleted subscription still exists")),
              ),
              Effect.catchTag("SubscriptionNotFound", () => Effect.void),
            );
          return yield* makeSubscription(b);
        });
        const observed = yield* observe(
          current.id,
          "active-at-new-destination",
        );
        expect(observed.destination.queueId).toBe(b);
        expect(observed.enabled).toBe(true);
        yield* Effect.logInfo(`Native ${change} identities`, {
          oldSubscription: old.id,
          oldQueue: a,
          newSubscription: current.id,
          newQueue: b,
          elapsedMs: (yield* Clock.currentTimeMillis) - start,
        });
        const identities = yield* Effect.forEach([0, 1, 2], (i) =>
          create(`vec-${b}-after-${change}-${i}`),
        );
        yield* Effect.gen(function* () {
          yield* pull(a);
          yield* pull(b);
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 5,
          }),
        );
        const deliveries = received.filter(({ event }) =>
          identities.includes(event.payload.name!),
        );
        yield* Effect.logInfo(`Native ${change} result`, {
          identities,
          deliveries,
        });
        expect(deliveries.filter(({ queueId }) => queueId === a)).toEqual([]);
        for (const identity of identities) {
          expect(
            deliveries.some(
              ({ queueId, event }) =>
                queueId === b &&
                event.metadata.eventSubscriptionId === current.id &&
                event.payload.name === identity,
            ),
          ).toBe(true);
        }
        yield* stack.destroy();
      }).pipe(
        Effect.timeout("90 seconds"),
        Effect.scoped,
        Effect.ensuring(
          stack
            .destroy()
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.orDie,
              Effect.interruptible,
            ),
        ),
      ),
    {
      tags: [
        "provider:cloudflare",
        "provider:cloudflare:queue",
        "provider:cloudflare:vectorize",
        "live",
      ],
      timeout: 120_000,
      exclusive: true,
    },
  );
}
