import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

const script = `export default { fetch() { return new Response("ok"); } };`;

/**
 * Deploy-time binding validation rejects a script upload whose bindings
 * reference a resource that doesn't exist. The Durable Object
 * cross-script binding is the one deterministic engine-level trigger:
 * `scriptName` is a plain string, so a stack can name a script that was
 * never deployed. (Every other binding type can only reference a
 * resource declared in the stack, and its reconciler heals a missing
 * target before the Worker deploys — those hit not-found only via
 * propagation races, which `putWorkerScript`'s bounded retry rides
 * out.)
 *
 * The deploy must fail with the resource-specific typed error after the
 * bounded retry exhausts — not an UnknownCloudflareError, and not a
 * success.
 */
test.provider(
  "durable object binding to a script that doesn't exist surfaces the typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("do-consumer-worker", {
              script,
              env: {
                Counter: Cloudflare.DurableObject("Counter", {
                  scriptName: "alchemy-test-nonexistent-do-host",
                }),
              },
            });
          }),
        )
        .pipe(Effect.flip);

      expect(error._tag).toEqual("DurableObjectClassNotFound");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
