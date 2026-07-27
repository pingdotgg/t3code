import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Effect from "effect/Effect";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const script = `export default {
  async fetch(request, env) {
    await env.KV.put("ref-binding-key", "bound-through-ref");
    const value = await env.KV.get("ref-binding-key");
    return new Response(value ?? "missing");
  },
};`;

/**
 * A `Resource.ref(...)` in a Worker's `env` must produce the native
 * binding, exactly like a locally-declared resource. A ref used to
 * silently degrade to a plain JSON env var: the worker deployed
 * "successfully" and `env.KV.put` blew up at runtime — so the live KV
 * roundtrip through the deployed worker is the airtight assertion.
 */
test.provider(
  "a KV namespace ref in worker env produces a working native binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: the target must already be in state for the ref to
      // resolve (a ghost ref fails the plan).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.KV.Namespace("RefNamespace");
        }),
      );

      // Phase 2: bind the namespace via `Namespace.ref(...)` and prove
      // the binding works end-to-end.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.KV.Namespace("RefNamespace");
          const worker = yield* Cloudflare.Worker("ref-binding-worker", {
            script,
            subdomain: { enabled: true },
            env: {
              KV: yield* Cloudflare.KV.Namespace.ref("RefNamespace"),
            },
          });
          return { namespace, worker };
        }),
      );

      yield* expectUrlContains(deployed.worker.url!, "bound-through-ref", {
        label: "ref-bound KV worker",
      });

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
