import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as images from "@distilled.cloud/cloudflare/images";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  makeSubscriptionCleanup,
  matchesSubscriptionEvent,
  SubscriptionEvent,
} from "../Queue/SubscriptionSources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
const canUpload = process.env.CLOUDFLARE_TEST_IMAGES_UPLOAD === "1";

test.provider.skipIf(canUpload)(
  "image uploads expose the typed entitlement rejection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const cleanup = makeSubscriptionCleanup();
      const error = yield* Effect.acquireRelease(
        images.createV1({
          accountId,
          id: "alchemy-subscription-entitlement-probe",
          url: "https://developers.cloudflare.com/og-docs.png",
        }),
        (image) =>
          image.id
            ? images.deleteV1({ accountId, imageId: image.id }).pipe(cleanup)
            : Effect.void,
      ).pipe(Effect.scoped, Effect.flip);
      expect(error).toMatchObject({
        _tag: "ImagesAccessNotEnabled",
        code: 5403,
      });
      yield* stack.destroy();
    }).pipe(
      Effect.ensuring(
        stack
          .destroy()
          .pipe(
            Effect.timeout("15 seconds"),
            Effect.orDie,
            Effect.interruptible,
          ),
      ),
    ),
  { tags: ["provider:cloudflare", "provider:cloudflare:images", "live"] },
);

// Uploads require Images entitlement; the testing account returns ImagesAccessNotEnabled (5403).
test.provider.skipIf(!canUpload)(
  "an Images variant reference receives an account-wide upload event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const cleanup = makeSubscriptionCleanup();
      const variant = Cloudflare.Images.Variant("Variant", {
        name: "alchemySubscriptionUpload",
        fit: "contain",
        width: 100,
        height: 100,
      });
      yield* stack.deploy(variant);
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* variant;
          const queue = yield* Cloudflare.Queues.Queue("ImageEvents");
          const subscription = yield* Cloudflare.Queues.Subscription(
            "Uploads",
            {
              source: yield* Cloudflare.Images.Variant.ref("Variant"),
              events: ["image.uploaded"],
              queueId: queue.queueId,
            },
          );
          return { source, queue, subscription };
        }),
      );
      yield* queues.createConsumer({
        accountId,
        queueId: deployed.queue.queueId,
        type: "http_pull",
      });
      yield* Effect.gen(function* () {
        const upload = (suffix: string) =>
          Effect.acquireRelease(
            images.createV1({
              accountId,
              id: `${deployed.subscription.subscriptionId}-${suffix}`,
              url: "https://developers.cloudflare.com/og-docs.png",
            }),
            (image) =>
              image.id
                ? images.deleteV1({ accountId, imageId: image.id }).pipe(
                    Effect.catchTag("ImageNotFound", () => Effect.void),
                    cleanup,
                  )
                : Effect.void,
          ).pipe(
            Effect.flatMap((image) =>
              image.id
                ? Effect.succeed(image.id)
                : Effect.fail(new Error("Image upload returned no identity")),
            ),
          );
        const events: SubscriptionEvent[] = [];
        const delivered = (imageId: string) =>
          events.some((event) =>
            matchesSubscriptionEvent(event, {
              source: "images",
              type: "image.uploaded",
              accountId,
              subscriptionId: deployed.subscription.subscriptionId,
              identity: imageId,
            }),
          );
        const pull = Effect.gen(function* () {
          const pulled = yield* queues
            .pullMessage({
              accountId,
              queueId: deployed.queue.queueId,
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
          const decoded = yield* Effect.forEach(
            pulled.messages ?? [],
            ({ body }) => Schema.decodeUnknownEffect(SubscriptionEvent)(body),
          );
          events.push(...decoded);
          if (decoded.length)
            yield* Effect.logInfo("Image subscription receipts", decoded);
          const acks = (pulled.messages ?? []).flatMap(({ leaseId }) =>
            leaseId ? [{ leaseId }] : [],
          );
          if (acks.length) {
            const result = yield* queues.ackMessage({
              accountId,
              queueId: deployed.queue.queueId,
              acks,
            });
            expect(result.ackCount).toBe(acks.length);
            expect(Object.keys(result.warnings ?? {})).toHaveLength(0);
          }
        });
        yield* pull;
        const probes: string[] = [];
        const ready = () => probes.some(delivered);
        yield* Effect.gen(function* () {
          probes.push(yield* upload(`probe-${probes.length}`));
          yield* pull;
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            times: 8,
            until: ready,
          }),
        );
        expect(ready()).toBe(true);
        // A readiness probe must not satisfy the final upload assertion.
        const imageId = yield* upload("final");
        expect(probes).not.toContain(imageId);
        yield* pull.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            times: 8,
            until: () => delivered(imageId),
          }),
        );
        expect(delivered(imageId)).toBe(true);
      }).pipe(Effect.timeout("60 seconds"), Effect.scoped);
      yield* stack.deploy(variant);
      yield* images.getV1Variant({
        accountId,
        variantId: deployed.source.variantName,
      });
      yield* stack.destroy();
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        stack
          .destroy()
          .pipe(
            Effect.timeout("15 seconds"),
            Effect.orDie,
            Effect.interruptible,
          ),
      ),
    ),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:images",
      "provider:cloudflare:queue",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);
