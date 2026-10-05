import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * Memcached instances need Private Service Access on the project's default
 * network (without it create fails with BadRequest "Google private service
 * access is not enabled.") and take ~10 minutes to provision, so
 * `GCP_TEST_PRIVATE_SERVICE_ACCESS=1` + `GCP_TEST_SLOW=1` opt in. The gate
 * is forwarded to the host's environment so the deployed runtime binds the
 * same set.
 */
export const memcacheEnabled =
  !!process.env.GCP_TEST_PRIVATE_SERVICE_ACCESS &&
  !!process.env.GCP_TEST_SLOW &&
  !process.env.FAST;

/** Instance the binding is granted for; declared only when enabled. */
export const Cache = GCP.Memcache.Instance("Cache", {
  location: "us-central1",
});

const instanceProbes = Effect.gen(function* () {
  const getInstance = yield* GCP.Memcache.GetInstance(Cache);
  return { getInstance: getInstance() };
});

/**
 * Effect-native Cloud Run service exercising the Memcache binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class MemcacheBindingsHost extends GCP.Function<MemcacheBindingsHost>()(
  "MemcacheBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: {
      GCP_TEST_PRIVATE_SERVICE_ACCESS: memcacheEnabled ? "1" : "",
      GCP_TEST_SLOW: memcacheEnabled ? "1" : "",
    },
  },
  Effect.gen(function* () {
    const instance = memcacheEnabled ? yield* instanceProbes : {};
    return { fetch: serveProbes({ ...instance }) };
  }).pipe(Effect.provide(GCP.Memcache.GetInstanceHttp)),
) {}
