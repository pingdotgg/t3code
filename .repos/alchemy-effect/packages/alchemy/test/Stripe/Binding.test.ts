import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import StripeBindingWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
});
const { getWhenReady } = Test;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "StripeBindingTestStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* StripeBindingWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker retrieves a bound Stripe product",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* getWhenReady(`${url.replace(/\/+$/, "")}/product`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { id: string; name: string };
    expect(body.id).toMatch(/^prod_/);
    expect(body.name).toEqual("Alchemy Bound Product");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
