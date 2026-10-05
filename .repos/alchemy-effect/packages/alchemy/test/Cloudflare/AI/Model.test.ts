import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as Output from "@/Output";
import * as ai from "@distilled.cloud/cloudflare/ai";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "a model handle validates, replaces and preserves catalog models on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const first = yield* stack.deploy(
        Cloudflare.AI.Model("Model", { modelName: "@cf/baai/bge-m3" }),
      );
      expect(first).toEqual({ accountId, modelName: "@cf/baai/bge-m3" });
      const updated = yield* stack.deploy(
        Cloudflare.AI.Model("Model", {
          modelName: "@cf/baai/bge-base-en-v1.5",
        }),
      );
      expect(updated.modelName).toBe("@cf/baai/bge-base-en-v1.5");
      yield* ai.getModelSchema({ accountId, model: first.modelName });
      yield* stack.destroy();
      yield* ai.getModelSchema({ accountId, model: updated.modelName });
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:ai", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "an unresolved model identity replaces its downstream subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (suffix: string) =>
        Effect.gen(function* () {
          const identity = yield* Cloudflare.R2.Bucket("Identity", {
            name: `alchemy-model-subscription-identity-${suffix}`,
          });
          const model = yield* Cloudflare.AI.Model("Model", {
            modelName: identity.bucketName.pipe(
              Output.map((name) =>
                name.endsWith("-a")
                  ? "@cf/baai/bge-m3"
                  : "@cf/baai/bge-base-en-v1.5",
              ),
            ),
          });
          const queue = yield* Cloudflare.Queues.Queue("Queue");
          const subscription = yield* Cloudflare.Queues.Subscription("Events", {
            source: model,
            events: ["batch.queued"],
            queueId: queue.queueId,
          });
          return { model, subscription };
        });
      const initial = yield* stack.deploy(program("a"));
      const replaced = yield* stack.deploy(program("b"));
      expect(replaced.model.modelName).toBe("@cf/baai/bge-base-en-v1.5");
      expect(replaced.subscription.subscriptionId).not.toBe(
        initial.subscription.subscriptionId,
      );
      const observed = yield* queues.getSubscription({
        accountId: replaced.subscription.accountId,
        subscriptionId: replaced.subscription.subscriptionId,
      });
      expect(observed.source).toEqual(
        expect.objectContaining({
          type: "workersAi.model",
          modelName: replaced.model.modelName,
        }),
      );
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:ai",
      "provider:cloudflare:queue",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "a persisted model reference receives a real asynchronous batch event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const model = Cloudflare.AI.Model("Model", {
        modelName: "@cf/baai/bge-m3",
      });
      yield* stack.deploy(model);
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          yield* model;
          const queue = yield* Cloudflare.Queues.Queue("BatchEvents");
          const worker = yield* Cloudflare.Worker("BatchWorker", {
            main: `${import.meta.dirname}/fixtures/model-batch.ts`,
            env: { AI: Cloudflare.Workers.AI() },
          });
          const subscription = yield* Cloudflare.Queues.Subscription(
            "ModelEvents",
            {
              source: yield* Cloudflare.AI.Model.ref("Model"),
              events: ["batch.queued", "batch.succeeded", "batch.failed"],
              queueId: queue.queueId,
            },
          );
          return { queue, worker, subscription };
        }),
      );
      yield* queues.createConsumer({
        accountId,
        queueId: deployed.queue.queueId,
        type: "http_pull",
      });
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      yield* client.get(deployed.worker.url!).pipe(
        Effect.flatMap((response) => response.text),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
      );
      const batch = yield* client.post(deployed.worker.url!).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ request_id: Schema.String }),
          ),
        ),
      );
      const bodies: string[] = [];
      const delivered = () =>
        bodies.some(
          (body) =>
            body.includes("cf.workersAi.model.batch.") &&
            body.includes(batch.request_id) &&
            body.includes(deployed.subscription.subscriptionId) &&
            body.includes(accountId),
        );
      yield* Effect.gen(function* () {
        const pulled = yield* queues
          .pullMessage({
            accountId,
            queueId: deployed.queue.queueId,
            batchSize: 100,
            visibilityTimeoutMs: 1000,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "QueueHttpPullNotEnabled",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
          );
        for (const message of pulled.messages ?? [])
          if (message.body) bodies.push(message.body);
        const acks = (pulled.messages ?? []).flatMap((message) =>
          message.leaseId ? [{ leaseId: message.leaseId }] : [],
        );
        if (acks.length)
          yield* queues.ackMessage({
            accountId,
            queueId: deployed.queue.queueId,
            acks,
          });
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 10,
          until: delivered,
        }),
        Effect.timeout("60 seconds"),
      );
      expect(delivered()).toBe(true);
      yield* stack.deploy(model);
      yield* ai.getModelSchema({ accountId, model: "@cf/baai/bge-m3" });
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:ai",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);
