import * as Binding from "@/Binding.ts";
import type { Bucket } from "@/Cloudflare/R2/Bucket.ts";
import type { Resource, ResourceLike } from "@/Resource.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The env var the binding injects into whichever host it is provided on.
 */
export const PROBE_ENV_KEY = "ALCHEMY_TEST_BOUND_ENV";

/**
 * A minimal `Binding.Service` whose entire deploy-time contribution is an
 * environment variable — the shape `Prisma.Connect` uses for a Prisma
 * Compute app, a Lambda Function, and (as of this fixture's coverage) a
 * Cloudflare Container.
 *
 * A container is a real process, so it has no workerd bindings: `env` is the
 * only channel a capability has to reach it. This proves the container
 * provider actually folds the binding contract's `env` into the deployed
 * application's environment variables — it used to declare the contract and
 * silently drop the values.
 */
export interface ProbeEnv extends Binding.Service<
  ProbeEnv,
  "Test.ProbeEnv",
  (
    bucket: Bucket,
  ) => Effect.Effect<Effect.Effect<string | undefined, never, RuntimeContext>>
> {}

export const ProbeEnv = Binding.Service<ProbeEnv>("Test.ProbeEnv");

type EnvBindingHost = Resource<
  string,
  object | undefined,
  object,
  { env?: Record<string, any> }
>;

const acceptsEnvBinding = (
  host: ResourceLike | undefined,
): host is EnvBindingHost => host?.Type === "Cloudflare.Container";

export const ProbeEnvBinding = Layer.effect(
  ProbeEnv,
  Effect.succeed(
    Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (!acceptsEnvBinding(host)) {
          return yield* Effect.die(
            new Error(
              `Test.ProbeEnv expects a Cloudflare.Container host, got '${host?.Type ?? "no host"}'`,
            ),
          );
        }
        // The value is an Output of a sibling resource's attribute, so this
        // also pins that bound env survives Output resolution.
        yield* host.bind`${bucket}`({
          env: { [PROBE_ENV_KEY]: bucket.bucketName },
        });
      }
      return Effect.sync(() => process.env[PROBE_ENV_KEY]);
    }),
  ),
);
