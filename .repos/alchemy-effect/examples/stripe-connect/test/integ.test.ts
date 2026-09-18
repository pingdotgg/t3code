import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Test from "alchemy/Test/Bun";
import {
  DeleteAccount,
  GetAccountByAccount,
  GetWebhookEndpoints,
  UpdateAccount,
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

// Out-of-band verification resolves the same stored Stripe key the deploy
// uses.
const StripeHttp = Layer.mergeAll(
  Stripe.StripeAuth,
  Stripe.fromAuthProvider(),
  FetchHttpClient.layer,
);

interface MerchantView {
  id: string;
  email: string;
  onboarded: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  updatedAt: number;
}

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

const readMerchant = (base: string, id: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.get(`${base}/merchants/${id}`),
    );
    expect(res.status).toBe(200);
    return (yield* res.json) as unknown as MerchantView;
  });

test(
  "deploys a worker URL and provisions the account.updated webhook",
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
    expect(endpoint?.enabled_events).toContain("account.updated");
  }),
);

// Connect must be enabled on the test account. Skipped otherwise.
test.skipIf(process.env.STRIPE_TEST_CONNECT !== "1")(
  "onboards a merchant, resumes onboarding, and records account.updated",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    yield* getWhenReady(base);

    // 1. Sign up.
    const signup = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/merchants`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ email: "merchant@example.com" }),
      ),
    );
    expect(signup.status).toBe(201);
    const { merchantId, onboardingUrl } = (yield* signup.json) as {
      merchantId: string;
      onboardingUrl: string;
    };
    expect(merchantId).toMatch(/^acct_/);
    expect(onboardingUrl).toMatch(/^https:\/\/connect\.stripe\.com\//);

    const account = yield* GetAccountByAccount({ account: merchantId }).pipe(
      Effect.provide(StripeHttp),
    );
    expect(account.type).toEqual("express");
    expect(account.details_submitted).toBe(false);

    // The row exists and the merchant is not live yet.
    const fresh = yield* readMerchant(base, merchantId);
    expect(fresh.email).toEqual("merchant@example.com");
    expect(fresh.onboarded).toBe(false);
    expect(fresh.chargesEnabled).toBe(false);

    // 2. Links are single-use; the platform can always mint another.
    const resume = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/merchants/${merchantId}/onboarding`),
    );
    expect(resume.status).toBe(200);
    const resumed = (yield* resume.json) as { onboardingUrl: string };
    expect(resumed.onboardingUrl).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(resumed.onboardingUrl).not.toEqual(onboardingUrl);

    // Unknown merchants get a 404, not a Stripe error.
    const unknown = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/merchants/acct_doesnotexist/onboarding`),
    );
    expect(unknown.status).toBe(404);

    // 3. Any change to the account fires account.updated; the handler
    //    copies the capability flags into D1 and bumps updated_at. Nudging
    //    metadata is enough to trigger it without completing the full
    //    onboarding form. Wait a beat so the bump is distinguishable from
    //    the row's creation second.
    yield* Effect.sleep("2 seconds");
    yield* UpdateAccount({
      account: merchantId,
      metadata: { touched: String(Date.now()) },
    }).pipe(Effect.provide(StripeHttp));

    const observed = yield* readMerchant(base, merchantId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (m) => m.updatedAt > fresh.updatedAt,
        times: 24,
      }),
    );
    expect(observed.id).toEqual(merchantId);
    expect(observed.onboarded).toBe(account.details_submitted ?? false);
    expect(observed.chargesEnabled).toBe(account.charges_enabled ?? false);

    yield* DeleteAccount({ account: merchantId }).pipe(
      Effect.catch(() => Effect.void),
      Effect.provide(StripeHttp),
    );
  }),
  { timeout: 300_000 },
);
