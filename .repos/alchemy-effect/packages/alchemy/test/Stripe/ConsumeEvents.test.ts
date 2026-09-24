import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import StripeEventSourceWorker from "./fixtures/event-source-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "StripeEventSourceTestStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* StripeEventSourceWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Real delivery to a fresh workers.dev URL is slow async provisioning
// (edge propagation + Stripe retry backoff + KV eventual consistency,
// ~1-4 min under full-suite load), so it is opt-in. The stripe-billing
// example integ exercises the same end-to-end delivery in its own run.
test.skipIf(process.env.STRIPE_TEST_REAL_DELIVERY !== "1")(
  "consumeEvents records a CustomerCreated delivery",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    yield* getWhenReady(`${base}/last`);

    // Ride out binding cold-start: the Stripe CreateCustomer token may not
    // be visible on the first request after a fresh deploy.
    const created = yield* executeWhenReady(
      HttpClientRequest.post(`${base}/customers`),
    );
    expect(created.status).toBe(201);
    const body = (yield* created.json) as { id: string };
    expect(body.id).toMatch(/^cus_/);

    // Stripe delivers asynchronously to the fresh workers.dev URL and KV
    // reads are eventually consistent, so poll up to ~3 minutes, absorbing
    // transient transport errors during edge propagation.
    const id = yield* Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.get(`${base}/last/${body.id}`),
      );
      if (res.status !== 200) return null;
      const json = (yield* res.json) as { id: string | null };
      return json.id;
    }).pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (value) => value === body.id,
        times: 36,
      }),
    );
    expect(id).toEqual(body.id);
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "invalid Stripe-Signature is rejected",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    yield* getWhenReady(`${base}/last`);
    const res = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/webhooks/stripe`).pipe(
        HttpClientRequest.setHeader("stripe-signature", "t=1,v1=00"),
        HttpClientRequest.bodyText("{}"),
      ),
    );
    expect(res.status).toBe(401);
  }).pipe(logLevel),
  { timeout: 120_000 },
);
