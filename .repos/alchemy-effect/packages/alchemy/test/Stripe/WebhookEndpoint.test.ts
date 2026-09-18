import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetWebhookEndpoint } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const TEST_URL = "https://example.com/alchemy-stripe-webhook";
const UPDATED_URL = "https://example.com/alchemy-stripe-webhook/updated";

const waitUntilGone = (id: string) =>
  GetWebhookEndpoint({ webhook_endpoint: id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const expectSecret = (secret: Redacted.Redacted<string> | undefined) => {
  expect(secret).toBeDefined();
  expect(Redacted.isRedacted(secret)).toEqual(true);
  expect(Redacted.value(secret!).length).toBeGreaterThan(0);
};

test.provider(
  "create, update, and delete a webhook endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.WebhookEndpoint("ChargesWebhook", {
            url: TEST_URL,
            enabledEvents: ["charge.succeeded"],
            description: "Alchemy charge webhook",
            metadata: { purpose: "charges" },
          });
        }),
      );

      expect(created.id).toMatch(/^we_/);
      expect(created.url).toEqual(TEST_URL);
      expect(created.enabledEvents).toEqual(["charge.succeeded"]);
      expect(created.description).toEqual("Alchemy charge webhook");
      expect(created.status).toEqual("enabled");
      expect(created.connect).toEqual(false);
      expect(created.metadata).toMatchObject({ purpose: "charges" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);
      expectSecret(created.secret);

      const fetched = yield* GetWebhookEndpoint({
        webhook_endpoint: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.url).toEqual(TEST_URL);
      expect(fetched.enabled_events).toEqual(["charge.succeeded"]);
      expect(fetched.description).toEqual("Alchemy charge webhook");
      expect(fetched.status).toEqual("enabled");
      expect(fetched.metadata?.purpose).toEqual("charges");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.WebhookEndpoint("ChargesWebhook", {
            url: UPDATED_URL,
            enabledEvents: ["charge.succeeded", "charge.failed"],
            description: "Alchemy charge webhook updated",
            disabled: true,
            metadata: { purpose: "charges", env: "test" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.url).toEqual(UPDATED_URL);
      expect(updated.enabledEvents).toEqual([
        "charge.succeeded",
        "charge.failed",
      ]);
      expect(updated.description).toEqual("Alchemy charge webhook updated");
      expect(updated.status).toEqual("disabled");
      expect(updated.metadata).toEqual({ purpose: "charges", env: "test" });
      expectSecret(updated.secret);

      const refetched = yield* GetWebhookEndpoint({
        webhook_endpoint: updated.id,
      });
      expect(refetched.url).toEqual(UPDATED_URL);
      expect(refetched.enabled_events).toEqual([
        "charge.succeeded",
        "charge.failed",
      ]);
      expect(refetched.description).toEqual("Alchemy charge webhook updated");
      expect(refetched.status).toEqual("disabled");
      expect(refetched.metadata?.purpose).toEqual("charges");
      expect(refetched.metadata?.env).toEqual("test");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed webhook endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.WebhookEndpoint("ListWebhook", {
            url: TEST_URL,
            enabledEvents: ["charge.succeeded"],
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.WebhookEndpoint);
      const all = yield* provider.list();
      const found = all.find((endpoint) => endpoint.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.url).toEqual(TEST_URL);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
