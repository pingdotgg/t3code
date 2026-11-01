import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";
import { MAX_DELIVERY_ATTEMPTS } from "../src/Email.ts";
import { emailObjectFor, type OrderEvent } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The services are built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-pubsub-fanout", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  /** `projects/{p}/datasets/{d}/tables/{t}` → its parts. */
  const tableRefOf = (tableName: string) => {
    const [, projectId, , datasetId, , tableId] = tableName.split("/");
    return { projectId: projectId!, datasetId: datasetId!, tableId: tableId! };
  };

  /** The push subscriptions the two consumers' event sources created. */
  // Pub/Sub reads are eventually consistent: a just-created subscription can
  // briefly read as missing, so re-list until every listed one resolves.
  const subscriptionsOf = (topic: string) =>
    pubsub.listProjectsTopicsSubscriptions({ topic }).pipe(
      Effect.map((page) => page.subscriptions ?? []),
      Effect.flatMap((names) =>
        Effect.forEach(names, (subscription) =>
          pubsub.getProjectsSubscriptions({ subscription }),
        ),
      ),
      Effect.retry({
        while: (error) => error._tag === "NotFound",
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
      Effect.provide(GcpHttp),
    );

  const placeOrder = (baseUrl: string, email: string, total: number) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/orders`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ email, total }),
        ),
      );
      expect(res.status).toBe(202);
      return (yield* res.json) as { orderId: string; eventId: string };
    });

  const cancelOrder = (baseUrl: string, orderId: string, email: string) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/orders/${orderId}/cancel`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ email }),
        ),
      );
      expect(res.status).toBe(202);
      return (yield* res.json) as { orderId: string; eventId: string };
    });

  /** The outbox object for an event, or `undefined` while it is missing. */
  const emailFor = (bucket: string, eventId: string) =>
    storage.getObjects({ bucket, object: emailObjectFor(eventId) }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.provide(GcpHttp),
    );

  /** Poll until the email consumer has written the event's confirmation. */
  const awaitEmail = (bucket: string, eventId: string) =>
    emailFor(bucket, eventId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (object) => object !== undefined,
        times: 60,
      }),
    );

  interface AnalyticsRow {
    eventId: string;
    type: string;
    orderId: string;
  }

  /** Rows the analytics consumer recorded for these events. */
  const analyticsRowsFor = (tableName: string, eventIds: string[]) =>
    Effect.gen(function* () {
      const { projectId, datasetId, tableId } = tableRefOf(tableName);
      const result = yield* bigquery.queryJobs({
        projectId,
        body: {
          query: `SELECT eventId, type, orderId FROM \`${datasetId}.${tableId}\` WHERE eventId IN UNNEST(@ids)`,
          useLegacySql: false,
          parameterMode: "NAMED",
          queryParameters: [
            {
              name: "ids",
              parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
              parameterValue: {
                arrayValues: eventIds.map((value) => ({ value })),
              },
            },
          ],
          timeoutMs: 20_000,
        },
      });
      return (result.rows ?? []).map((row): AnalyticsRow => ({
        eventId: String(row.f?.[0]?.v),
        type: String(row.f?.[1]?.v),
        orderId: String(row.f?.[2]?.v),
      }));
    }).pipe(Effect.provide(GcpHttp));

  /** Poll until every event has a row (streaming inserts are queryable at once). */
  const awaitAnalytics = (tableName: string, eventIds: string[]) =>
    analyticsRowsFor(tableName, eventIds).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (rows) =>
          eventIds.every((id) => rows.some((row) => row.eventId === id)),
        times: 60,
      }),
    );

  test(
    "each consumer gets its own push subscription on the one topic",
    Effect.gen(function* () {
      const {
        topicName,
        deadLetterTopicName,
        deadLetterSubscription,
        project,
      } = yield* stack;

      const subscriptions = yield* subscriptionsOf(topicName);
      expect(subscriptions.length).toBe(2);
      for (const subscription of subscriptions) {
        expect(subscription.pushConfig?.pushEndpoint).toMatch(
          /^https:\/\/.+\/__alchemy\/pubsub\/orderevents$/,
        );
        expect(subscription.pushConfig?.oidcToken?.serviceAccountEmail).toMatch(
          /@.+\.iam\.gserviceaccount\.com$/,
        );
      }

      const filtered = subscriptions.filter((s) => s.filter);
      expect(filtered.length).toBe(1);
      const email = filtered[0]!;
      expect(email.filter).toBe('attributes.type = "order.created"');
      expect(email.deadLetterPolicy).toEqual({
        deadLetterTopic: deadLetterTopicName,
        maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
      });
      // Backoff keeps the attempts from being spent on a transient failure.
      expect(email.retryPolicy).toEqual({
        minimumBackoff: "10s",
        maximumBackoff: "600s",
      });

      const analytics = subscriptions.find((s) => !s.filter)!;
      expect(analytics.deadLetterPolicy).toBeUndefined();

      // Dead letters are forwarded by the project's Pub/Sub service agent,
      // which needs to publish to the dead-letter topic and ack the source.
      const topicPolicy = yield* pubsub
        .getIamPolicyProjectsTopics({ resource: deadLetterTopicName })
        .pipe(Effect.provide(GcpHttp));
      const agent = (topicPolicy.bindings ?? [])
        .find((binding) => binding.role === "roles/pubsub.publisher")
        ?.members?.find((member) => member.includes("@gcp-sa-pubsub."));
      expect(agent).toBeDefined();
      const subscriptionPolicy = yield* pubsub
        .getIamPolicyProjectsSubscriptions({ resource: email.name! })
        .pipe(Effect.provide(GcpHttp));
      expect(
        (subscriptionPolicy.bindings ?? []).some(
          (binding) =>
            binding.role === "roles/pubsub.subscriber" &&
            binding.members?.includes(agent!),
        ),
      ).toBe(true);

      expect(deadLetterSubscription).toStartWith(`projects/${project}/`);
    }),
    { timeout: 120_000 },
  );

  test(
    "rejects an order without an email or total",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      for (const body of [{ total: 10 }, { email: "a@example.com" }]) {
        const res = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/orders`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        );
        expect(res.status).toBe(400);
      }
    }),
    { timeout: 120_000 },
  );

  test(
    "every order.created reaches both the email and the analytics consumer",
    Effect.gen(function* () {
      const { url, bucketName, tableName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const orders = [];
      for (const [i, total] of [12.5, 99, 7.25].entries()) {
        orders.push(yield* placeOrder(baseUrl, `buyer${i}@example.com`, total));
      }

      // A fresh deploy's first pushes can wait on IAM propagation for a few
      // minutes; Pub/Sub retries them until they land.
      for (const [i, order] of orders.entries()) {
        const email = yield* awaitEmail(bucketName, order.eventId);
        expect(email).toBeDefined();
        expect(email!.metadata).toEqual({
          orderId: order.orderId,
          to: `buyer${i}@example.com`,
        });
      }

      const rows = yield* awaitAnalytics(
        tableName,
        orders.map((order) => order.eventId),
      );
      for (const order of orders) {
        expect(rows).toContainEqual({
          eventId: order.eventId,
          type: "order.created" satisfies OrderEvent["type"],
          orderId: order.orderId,
        });
      }
    }),
    { timeout: 900_000 },
  );

  test(
    "order.cancelled only reaches analytics",
    Effect.gen(function* () {
      const { url, bucketName, tableName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const created = yield* placeOrder(baseUrl, "changed@example.com", 40);
      const cancelled = yield* cancelOrder(
        baseUrl,
        created.orderId,
        "changed@example.com",
      );

      const rows = yield* awaitAnalytics(tableName, [
        created.eventId,
        cancelled.eventId,
      ]);
      expect(rows).toContainEqual({
        eventId: cancelled.eventId,
        type: "order.cancelled",
        orderId: created.orderId,
      });

      // The confirmation for the created event lands; the cancellation is
      // filtered out by Pub/Sub before it is ever pushed to the email service.
      expect(yield* awaitEmail(bucketName, created.eventId)).toBeDefined();
      expect(yield* emailFor(bucketName, cancelled.eventId)).toBeUndefined();
    }),
    { timeout: 900_000 },
  );

  test(
    "an email that can never be sent is dead-lettered after max attempts",
    Effect.gen(function* () {
      const { url, bucketName, tableName, deadLetterSubscription } =
        yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const order = yield* placeOrder(baseUrl, "nobody@example.invalid", 5);

      // Analytics is a separate subscription, so the email failures don't
      // hold it back.
      yield* awaitAnalytics(tableName, [order.eventId]);

      const pullDeadLetters = pubsub
        .pullProjectsSubscriptions({
          subscription: deadLetterSubscription,
          body: { maxMessages: 10, returnImmediately: true },
        })
        .pipe(Effect.provide(GcpHttp));

      const dead: pubsub.ReceivedMessage[] = [];
      yield* pullDeadLetters.pipe(
        Effect.tap(({ receivedMessages = [] }) =>
          Effect.gen(function* () {
            dead.push(...receivedMessages);
            const ackIds = receivedMessages.flatMap((m) =>
              m.ackId ? [m.ackId] : [],
            );
            if (ackIds.length > 0) {
              yield* pubsub
                .acknowledgeProjectsSubscriptions({
                  subscription: deadLetterSubscription,
                  body: { ackIds },
                })
                .pipe(Effect.provide(GcpHttp));
            }
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: () => dead.some((m) => decode(m).eventId === order.eventId),
          times: 48,
        }),
      );

      const letter = dead.find((m) => decode(m).eventId === order.eventId)!;
      expect(letter.message?.attributes?.type).toBe("order.created");
      // Pub/Sub stamps where the dead letter came from.
      expect(
        letter.message?.attributes?.CloudPubSubDeadLetterSourceSubscription,
      ).toBeDefined();

      expect(yield* emailFor(bucketName, order.eventId)).toBeUndefined();
    }),
    { timeout: 900_000 },
  );

  const decode = (received: pubsub.ReceivedMessage) =>
    JSON.parse(
      Buffer.from(received.message?.data ?? "e30=", "base64").toString("utf8"),
    ) as OrderEvent;

  /** Poll until a deleted resource reads as `NotFound`. */
  const expectGone = <E, R>(
    what: string,
    status: Effect.Effect<"found" | "gone", E, R>,
  ) =>
    status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
      Effect.tap((status) =>
        Effect.sync(() => expect(`${what}: ${status}`).toBe(`${what}: gone`)),
      ),
    );

  const statusOf = <A, E extends { _tag: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.as("found" as const),
      Effect.catchIf(
        (error) => error._tag === "NotFound",
        () => Effect.succeed("gone" as const),
      ),
      Effect.provide(GcpHttp),
    );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      const subscriptions =
        outputs === undefined
          ? []
          : (yield* subscriptionsOf(outputs.topicName)).map((s) => s.name!);

      yield* destroy(Stack);
      if (outputs === undefined) return;

      for (const [what, name] of [
        ["email service", outputs.emailService],
        ["analytics service", outputs.analyticsService],
      ] as const) {
        yield* expectGone(
          what,
          statusOf(run.getProjectsLocationsServices({ name })),
        );
      }
      for (const subscription of [
        ...subscriptions,
        outputs.deadLetterSubscription,
      ]) {
        yield* expectGone(
          subscription,
          statusOf(pubsub.getProjectsSubscriptions({ subscription })),
        );
      }
      for (const topic of [outputs.topicName, outputs.deadLetterTopicName]) {
        yield* expectGone(topic, statusOf(pubsub.getProjectsTopics({ topic })));
      }
      yield* expectGone(
        "bucket",
        statusOf(storage.getBuckets({ bucket: outputs.bucketName })),
      );
      const { projectId, datasetId } = tableRefOf(outputs.tableName);
      yield* expectGone(
        "dataset",
        statusOf(bigquery.getDatasets({ projectId, datasetId })),
      );
    }),
    { timeout: 600_000 },
  );
});
