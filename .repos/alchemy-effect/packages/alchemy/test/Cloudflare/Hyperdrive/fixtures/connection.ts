import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Effect from "effect/Effect";

/**
 * Shared Neon Postgres origin + Hyperdrive Connection bound by both
 * binding-test workers (effect-worker via `Cloudflare.Hyperdrive.Connect`
 * and async-worker via `env: { HD: Connection }`). Because both workers
 * bind this same Connection, the metadata they read back over `fetch`
 * (host / port / user / database / connection string) must agree with the
 * Neon origin that fronts it.
 */
export const HyperdriveConnection = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveBindingProject");
  const connection = yield* Cloudflare.Hyperdrive.Connection(
    "HyperdriveBindingConnection",
    {
      origin: project.origin,
    },
  );
  return { project, connection };
});
