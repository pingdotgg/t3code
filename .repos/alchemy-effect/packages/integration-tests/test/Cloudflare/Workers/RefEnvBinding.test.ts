import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Alchemy";
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
            workersDev: true,
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
  {
    tags: ["provider:cloudflare", "provider:cloudflare:kv", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

const targetScript = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Api extends WorkerEntrypoint {
  async greet(name) {
    return "hello " + name + " from ref target";
  }
}
export default {
  async fetch() {
    return new Response("ref target up");
  },
};`;

const callerScript = `export default {
  async fetch(request, env) {
    try {
      return new Response(await env.API.greet("alice"));
    } catch (err) {
      return new Response("caller failed: " + err.message, { status: 500 });
    }
  },
};`;

/**
 * `Cloudflare.WorkerEntrypoint(Worker.ref(...), "Api")` must target the
 * referenced Worker. A ref is a callable Output proxy, so it used to fail
 * the "is this a Worker?" check and silently lower to a self binding on
 * the caller (#2262) — the caller has no `Api`, so the greeting proves
 * the binding reached the ref'd target.
 */
test.provider(
  "a Worker ref in WorkerEntrypoint targets the referenced worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const target = () =>
        Cloudflare.Worker("ref-entrypoint-target", {
          script: targetScript,
        });

      yield* stack.deploy(target());

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const deployedTarget = yield* target();
          const caller = yield* Cloudflare.Worker("ref-entrypoint-caller", {
            script: callerScript,
            workersDev: true,
            env: {
              API: Cloudflare.WorkerEntrypoint(
                yield* Cloudflare.Worker.ref("ref-entrypoint-target"),
                "Api",
              ),
            },
          });
          return { target: deployedTarget, caller };
        }),
      );

      yield* expectUrlContains(deployed.caller.url!, "hello alice from ref target", {
        label: "ref-bound entrypoint caller",
      });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

/**
 * `Cloudflare.Worker.ref(Declaration)` references the Worker by the
 * declaration's logical id (#2607). The caller stack only refs the target,
 * so the greeting proves the ref resolved to the deployed target.
 */
test.provider(
  "a Worker ref taken from a declaration targets the declared worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const Target = Cloudflare.Worker("ref-declaration-target", {
        script: targetScript,
      });

      yield* stack.deploy(Target);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* Target;
          const caller = yield* Cloudflare.Worker("ref-declaration-caller", {
            script: callerScript,
            workersDev: true,
            env: {
              API: Cloudflare.WorkerEntrypoint(yield* Cloudflare.Worker.ref(Target), "Api"),
            },
          });
          return { target, caller };
        }),
      );

      yield* expectUrlContains(deployed.caller.url!, "hello alice from ref target", {
        label: "declaration-ref-bound entrypoint caller",
      });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);
