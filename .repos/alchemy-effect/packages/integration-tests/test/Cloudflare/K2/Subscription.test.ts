import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { testName } from "../../names.ts";
import { waitForStreamGone, waitForSubscriptionGone } from "./k2-test-utils.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const program = (startAt: "earliest" | "latest") =>
  Effect.gen(function* () {
    const stream = yield* Cloudflare.K2.Stream("SubscriptionStream");
    const subscription = yield* Cloudflare.K2.Subscription("Analytics", {
      stream,
      startAt,
    });
    return { stream, subscription };
  });

test.provider(
  "create a subscription and replace it when startAt changes",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const first = yield* stack.deploy(program("latest"));
      const streamId = first.stream.streamId;
      expect(first.subscription.streamId).toEqual(streamId);
      expect(first.subscription.startAt).toEqual("latest");

      const observed = yield* k2.getSubscription({
        streamId,
        subscriptionId: first.subscription.subscriptionId,
      });
      expect(observed.name).toEqual(first.subscription.subscriptionName);
      expect(observed.startAt.type).toEqual("latest");

      // A redeploy with the same props is a no-op.
      const same = yield* stack.deploy(program("latest"));
      expect(same.subscription.subscriptionId).toEqual(first.subscription.subscriptionId);

      // startAt is immutable — the subscription is replaced on the same stream.
      const second = yield* stack.deploy(program("earliest"));
      expect(second.stream.streamId).toEqual(streamId);
      expect(second.subscription.startAt).toEqual("earliest");
      expect(second.subscription.subscriptionId).not.toEqual(first.subscription.subscriptionId);
      yield* waitForSubscriptionGone(streamId, first.subscription.subscriptionId);

      const replaced = yield* k2.listSubscriptions({ streamId });
      expect(replaced.map((s) => s.id)).toEqual([second.subscription.subscriptionId]);
      expect(replaced[0]?.startAt.type).toEqual("earliest");

      yield* stack.destroy();
      yield* waitForSubscriptionGone(streamId, second.subscription.subscriptionId);
      yield* waitForStreamGone(accountId, streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);

test.provider(
  "an explicitly named subscription is replaced delete-first",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const named = (startAt: "earliest" | "latest") =>
        Effect.gen(function* () {
          const stream = yield* Cloudflare.K2.Stream("NamedSubscriptionStream");
          const subscription = yield* Cloudflare.K2.Subscription("Named", {
            stream,
            name: testName("alchemy-k2-named"),
            startAt,
          });
          return { stream, subscription };
        });

      const first = yield* stack.deploy(named("latest"));
      expect(first.subscription.subscriptionName).toEqual(testName("alchemy-k2-named"));

      // K2 rejects the same name with different settings, so the engine must
      // delete the old subscription before creating the new one.
      const second = yield* stack.deploy(named("earliest"));
      expect(second.subscription.subscriptionName).toEqual(testName("alchemy-k2-named"));
      expect(second.subscription.startAt).toEqual("earliest");
      const observed = yield* k2.getSubscription({
        streamId: second.stream.streamId,
        subscriptionId: second.subscription.subscriptionId,
      });
      expect(observed.startAt.type).toEqual("earliest");

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, second.stream.streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);
