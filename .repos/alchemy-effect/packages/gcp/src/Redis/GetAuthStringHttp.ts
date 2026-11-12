import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Layer from "effect/Layer";
import { makeRedisInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAuthString } from "./GetAuthString.ts";

/**
 * HTTP implementation of {@link GetAuthString}.
 *
 * @layer
 * @provides GCP.Redis.GetAuthString
 */
export const GetAuthStringHttp = Layer.effect(
  GetAuthString,
  makeRedisInstanceHttpBinding({
    tag: "GCP.Redis.GetAuthString",
    operation: redis.getAuthStringProjectsLocationsInstances,
    // `redis.instances.getAuthString` is only in the admin role; the IAM
    // Condition limits it to the bound instance.
    iam: { role: "roles/redis.admin", scopeByCondition: true },
  }),
);
