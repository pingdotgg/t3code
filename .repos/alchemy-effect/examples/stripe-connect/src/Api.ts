import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./database.ts";

/**
 * One merchant on the platform. `charges_enabled` is the flag that
 * matters: until Stripe sets it, the merchant cannot take payments and
 * the platform should keep sending them back to onboarding.
 */
interface Merchant {
  id: string;
  email: string;
  details_submitted: number;
  charges_enabled: number;
  payouts_enabled: number;
  created_at: number;
  updated_at: number;
}

/**
 * A Stripe Connect platform Worker.
 *
 * A marketplace or SaaS-for-businesses onboards other companies as
 * connected accounts, and those companies get paid through the platform.
 * The lifecycle is:
 *
 * 1. `POST /merchants` — create an Express account for the merchant,
 *    store the id, and return a hosted onboarding URL.
 * 2. The merchant fills in Stripe's onboarding form. Account Links expire
 *    and merchants abandon them, so `POST /merchants/:id/onboarding`
 *    mints a fresh link at any time.
 * 3. Stripe sends `account.updated` when onboarding finishes.
 *    `consumeEvents` provisions the webhook endpoint; the handler records
 *    `charges_enabled` in D1.
 * 4. `GET /merchants/:id` — the platform reads that row to decide whether
 *    the merchant is live.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const createAccount = yield* Stripe.CreateAccount();
    const createAccountLink = yield* Stripe.CreateAccountLink();

    // Stripe → platform. Fires on every change to any connected account.
    yield* Stripe.consumeEvents(
      "Events",
      { events: [Stripe.AccountUpdated] },
      Effect.fn(function* (event) {
        const account = event.object;
        yield* db
          .prepare(
            `UPDATE merchants
               SET details_submitted = ?, charges_enabled = ?, payouts_enabled = ?, updated_at = unixepoch()
             WHERE id = ?`,
          )
          .bind(
            account.details_submitted ? 1 : 0,
            account.charges_enabled ? 1 : 0,
            account.payouts_enabled ? 1 : 0,
            account.id,
          )
          .run()
          .pipe(Effect.orDie);
      }),
    );

    // Stripe's hosted onboarding needs both URLs: `return_url` is where
    // the merchant lands when done, `refresh_url` is where Stripe sends
    // them if the link expired so the platform can mint a new one.
    const onboardingLink = (merchantId: string, origin: string) =>
      createAccountLink({
        account: merchantId,
        type: "account_onboarding",
        return_url: `${origin}/merchants/${merchantId}/onboarded`,
        refresh_url: `${origin}/merchants/${merchantId}/onboarding/refresh`,
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        // 1. Sign a merchant up.
        if (request.method === "POST" && url.pathname === "/merchants") {
          const body = (yield* request.json) as { email?: string };
          if (!body.email) {
            return yield* HttpServerResponse.json(
              { error: "email is required" },
              { status: 400 },
            );
          }

          const account = yield* createAccount({
            type: "express",
            country: "US",
            email: body.email,
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
          }).pipe(Effect.orDie);

          yield* db
            .prepare("INSERT INTO merchants (id, email) VALUES (?, ?)")
            .bind(account.id, body.email)
            .run()
            .pipe(Effect.orDie);

          const link = yield* onboardingLink(account.id, url.origin).pipe(
            Effect.orDie,
          );

          return yield* HttpServerResponse.json(
            { merchantId: account.id, onboardingUrl: link.url },
            { status: 201 },
          );
        }

        // 2. Resume onboarding — links are single-use and expire.
        if (
          request.method === "POST" &&
          segments.length === 3 &&
          segments[0] === "merchants" &&
          segments[2] === "onboarding"
        ) {
          const merchantId = segments[1];
          const row = yield* db
            .prepare("SELECT id FROM merchants WHERE id = ?")
            .bind(merchantId)
            .first<{ id: string }>()
            .pipe(Effect.orDie);
          if (row === null) {
            return yield* HttpServerResponse.json(
              { error: "Unknown merchant" },
              { status: 404 },
            );
          }
          const link = yield* onboardingLink(merchantId, url.origin).pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({ onboardingUrl: link.url });
        }

        // Where Stripe sends the merchant back.
        if (
          request.method === "GET" &&
          segments.length === 3 &&
          segments[0] === "merchants" &&
          (segments[2] === "onboarded" || segments[2] === "refresh")
        ) {
          return HttpServerResponse.text(
            segments[2] === "onboarded"
              ? "Onboarding complete. You can close this tab."
              : "That onboarding link expired. Request a new one from the platform.",
          );
        }

        // 4. Is this merchant live?
        if (
          request.method === "GET" &&
          segments.length === 2 &&
          segments[0] === "merchants"
        ) {
          const merchant = yield* db
            .prepare("SELECT * FROM merchants WHERE id = ?")
            .bind(segments[1])
            .first<Merchant>()
            .pipe(Effect.orDie);
          if (merchant === null) {
            return yield* HttpServerResponse.json(
              { error: "Unknown merchant" },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json({
            id: merchant.id,
            email: merchant.email,
            onboarded: merchant.details_submitted === 1,
            chargesEnabled: merchant.charges_enabled === 1,
            payoutsEnabled: merchant.payouts_enabled === 1,
            updatedAt: merchant.updated_at,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Stripe.CreateAccountHttp,
      Stripe.CreateAccountLinkHttp,
      Stripe.ConsumeEventsLive,
    ]),
  ),
) {}
