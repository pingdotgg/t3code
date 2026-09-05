import type { ReadSecretClient } from "@/Cloudflare/SecretsStore/ReadSecret.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared route that drives every shape of the {@link ReadSecretClient} so both
 * invocation-style fixtures (effect-worker via `ReadSecret`, async-worker via
 * the `env` async binding) exercise the same client surface over `fetch`:
 *
 * - `yield* client` — the client is itself an `Effect` resolving to the value
 * - `client.get()` — the explicit callable
 * - `client.raw` — the underlying `SecretsStoreSecret` binding
 *
 * Returns `undefined` for unmatched paths so the worker shell can 404.
 */
export const secretRoutes = (client: ReadSecretClient, url: URL) =>
  Effect.gen(function* () {
    if (url.pathname === "/secret") {
      // The client is an Effect that resolves to the redacted value.
      const direct = yield* client.pipe(Effect.orDie);
      const viaGet = yield* client.get().pipe(Effect.orDie);
      const raw = yield* client.raw.pipe(Effect.orDie);
      const viaRaw = yield* Effect.promise(() => raw.get());
      return yield* HttpServerResponse.json({
        value: Redacted.value(direct),
        viaGet: Redacted.value(viaGet),
        viaRaw,
      });
    }
    return undefined;
  });
