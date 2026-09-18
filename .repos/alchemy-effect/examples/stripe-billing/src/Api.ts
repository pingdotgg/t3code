import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * What the app knows about a customer's subscription. Written by the
 * webhook handler, read by `GET /subscription/:customerId`. This is the
 * record your app checks to decide whether to serve paid features —
 * never call Stripe on the request path for that.
 */
interface Entitlement {
  customerId: string;
  status: "active" | "past_due" | "canceled";
  priceId: string | null;
  subscriptionId: string | null;
  updatedAt: number;
}

/**
 * A SaaS billing Worker.
 *
 * The catalog (`Product`, `Price`, `Coupon`) is declared on the Worker
 * and deployed with it. At runtime the Worker:
 *
 * - `POST /checkout` — creates a Stripe Customer and a Checkout Session
 *   for the Pro plan, and returns the hosted payment URL.
 * - `POST /portal` — opens the Billing Portal so the customer can change
 *   card, switch plan, or cancel without your app building those screens.
 * - `GET /subscription/:customerId` — returns the entitlement your app
 *   should gate features on.
 *
 * Stripe reports what happened via webhooks; `consumeEvents` provisions
 * the endpoint and the handler keeps the entitlement in KV up to date.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Catalog — lives with the Worker that sells it.
    const product = yield* Stripe.Product("Pro", {
      name: "Pro",
      description: "Billed monthly",
    });
    const price = yield* Stripe.Price("ProMonthly", {
      product,
      currency: "usd",
      unitAmount: 2000,
      recurring: { interval: "month" },
    });
    yield* Stripe.Coupon("Launch20", {
      percentOff: 20,
      duration: "once",
      name: "Launch 20%",
    });

    // What customers can do for themselves in the hosted portal.
    const portalConfig = yield* Stripe.BillingPortalConfiguration("Portal", {
      name: "Pro customer portal",
      features: {
        invoiceHistory: { enabled: true },
        paymentMethodUpdate: { enabled: true },
        customerUpdate: { enabled: true, allowedUpdates: ["email"] },
        subscriptionCancel: { enabled: true, mode: "at_period_end" },
      },
    });

    // `price.id` / `portalConfig.id` are plan-time Outputs. Yielding them
    // here returns accessors the request handlers can yield at runtime.
    const priceId = yield* price.id;
    const portalConfigId = yield* portalConfig.id;

    // Runtime bindings — each one injects the account key onto the Worker
    // and calls Stripe over HTTP from a request handler.
    const createCustomer = yield* Stripe.CreateCustomer();
    const createCheckout = yield* Stripe.CreateCheckoutSession();
    const createPortal = yield* Stripe.CreateBillingPortalSession();

    // Entitlement store.
    const entitlements = yield* Cloudflare.KV.Namespace("Entitlements");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(entitlements);

    // Stripe → app. Every subscription state change lands here.
    yield* Stripe.consumeEvents(
      "Events",
      {
        events: [
          Stripe.CheckoutSessionCompleted,
          Stripe.CustomerSubscriptionCreated,
          Stripe.CustomerSubscriptionUpdated,
          Stripe.CustomerSubscriptionDeleted,
          Stripe.InvoicePaymentFailed,
        ],
      },
      Effect.fn(function* (event) {
        const write = (entitlement: Entitlement) =>
          kv
            .put(entitlement.customerId, JSON.stringify(entitlement))
            .pipe(Effect.orDie);

        switch (event.type) {
          case "checkout.session.completed": {
            // The buyer paid. Grant access now; the subscription events
            // that follow keep it accurate.
            const session = event.object;
            const customerId = idOf(session.customer);
            if (customerId === null) return;
            yield* write({
              customerId,
              status: "active",
              priceId: yield* priceId,
              subscriptionId: idOf(session.subscription),
              updatedAt: Date.now(),
            });
            return;
          }
          case "customer.subscription.created":
          case "customer.subscription.updated": {
            const subscription = event.object;
            yield* write({
              customerId: idOf(subscription.customer)!,
              status:
                subscription.status === "active" ||
                subscription.status === "trialing"
                  ? "active"
                  : subscription.status === "past_due"
                    ? "past_due"
                    : "canceled",
              priceId: subscription.items.data[0]?.price.id ?? null,
              subscriptionId: subscription.id,
              updatedAt: Date.now(),
            });
            return;
          }
          case "customer.subscription.deleted": {
            const subscription = event.object;
            yield* write({
              customerId: idOf(subscription.customer)!,
              status: "canceled",
              priceId: null,
              subscriptionId: subscription.id,
              updatedAt: Date.now(),
            });
            return;
          }
          case "invoice.payment_failed": {
            // Card declined on renewal. Stripe will retry; mark the account
            // so the UI can nudge the customer to the portal.
            const invoice = event.object;
            const customerId = idOf(invoice.customer);
            if (customerId === null) return;
            const current = yield* kv
              .get<Entitlement>(customerId, "json")
              .pipe(Effect.orDie);
            yield* write({
              customerId,
              status: "past_due",
              priceId: current?.priceId ?? null,
              subscriptionId: current?.subscriptionId ?? null,
              updatedAt: Date.now(),
            });
            return;
          }
        }
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        // Start a subscription. Creates the Customer up front so the
        // webhook events carry a stable id you can key on.
        if (request.method === "POST" && url.pathname === "/checkout") {
          const body = (yield* request.json) as { email?: string };
          if (!body.email) {
            return yield* HttpServerResponse.json(
              { error: "email is required" },
              { status: 400 },
            );
          }

          const customer = yield* createCustomer({ email: body.email }).pipe(
            Effect.orDie,
          );
          const session = yield* createCheckout({
            mode: "subscription",
            customer: customer.id,
            line_items: [{ price: yield* priceId, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${url.origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${url.origin}/pricing`,
          }).pipe(Effect.orDie);

          return yield* HttpServerResponse.json(
            { customerId: customer.id, checkoutUrl: session.url },
            { status: 201 },
          );
        }

        // Self-serve management: update card, switch plan, cancel.
        if (request.method === "POST" && url.pathname === "/portal") {
          const body = (yield* request.json) as { customerId?: string };
          if (!body.customerId) {
            return yield* HttpServerResponse.json(
              { error: "customerId is required" },
              { status: 400 },
            );
          }
          const session = yield* createPortal({
            customer: body.customerId,
            configuration: yield* portalConfigId,
            return_url: `${url.origin}/account`,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ portalUrl: session.url });
        }

        // What the rest of the app gates on.
        if (
          request.method === "GET" &&
          url.pathname.startsWith("/subscription/")
        ) {
          const customerId = url.pathname.slice("/subscription/".length);
          const entitlement = yield* kv
            .get<Entitlement>(customerId, "json")
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            entitlement ?? { customerId, status: "none" },
          );
        }

        if (url.pathname === "/welcome" || url.pathname === "/pricing") {
          return HttpServerResponse.text(
            url.pathname === "/welcome"
              ? "Thanks — your subscription is active."
              : "Pricing page.",
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Stripe.CreateCustomerHttp,
      Stripe.CreateCheckoutSessionHttp,
      Stripe.CreateBillingPortalSessionHttp,
      Stripe.ConsumeEventsLive,
    ]),
  ),
) {}

/**
 * Stripe returns related objects either as an id string or, when expanded,
 * as the full object. Normalise to the id.
 */
const idOf = (
  ref: string | { id: string } | { id?: string } | null | undefined,
): string | null =>
  ref == null ? null : typeof ref === "string" ? ref : (ref.id ?? null);
