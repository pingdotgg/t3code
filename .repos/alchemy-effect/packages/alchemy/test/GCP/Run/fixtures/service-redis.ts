import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Effect-native Cloud Run Service that binds Memorystore over Direct VPC
 * egress. Gated by `GCP_TEST_REDIS=1` — instance create takes minutes.
 */
export default class BoundRedisService extends GCP.Function<BoundRedisService>()(
  "BoundRedisService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
    template: {
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{ network: "default", subnetwork: "default" }],
      },
    },
  },
  Effect.gen(function* () {
    const cache = yield* GCP.Redis.Instance("Cache", { memorySizeGb: 1 });
    const redis = yield* GCP.Redis.ReadWriteRedis(cache);

    return {
      fetch: Effect.gen(function* () {
        yield* redis.set("probe", "ok").pipe(Effect.orDie);
        const cached = yield* redis.get("probe").pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ redis: cached });
      }),
    };
  }).pipe(Effect.provide(GCP.Redis.ReadWriteRedisHttp)),
) {}
