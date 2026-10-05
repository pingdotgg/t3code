import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * Memorystore instance create + delete runs well past 5 minutes, so the
 * instance (and every binding on it) is only declared with
 * `GCP_TEST_SLOW=1`. The flag is forwarded to the host's environment so the
 * deployed runtime binds the same set.
 */
export const slow = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

/** AUTH-enabled instance: data-plane bindings fetch the AUTH string. */
export const Cache = GCP.Redis.Instance("Cache", {
  location: "us-central1",
  tier: "BASIC",
  memorySizeGb: 1,
  authEnabled: true,
});

export const Acl = GCP.Redis.AclPolicy("Acl", {
  location: "us-central1",
  rules: [{ username: "reader", rule: "on ~cache:* +get" }],
});

export const WRITTEN_KEY = "bindings:written";
export const WRITTEN_VALUE = "from-write-redis";

const instanceProbes = Effect.gen(function* () {
  const getInstance = yield* GCP.Redis.GetInstance(Cache);
  const getAuthString = yield* GCP.Redis.GetAuthString(Cache);
  const read = yield* GCP.Redis.ReadRedis(Cache);
  const write = yield* GCP.Redis.WriteRedis(Cache);
  const readWrite = yield* GCP.Redis.ReadWriteRedis(Cache);
  return {
    getInstance: getInstance(),
    getAuthString: getAuthString(),
    writeRedis: Effect.gen(function* () {
      yield* write.set(WRITTEN_KEY, WRITTEN_VALUE);
      return { incremented: yield* write.incr("bindings:counter") };
    }),
    readRedis: Effect.gen(function* () {
      return {
        value: yield* read.get(WRITTEN_KEY),
        exists: yield* read.exists(WRITTEN_KEY),
        pong: yield* read.ping(),
      };
    }),
    readWriteRedis: Effect.gen(function* () {
      yield* readWrite.set("bindings:roundtrip", "rw");
      const value = yield* readWrite.get("bindings:roundtrip");
      const deleted = yield* readWrite.del("bindings:roundtrip");
      return { value, deleted };
    }),
  };
});

/**
 * Effect-native Cloud Run service exercising every Memorystore for Redis
 * binding as its own runtime service account. It joins the `default` VPC
 * (Direct VPC egress) to reach the instance's private IP. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class RedisBindingsHost extends GCP.Function<RedisBindingsHost>()(
  "RedisBindingsHost",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
    env: { GCP_TEST_SLOW: slow ? "1" : "" },
    template: {
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{ network: "default", subnetwork: "default" }],
      },
    },
  },
  Effect.gen(function* () {
    const getAclPolicy = yield* GCP.Redis.GetAclPolicy(Acl);
    const instance = slow ? yield* instanceProbes : {};

    return {
      fetch: serveProbes({
        getAclPolicy: getAclPolicy(),
        ...instance,
      }),
    };
  }).pipe(
    Effect.provide(GCP.Redis.GetAclPolicyHttp),
    Effect.provide(GCP.Redis.GetInstanceHttp),
    Effect.provide(GCP.Redis.GetAuthStringHttp),
    Effect.provide(GCP.Redis.ReadRedisHttp),
    Effect.provide(GCP.Redis.WriteRedisHttp),
    Effect.provide(GCP.Redis.ReadWriteRedisHttp),
  ),
) {}
