import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Test from "alchemy/Test/Bun";
import {
  CreatePaymentMethod,
  CreatePaymentMethodAttach,
  CreateSubscription,
  DeleteCustomer,
  DeleteSubscription,
  GetCheckoutSession,
  GetWebhookEndpoints,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band distilled calls resolve the same stored Stripe key the deploy
// uses, so the test runs against the configured profile without needing
// STRIPE_API_KEY in the environment.
const StripeHttp = Layer.mergeAll(
  Stripe.StripeAuth,
  Stripe.fromAuthProvider(),
  FetchHttpClient.layer,
);

interface Entitlement {
  customerId: string;
  status: "active" | "past_due" | "canceled" | "none";
  priceId: string | null;
  subscriptionId: string | null;
}

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

const readEntitlement = (baseUrl: string, customerId: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.get(`${baseUrl}/subscription/${customerId}`),
    );
    return (yield* res.json) as unknown as Entitlement;
  });

// Webhook delivery is asynchronous; poll until the entitlement reaches the
// expected status.
const waitForStatus = (
  baseUrl: string,
  customerId: string,
  status: Entitlement["status"],
) =>
  readEntitlement(baseUrl, customerId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (e) => e.status === status,
      times: 24,
    }),
  );

test(
  "deploys a worker URL and provisions the webhook endpoint",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
    const delivery = `${url.replace(/\/+$/, "")}/webhooks/stripe`;
    const endpoints = yield* GetWebhookEndpoints({ limit: 100 }).pipe(
      Effect.provide(StripeHttp),
    );
    const endpoint = endpoints.data.find(
      (e) => e.url.replace(/\/+$/, "") === delivery,
    );
    expect(endpoint).toBeDefined();
    expect(endpoint?.enabled_events).toEqual(
      expect.arrayContaining([
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.payment_failed",
      ]),
    );
  }),
);

test(
  "POST /checkout creates a customer and a hosted Checkout Session for the Pro price",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    yield* getWhenReady(`${baseUrl}/pricing`);

    const res = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/checkout`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          email: "stripe-billing-checkout@example.com",
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (yield* res.json) as {
      customerId: string;
      checkoutUrl: string;
    };
    expect(body.customerId).toMatch(/^cus_/);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    // The session is a real subscription-mode Checkout for the deployed
    // Price, bound to the customer the Worker just created.
    const sessionId = new URL(body.checkoutUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1)!;
    const session = yield* GetCheckoutSession({ session: sessionId }).pipe(
      Effect.provide(StripeHttp),
    );
    expect(session.mode).toEqual("subscription");
    expect(session.status).toEqual("open");
    expect(session.customer).toEqual(body.customerId);

    // Nothing paid yet → no entitlement.
    const before = yield* readEntitlement(baseUrl, body.customerId);
    expect(before.status).toEqual("none");

    yield* DeleteCustomer({ customer: body.customerId }).pipe(
      Effect.catch(() => Effect.void),
      Effect.provide(StripeHttp),
    );
  }),
  { timeout: 120_000 },
);

test(
  "subscription lifecycle webhooks keep the entitlement current",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    yield* getWhenReady(`${baseUrl}/pricing`);

    // Start from the Worker so the customer exists in the app's flow.
    const checkout = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/checkout`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          email: "stripe-billing-lifecycle@example.com",
        }),
      ),
    );
    const { customerId, checkoutUrl } = (yield* checkout.json) as {
      customerId: string;
      checkoutUrl: string;
    };

    // Hosted Checkout needs a browser. Stand in for the buyer by attaching
    // Stripe's `tok_visa` test card and creating the same subscription
    // directly — this fires the real `customer.subscription.*` webhooks the
    // Worker consumes.
    const sessionId = new URL(checkoutUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1)!;
    const session = yield* GetCheckoutSession({
      session: sessionId,
      expand: ["line_items"],
    }).pipe(Effect.provide(StripeHttp));
    const priceId = session.line_items?.data[0]?.price?.id;
    expect(priceId).toMatch(/^price_/);

    const paymentMethod = yield* CreatePaymentMethod({
      type: "card",
      card: { token: "tok_visa" },
    }).pipe(Effect.provide(StripeHttp));
    yield* CreatePaymentMethodAttach({
      payment_method: paymentMethod.id,
      customer: customerId,
    }).pipe(Effect.provide(StripeHttp));
    const subscription = yield* CreateSubscription({
      customer: customerId,
      items: [{ price: priceId! }],
      default_payment_method: paymentMethod.id,
      payment_behavior: "error_if_incomplete",
    }).pipe(Effect.provide(StripeHttp));
    expect(subscription.status).toEqual("active");

    const active = yield* waitForStatus(baseUrl, customerId, "active");
    expect(active.subscriptionId).toEqual(subscription.id);
    expect(active.priceId).toEqual(priceId!);

    yield* DeleteSubscription({
      subscription_exposed_id: subscription.id,
    }).pipe(Effect.provide(StripeHttp));

    const canceled = yield* waitForStatus(baseUrl, customerId, "canceled");
    expect(canceled.subscriptionId).toEqual(subscription.id);

    yield* DeleteCustomer({ customer: customerId }).pipe(
      Effect.catch(() => Effect.void),
      Effect.provide(StripeHttp),
    );
  }),
  { timeout: 300_000 },
);

test(
  "POST /portal opens the Billing Portal for a customer",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    yield* getWhenReady(`${baseUrl}/pricing`);

    const checkout = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/checkout`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          email: "stripe-billing-portal@example.com",
        }),
      ),
    );
    const { customerId } = (yield* checkout.json) as { customerId: string };

    const res = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/portal`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ customerId }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { portalUrl: string };
    expect(body.portalUrl).toMatch(/^https:\/\/billing\.stripe\.com\//);

    yield* DeleteCustomer({ customer: customerId }).pipe(
      Effect.catch(() => Effect.void),
      Effect.provide(StripeHttp),
    );
  }),
  { timeout: 120_000 },
);
